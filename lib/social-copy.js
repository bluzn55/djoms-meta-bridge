/* DOC JAKS · One clean, uniquely tagged link at the top of each social placecard.
   Publishing-time formatting also corrects already scheduled and approved posts.
   The saved original caption stays unchanged for editing and historical records. */
const ACTION_LABELS = {"BBQ":"🔥 Explore the Smokehouse","SOSS":"🔥 Explore the Smokehouse","MUSIC":"🎵 Hear the music","BOOK":"📖 Discover the story","KREWE":"⚜ Join the Pit Krewe"};
const INLINE_LINK = /(?:https?:\/\/[^\s<>"']+|(?:www\.)?docjaks\.com(?:\/[^\s<>"']*)?)/gi;
const HASHTAG_LINE = /^(?:#[\p{L}\p{N}_]+(?:[\s,]+|$))+$/u;
const CLICK_CTA = /^[^\p{L}\p{N}]*(?:discover|learn|visit|explore|read|listen|shop|see|find|join|order|check|click|support|follow|go|get)\b/i;

export function preparePlacecardCopy(caption){
  const bodyLines=[],hashtags=[];
  const source=String(caption||"").replace(/\r\n?/g,"\n").replace(/\*\*/g,"");
  for(const row of source.split("\n")){
    const original=row.trim();
    if(!original){bodyLines.push("");continue;}
    INLINE_LINK.lastIndex=0;
    const hadLink=INLINE_LINK.test(original);
    INLINE_LINK.lastIndex=0;
    const clean=original.replace(INLINE_LINK,"").replace(/[ \t]{2,}/g," ").trim();
    if(hadLink&&CLICK_CTA.test(clean))continue;
    if(!clean)continue;
    if(HASHTAG_LINE.test(clean)){
      hashtags.push(...(clean.match(/#[\p{L}\p{N}_]+/gu)||[]));
      continue;
    }
    bodyLines.push(clean);
  }
  return {body:bodyLines.join("\n").replace(/\n{3,}/g,"\n\n").trim(),hashtags:[...new Set(hashtags)].join(" ")};
}

export function composePlacecardCaption(record,outgoingLink){
  const copy=preparePlacecardCopy(record?.caption);
  const label=ACTION_LABELS[record?.campaign]||"⚜ Explore Doc Jaks";
  const header=outgoingLink?label+": "+String(outgoingLink).trim():"";
  return [header,copy.body,copy.hashtags].filter(Boolean).join("\n\n").trim();
}

export function composePlacecardXCaption(record,outgoingLink){
  const copy=preparePlacecardCopy(record?.caption||record?.title);
  const label=ACTION_LABELS[record?.campaign]||"⚜ Explore Doc Jaks";
  const header=outgoingLink?label+": "+String(outgoingLink).trim():"";
  if(header.length>280)throw new Error("The campaign tracking link is too long for X.");
  const tags=copy.hashtags.split(/\s+/).filter(Boolean);
  let selected=[];
  for(const tag of tags){
    if(selected.length>=2)break;
    const proposal=[...selected,tag].join(" ");
    if(header.length+2+proposal.length+2+35<=280)selected.push(tag);
  }
  const suffix=selected.join(" ");
  const wholeBody=copy.body.replace(/\s+/g," ").trim()||String(record?.title||"Doc Jaks");
  const fixed=[header,suffix].filter(Boolean).join("\n\n");
  const limit=280-fixed.length-(fixed?2:0);
  let body=wholeBody;
  if(body.length>limit){
    if(limit<=1)body="";
    else{
      const before=body.slice(0,limit-1);
      const space=before.lastIndexOf(" ");
      body=(space>limit*0.55?before.slice(0,space):before).trimEnd()+"…";
    }
  }
  const result=[header,body,suffix].filter(Boolean).join("\n\n");
  if(result.length>280)throw new Error("X post exceeds the 280-character limit.");
  return result;
}
