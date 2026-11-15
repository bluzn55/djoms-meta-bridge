import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionEndpoint, PREFIX } from '../lib/core.js';
import { summarizeOwnerLoginEvidence, readOwnerLoginEvidence, securityEventsEndpoint } from '../lib/login-security-events.js';

const period={range:'today',start:'2026-11-15',endInclusive:'2026-11-15',days:1};
test('owner login telemetry summarizes rejected attempts without asserting an attack',()=>{
  const result=summarizeOwnerLoginEvidence({
    failed:8,lockouts:1,
    lastFailed:'2026-11-15T10:00:00.000Z',
    lastLockout:'2026-11-15T10:01:00.000Z'
  },period);
  assert.equal(result.status,'connected');
  assert.equal(result.failedAdminLogins,8);
  assert.equal(result.rateLimitLockouts,1);
  assert.equal(result.confirmedAttack,null);
  assert.match(result.note,/not proof|does not prove/i);
});
test('empty evidence is zero observed rejected requests, never a verified all-clear',()=>{
  const result=summarizeOwnerLoginEvidence({failed:0,lockouts:0,lastFailed:'',lastLockout:''},period);
  assert.equal(result.failedAdminLogins,0);
  assert.equal(result.lastFailureAt,null);
  assert.equal(result.blockedRequests,null);
  assert.equal(result.failedWixLogins,null);
});
test('corrupted counters are rejected',()=>{
  assert.throws(()=>summarizeOwnerLoginEvidence({failed:-4,lockouts:0},period));
  assert.throws(()=>summarizeOwnerLoginEvidence({failed:'not-a-number',lockouts:0},period));
});
test('actual rejected passwords and lockout windows produce owner-only aggregate events',async()=>{
  const keys=['PUBLIC_BASE_URL','UPSTASH_REDIS_REST_URL','UPSTASH_REDIS_REST_TOKEN',
    'DJOMS_SESSION_SECRET','DJOMS_ADMIN_PASSWORD'];
  const saved=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
  const previousFetch=globalThis.fetch;
  const origin='https://command.example.test';
  const counts={failed:0,lockouts:0};
  let attempts=0;
  try{
    Object.assign(process.env,{
      PUBLIC_BASE_URL:origin,
      UPSTASH_REDIS_REST_URL:'https://redis.example.test',
      UPSTASH_REDIS_REST_TOKEN:'test-only-token',
      DJOMS_SESSION_SECRET:'test-only-secret-with-at-least-32-characters',
      DJOMS_ADMIN_PASSWORD:'test-only-owner-password-of-safe-length'
    });
    globalThis.fetch=async(url,options)=>{
      assert.equal(url,'https://redis.example.test');
      const command=JSON.parse(options.body);
      let result=null;
      if(command[0]==='GET'){
        result=null;
      }else if(command[0]==='EVAL'){
        if(command[1].includes('redis.call("incr"')) {
          result=++attempts;
        }else if(command[1].includes('HINCRBY')){
          const type=command[4];
          if(!Object.hasOwn(counts,type))throw Error('Unrecognized counter '+type);
          counts[type]++;
          assert.match(command[3],new RegExp('^'+PREFIX+'security:owner-login:'));
          result=1;
        }else if(command[1].includes('HMGET')){
          result=JSON.stringify({...counts,lastFailed:'',lastLockout:''});
        }else{
          throw Error('Unexpected Redis script');
        }
      }else{
        throw Error('Unexpected Redis command '+command[0]);
      }
      return {ok:true,json:async()=>({result})};
    };
    const request=()=>({
      method:'POST',query:{action:'session'},
      headers:{origin,'content-type':'application/json'},
      body:{password:'deliberately-incorrect-secret'}
    });
    const response=()=>({
      code:200,body:null,headers:{},
      setHeader(name,value){this.headers[name]=value;},
      status(value){this.code=value;return this;},
      json(value){this.body=value;return this;}
    });
    for(let i=0;i<16;i++){
      const res=response();
      await sessionEndpoint(request(),res);
      assert.equal(res.code,i===15?429:401);
    }
    assert.deepEqual(counts,{failed:15,lockouts:1});
    assert.equal(attempts,16);
    const proof=await readOwnerLoginEvidence(period);
    assert.equal(proof.status,'connected');
    assert.equal(proof.failedAdminLogins,15);
    assert.equal(proof.rateLimitLockouts,1);
  }finally{
    globalThis.fetch=previousFetch;
    for(const [k,value] of Object.entries(saved)){
      if(value===undefined)delete process.env[k];else process.env[k]=value;
    }
  }
});
