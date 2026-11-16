/* The promotion group belongs to the saved post, independently of its
   Food/Music/Book campaign, platform, destination, and later page views. */
import {AppError} from './core.js';

const LABELS=Object.freeze({
  olr5150:'OLR5150 social post',
  docjaks:'Other Doc Jaks social post'
});

export function acquisitionGroup(record){
  return Object.hasOwn(LABELS,record?.acquisitionGroup)?record.acquisitionGroup:null;
}

export function acquisitionGroupLabel(value){
  return Object.hasOwn(LABELS,value)?LABELS[value]:'Not classified';
}

export function parseAcquisitionGroup(value){
  if(value===null||value==='')return null;
  if(typeof value==='string'&&Object.hasOwn(LABELS,value))return value;
  throw new AppError('Choose OLR5150 social post, Other Doc Jaks social post, or Not classified.');
}
