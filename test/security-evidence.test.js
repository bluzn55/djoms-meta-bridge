import test from 'node:test';
import assert from 'node:assert/strict';
import {routeSequence,sequenceSimilarity,compareSweeps} from '../lib/security-evidence.js';
import {securityWatchEndpoint} from '../lib/security-watch.js';

test('Duplicate page opens collapse to an accurate ordered route',()=>{
  assert.deepEqual(routeSequence([
    {path:'/'},{path:'/'},{path:'/sm-welcome'},{path:'/sm-welcome'},
    {path:'/pit-krewe'},{path:'/?utm=bad'},{path:'/outlaw-radio-5150'}
  ]),['/','/sm-welcome','/pit-krewe','/outlaw-radio-5150']);
});

test('Route similarity is deterministic and distinguishes different routes',()=>{
  assert.equal(sequenceSimilarity(['/','/sm-welcome','/pit-krewe'],['/','/sm-welcome','/pit-krewe']),100);
  assert.equal(sequenceSimilarity(['/','/sm-welcome','/pit-krewe'],['/','/trading-post','/pit-krewe']),67);
  assert.equal(sequenceSimilarity([],['/']),0);
  assert.equal(sequenceSimilarity(['/'],[]),0);
});

test('Cross-IP route matches are evidence of similar order, not proven attribution',()=>{
  const base=['/','/sm-welcome','/book','/pit-krewe','/radio','/store','/token','/wisdom','/archives'];
  const make=(ip,paths)=>({ipAddress:ip,timeline:paths.flatMap(path=>[{path},{path}])});
  const comparisons=compareSweeps([
    make('192.0.2.1',base),
    make('198.51.100.2',base),
    make('203.0.113.3',['/','/other','/elsewhere'])
  ]);
  assert.equal(comparisons.length,1);
  assert.equal(comparisons[0].score,100);
  assert.equal(comparisons[0].differentNetworks,true);
});

test('Security evidence endpoint rejects unauthenticated requests and writes no public record', async()=>{
  Object.assign(process.env,{
    PUBLIC_BASE_URL:'https://example.test',
    DJOMS_SESSION_SECRET:'x'.repeat(40),
    DJOMS_ADMIN_PASSWORD:'x'.repeat(24),
    KV_REST_API_URL:'https://example.test/redis',
    KV_REST_API_TOKEN:'test-placeholder'
  });
  const capture=()=>({
    code:200,headers:{},
    setHeader(k,v){this.headers[k]=v;},
    status(v){this.code=v;return this;},
    json(value){this.body=value;}
  });
  const get=capture();
  await securityWatchEndpoint({method:'GET',headers:{},query:{range:'7d'}},get);
  assert.equal(get.code,401);
  assert.equal(get.body?.success,false);
  assert.equal(get.headers['Cache-Control'],'no-store');
  const post=capture();
  await securityWatchEndpoint({method:'POST',headers:{},query:{range:'7d'}},post);
  assert.equal(post.code,405);
});
