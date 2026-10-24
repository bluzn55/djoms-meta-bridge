/* DOC JAKS · Outlaw Radio 5150 verified listener heart votes.
   READ ONLY: use the existing server-side Wix Headless connection.
   Public response contains song titles and aggregate votes, no voter records. */
import {AppError,authorize,endpoint,only,read,unseal} from './core.js';

const COLLECTION='OutlawRadioSongLikes';
const QUERY_URL='https://www.wixapis.com/wix-data/v2/items/query';
const TOKEN_URL='https://www.wixapis.com/oauth2/token';
const LIMIT=1000;
const MAX_PAGES=25;
const TTL=60000;
let savedReport=null;
let validUntil=0;
let pending=null;

const clean=(s,limit=180)=>typeof s==='string'
  ?s.replace(/[\x00-\x1f\x7f]/g,' ').replace(/\s+/g,' ').trim().slice(0,limit):'';

async function queryWix() {
  const record=await read('wix-blog-connection');
  if(!record?.sealed)throw new AppError('Wix website connection is not available for song likes.',503);
  const c=unseal(record.sealed);
  if(!c?.clientId||!c?.clientSecret)throw new AppError('Wix authorization is incomplete.',503);
  const tokenRes=await fetch(TOKEN_URL,{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({grant_type:'client_credentials',client_id:c.clientId,client_secret:c.clientSecret}),
    signal:AbortSignal.timeout(15000)
  });
  const token=await tokenRes.json().catch(()=>null);
  if(!tokenRes.ok||!token?.access_token)throw new AppError('Wix song-like authorization failed.',503);
  const counts=new Map();
  let rowsSeen=0,finished=false;
  for(let page=0;page<MAX_PAGES;page++){
    const response=await fetch(QUERY_URL,{
      method:'POST',
      headers:{Authorization:token.access_token,'Content-Type':'application/json'},
      body:JSON.stringify({
        dataCollectionId:COLLECTION,
        query:{paging:{limit:LIMIT,offset:page*LIMIT}},
        returnTotalCount:true
      }),
      signal:AbortSignal.timeout(18000)
    });
    const result=await response.json().catch(()=>null);
    if(!response.ok||!Array.isArray(result?.dataItems))
      throw new AppError('Wix could not read the verified Outlaw Radio likes.',503);
    for(const item of result.dataItems){
      const data=item?.data;
      if(!data||typeof data!=='object')throw new AppError('Wix returned an incomplete voting record.',503);
      const title=clean(data.songTitle),key=clean(data.trackKey).toLowerCase();
      const artist=clean(data.artist,100);
      if(!title||!key)throw new AppError('A voting record is missing its song title or key.',503);
      const existing=counts.get(key);
      if(existing)existing.likes++;
      else counts.set(key,{key,title,artist,likes:1});
      rowsSeen++;
    }
    if(result.dataItems.length<LIMIT){finished=true;break;}
  }
  if(!finished)throw new AppError('Song-like history exceeds the verified reporting limit.',503);
  const songs=[...counts.values()].sort((a,b)=>b.likes-a.likes||a.title.localeCompare(b.title));
  const best=songs[0]?.likes??0;
  const leaders=songs.filter(s=>s.likes===best&&best>0);
  return {
    status:'reported',
    station:'Outlaw Radio 5150',
    source:'Wix OutlawRadioSongLikes',
    scope:'lifetime',
    checkedAt:new Date().toISOString(),
    totalLikes:rowsSeen,
    songCount:songs.length,
    top:songs[0]??null,
    leaders,
    songs
  };
}

export async function loadSongLikes(force=false){
  if(!force&&savedReport&&Date.now()<validUntil)return savedReport;
  if(!pending){
    pending=queryWix().then(value=>{
      savedReport=value;validUntil=Date.now()+TTL;
      return value;
    }).finally(()=>{pending=null;});
  }
  return pending;
}

export const songLikesEndpoint=endpoint(async(req,res)=>{
  only(req,res,['GET']);
  await authorize(req);
  res.json(await loadSongLikes(req.query?.refresh==='1'));
});

export const publicSongLikesEndpoint=endpoint(async(req,res)=>{
  only(req,res,['GET']);
  // Public listener leaderboard includes no individual vote or user data.
  res.setHeader('Access-Control-Allow-Origin','*');
  res.json(await loadSongLikes());
});
