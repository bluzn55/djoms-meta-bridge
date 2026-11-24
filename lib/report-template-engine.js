// Form definitions contain labels and arithmetic only, never business records.
import {AppError} from './core.js';
import excise from './report-templates/ttb-excise.json' with {type:'json'};
import production from './report-templates/ttb-production.json' with {type:'json'};
import storage from './report-templates/ttb-storage.json' with {type:'json'};
import processing from './report-templates/ttb-processing.json' with {type:'json'};

export const businessProfiles=Object.freeze([
  {id:'conestoga',name:'Conestoga Distillery',stage:'active'},
  {id:'doc_jaks',name:"Doc Jak's",stage:'setup'},
]);
export const reportTemplates=Object.freeze([excise,production,storage,processing]);
const templates=new Map(reportTemplates.map(template=>[template.id,template]));
const SCALE=1000000n;
const TYPES=new Set(['text','textarea','number','money','date','select']);

for(const template of reportTemplates){
  if(!template.id||!Array.isArray(template.fields)||template.fields.length>1000)
    throw new Error('Invalid report template definition.');
  const ids=new Map();
  for(const field of template.fields){
    if(!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(field.id)||ids.has(field.id)||!TYPES.has(field.type))
      throw new Error('Invalid or duplicate field in '+template.id+'.');
    ids.set(field.id,field);
  }
  const checked=new Set(),active=new Set();
  function visit(field){
    if(checked.has(field.id))return;
    if(active.has(field.id))throw new Error('Circular calculation in '+template.id+'.');
    active.add(field.id);
    if(field.calculation){
      if(!['sum','subtract'].includes(field.calculation.op)||!Array.isArray(field.calculation.refs)||!field.calculation.refs.length)
        throw new Error('Invalid calculation in '+template.id+'.');
      for(const ref of field.calculation.refs){
        if(!ids.has(ref)||!['number','money'].includes(ids.get(ref).type))throw new Error('Unknown numeric calculation field in '+template.id+'.');
        visit(ids.get(ref));
      }
    }
    active.delete(field.id);checked.add(field.id);
  }
  for(const field of template.fields)visit(field);
  for(const check of template.checks||[]){
    if(!Array.isArray(check.leftRefs)||!Array.isArray(check.rightRefs)||!check.leftRefs.length||!check.rightRefs.length||
      [...check.leftRefs,...check.rightRefs].some(ref=>!ids.has(ref)||!['number','money'].includes(ids.get(ref).type)))
      throw new Error('Invalid balance check in '+template.id+'.');
  }
}

export function getReportTemplate(id){return templates.get(id)||null;}
export function templateProfileValues(templateId,incoming,profile){
  if(incoming!=null&&(typeof incoming!=='object'||Array.isArray(incoming)))throw new AppError('Report form values must be a field dictionary.');
  const values={...(incoming||{})};
  const template=getReportTemplate(templateId);
  if(!template||!profile)return values;
  for(const field of template.fields){
    if(!field.profileKey||Object.hasOwn(values,field.id))continue;
    const value=field.profileKey==='nameAddress'
      ?[profile.legalName||profile.displayName,profile.address].filter(Boolean).join('\n')
      :['legalName','displayName','address','ein','plantNumber'].includes(field.profileKey)?profile[field.profileKey]:'';
    if(value)values[field.id]=value;
  }
  return values;
}
export function templatePeriodValues(templateId,incoming,periodStart,periodEnd){
  const values={...(incoming||{})};
  const template=getReportTemplate(templateId);
  if(!template)return values;
  if(!periodStart||!periodEnd){
    for(const field of template.fields)if(field.periodKey)values[field.id]='';
    return values;
  }
  const monthYear=new Intl.DateTimeFormat('en-US',{month:'long',year:'numeric',timeZone:'UTC'}).format(new Date(periodStart+'T12:00:00Z'));
  for(const field of template.fields){
    if(field.periodKey==='monthYear')values[field.id]=monthYear;
    else if(field.periodKey==='periodStart')values[field.id]=periodStart;
    else if(field.periodKey==='periodEnd')values[field.id]=periodEnd;
  }
  return values;
}
export function normalizeBusinessId(value){
  const id=value==null||value===''?'unassigned':value;
  if(typeof id!=='string'||!['conestoga','doc_jaks','unassigned'].includes(id))throw new AppError('Choose Conestoga Distillery or Doc Jak\'s.');
  return id;
}
function numeric(raw,field){
  const places=field.type==='money'?2:field.integer?0:6;
  const expression=new RegExp('^\\d{1,'+(field.type==='money'?9:12)+'}'+(places?'(?:\\.\\d{1,'+places+'})?':'')+'$');
  if(!expression.test(raw))throw new AppError(field.label+' must be a nonnegative '+(places?'number with at most '+places+' decimal places.':'whole number.'));
  const [whole,fraction='']=raw.split('.');
  const clean=whole.replace(/^0+(?=\d)/,'');
  if(field.type==='money')return clean+'.'+fraction.padEnd(2,'0');
  const tail=fraction.replace(/0+$/,'');
  return clean+(tail?'.'+tail:'');
}
function scaled(value){
  const negative=value.startsWith('-');
  const [whole,fraction='']=(negative?value.slice(1):value).split('.');
  const n=BigInt(whole)*SCALE+BigInt(fraction.padEnd(6,'0'));
  return negative?-n:n;
}
function formatted(value,field){
  const sign=value<0n?'-':'';
  const positive=value<0n?-value:value;
  const whole=(positive/SCALE).toString(),fraction=(positive%SCALE).toString().padStart(6,'0');
  if(field.type==='money'){
    if(positive%10000n!==0n)throw new AppError('The calculated '+field.label+' has fractions of a cent. Check its inputs.');
    return sign+whole+'.'+fraction.slice(0,2);
  }
  if(field.integer&&positive%SCALE!==0n)throw new AppError('The calculated '+field.label+' must be a whole number.');
  const tail=fraction.replace(/0+$/,'');
  return sign+whole+(tail?'.'+tail:'');
}
function plain(raw,field){
  if(raw==null)return '';
  const limit=field.type==='textarea'?16000:field.type==='text'?4000:120;
  if(typeof raw!=='string'||raw.length>limit)throw new AppError(field.label+' must be text, no more than '+limit+' characters.');
  const value=raw.trim();
  if(!value)return '';
  if(field.manualOnly)throw new AppError(field.label+' must be completed manually on the official form. It stays unsigned here.');
  if(['number','money'].includes(field.type))return numeric(value,field);
  if(field.type==='select'&&!(field.options||[]).some(option=>option.value===value))throw new AppError('Choose a valid option for '+field.label+'.');
  if(field.type==='date'&&(!/^\d{4}-\d{2}-\d{2}$/.test(value)||value<'1900-01-01'||value>'2200-12-31'||
    !Number.isFinite(Date.parse(value+'T12:00:00Z'))||new Date(value+'T12:00:00Z').toISOString().slice(0,10)!==value))
    throw new AppError('Enter a valid date for '+field.label+'.');
  return value;
}

export function normalizeTemplateData(templateId,rawValues){
  const id=templateId==null?'':templateId;
  if(typeof id!=='string'||(id&&!templates.has(id)))throw new AppError('Choose a supported report form.');
  if(rawValues!=null&&(typeof rawValues!=='object'||Array.isArray(rawValues)))throw new AppError('Report form values must be a field dictionary.');
  const incoming=rawValues||{};
  const template=getReportTemplate(id);
  if(!template){
    if(Object.keys(incoming).length)throw new AppError('Select a report form before entering template values.');
    return {template:null,values:{},checks:[]};
  }
  const definitions=new Map(template.fields.map(field=>[field.id,field]));
  const supplied=Object.keys(incoming);
  if(supplied.length>1000||supplied.some(key=>!definitions.has(key)))throw new AppError('This report includes an unknown form field. Reload the form before saving.');
  const values={};
  for(const field of template.fields)values[field.id]=field.calculation?'':plain(incoming[field.id],field);
  const evaluated=new Set();
  function calculate(field){
    if(evaluated.has(field.id)||!field.calculation)return;
    for(const ref of field.calculation.refs)calculate(definitions.get(ref));
    const refs=field.calculation.refs.map(ref=>values[ref]);
    if(refs.every(value=>value!=='')){
      const numbers=refs.map(scaled);
      const result=field.calculation.op==='sum'?numbers.reduce((sum,n)=>sum+n,0n):numbers.slice(1).reduce((sum,n)=>sum-n,numbers[0]);
      values[field.id]=formatted(result,field);
    }
    evaluated.add(field.id);
  }
  for(const field of template.fields)calculate(field);
  const checks=[];
  for(const field of template.fields.filter(field=>field.calculation)){
    const value=values[field.id];
    checks.push({id:'calculation_'+field.id,label:field.label,status:value===''?'pending':value.startsWith('-')?'fail':'pass',
      message:value===''?'Enter every component, including explicit zeroes, to calculate this total.':value.startsWith('-')?'The calculated total is negative. Check the component values.':'Calculated from the entered components.'});
  }
  for(const check of template.checks||[]){
    const all=[...check.leftRefs,...check.rightRefs];
    if(all.some(ref=>values[ref]==='')){checks.push({id:check.id,label:check.label,status:'pending',message:'Enter both sides to check the balance.'});continue;}
    const left=check.leftRefs.reduce((sum,ref)=>sum+scaled(values[ref]),0n);
    const right=check.rightRefs.reduce((sum,ref)=>sum+scaled(values[ref]),0n);
    checks.push({id:check.id,label:check.label,status:left===right?'pass':'fail',left:formatted(left,{type:'number'}),right:formatted(right,{type:'number'}),
      message:left===right?'The entered totals balance.':'The entered totals do not balance. Check the listed amounts.'});
  }
  return {template,values,checks};
}
export function requireTemplateReady(templateId,values){
  const result=normalizeTemplateData(templateId,values);
  if(!result.template)return result;
  const missing=result.template.fields.find(field=>field.required&&!field.manualOnly&&result.values[field.id]==='');
  if(missing)throw new AppError('Complete the required form field: '+missing.label+'.');
  const failed=result.checks.find(check=>check.status==='fail');
  if(failed)throw new AppError(failed.label+': '+failed.message);
  return result;
}
export function templatePeriodDates(templateId,periodStart,periodEnd){
  const schedule=getReportTemplate(templateId)?.schedule;
  if(!schedule||schedule.type!=='monthly_following'||!periodStart||!periodEnd)return null;
  const year=Number(periodStart.slice(0,4)),month=Number(periodStart.slice(5,7));
  const monthEnd=new Date(Date.UTC(year,month,0)).toISOString().slice(0,10);
  if(periodStart.slice(8)!=='01'||periodEnd!==monthEnd)throw new AppError('Choose a complete calendar month for this operations report.');
  const nextMonth=new Date(Date.UTC(year,month,1)).toISOString().slice(0,7);
  return {frequency:'monthly',targetDate:nextMonth+'-'+String(schedule.targetDay).padStart(2,'0'),
    dueDate:nextMonth+'-'+String(schedule.dueDay).padStart(2,'0')};
}
