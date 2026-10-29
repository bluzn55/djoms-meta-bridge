import test from 'node:test';
import assert from 'node:assert/strict';
import { composePlacecardCaption, composePlacecardXCaption } from '../lib/social-copy.js';
import { postTrackingUrl } from '../lib/post-referrals.js';

const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const story='Some people find a place.\n\nSome people were always meant to.\n\n📖 **THE WOODEN TOKEN**\n\nDiscover her story at **DOCJAKS.COM**\n\n#TheWoodenToken #Delphina\n\nhttps://www.docjaks.com/';
test('Book copy has one tracked link first, clean text and hashtags last',()=>{
  const r={id,campaign:'BOOK',title:'Delphina',caption:story};
  const link=postTrackingUrl(r,'facebook');
  const out=composePlacecardCaption(r,link);
  assert.ok(out.startsWith('📖 Discover the story: '+link));
  assert.equal((out.match(/https:\/\//g)||[]).length,1);
  assert.doesNotMatch(out,/DOCJAKS.COM|\*\*|Discover her story at/);
  assert.ok(out.endsWith('#TheWoodenToken #Delphina'));
  assert.match(out,/Some people were always meant to/);
});
test('Every campaign receives its own correctly tagged CTA',()=>{
  for(const [campaign,label] of [['BBQ','🔥 Explore'],['MUSIC','🎵 Hear'],['BOOK','📖 Discover']]){
    const r={id,campaign,title:'Sample',caption:'See more at DOCJAKS.COM\n\n#DocJaks'};
    for(const platform of ['facebook','instagram']){
      const link=postTrackingUrl(r,platform);
      const out=composePlacecardCaption(r,link);
      assert.ok(out.startsWith(label));
      assert.ok(out.includes(link));
      assert.equal((out.match(/https:\/\//g)||[]).length,1);
      assert.ok(out.endsWith('#DocJaks'));
    }
  }
});
test('X keeps a unique early link and fits 280 characters',()=>{
  const r={id,campaign:'BOOK',title:'Delphina',caption:story};
  const link=postTrackingUrl(r,'x');
  const out=composePlacecardXCaption(r,link);
  assert.ok(out.startsWith('📖 Discover the story: '+link));
  assert.ok(out.length<=280);
  assert.ok(out.includes('#TheWoodenToken'));
  assert.doesNotMatch(out,/\*\*|DOCJAKS.COM/);
});
