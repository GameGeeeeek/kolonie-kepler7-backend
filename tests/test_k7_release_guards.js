'use strict';
const assert=require('node:assert/strict');
const register=require(process.env.KEPLER_K7_MODULE||'../k7-ideas');
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const now=Date.now(),users={a:{userId:'a',k7Progress:{story:{stage:2,startedAt:now-1000,history:[]}}},b:{userId:'b',k7Progress:{story:{stage:2,startedAt:now-1000,history:[]}}}};
const handlers={},rewards=[],save={resources:{energie:1000,erz:1000,kristalle:1000},fleet:{forscher:1,missions:[]}};
let writes=0,doc={id:'raid',hp:100,phase:'gathering',expiresAt:now+3600000};
const api=register({app:{get(path,...args){handlers[path]=args.at(-1);},post(path,...args){handlers[path]=args.at(-1);}},authMiddleware(){},db:{users},findUserById:id=>users[id],getSaveValue:()=>JSON.stringify(save),setSaveValue(id,value){Object.assign(save,JSON.parse(value));return 1;},saveDb:async()=>{writes++;},pushPendingReward:(id,reward)=>rewards.push({id,reward}),addReport(){},allianceRoleOf:()=> 'admin',getAllianceRaidDoc:()=>doc,setAllianceRaidDoc(tag,value){doc=value;}});
async function route(path,body={},userId='a'){let status=200,result;await handlers['/api/k7/'+path]({userId,body,query:{tag:'OP'}},{status(n){status=n;return this;},json(value){result=value;}});return {status,result};}
(async()=>{
  const server=fs.readFileSync(path.resolve(__dirname,'../server.js'),'utf8'),start=server.indexOf('function pushPendingReward(userId, reward) {'),end=server.indexOf('function resolveWeeklyLeagueServer()',start);
  assert.ok(start>=0&&end>start,'real reward integration anchors exist');
  const rewardDb={private:{}};
  const distribute=new Function('db','k7Ideas','crypto',server.slice(start,end)+'\nreturn pushPendingReward;')(rewardDb,api,crypto);
  for(const type of ['festung','alien-nest','wrackkonvoi']){
    assert.doesNotThrow(()=>{for(const id of ['a','deleted','b'])distribute(id,{type});},'deleted recipients never interrupt the remaining payout loop');
  }
  assert.equal(users.a.k7Progress.story.stage,3);assert.equal(users.b.k7Progress.story.stage,3);
  for(const id of ['a','b'])assert.equal(rewardDb.private[id].__pendingRewards.length,3,'all remaining recipients receive one reward per defeated target');
  console.log('OK - deleted recipients never interrupt the remaining payout loop');
  await route('operation');assert.equal(writes,0,'reading an operation does not write the database');
  await route('progress');const initialized=writes;assert.equal(initialized,1,'new progress defaults are saved exactly once');
  await route('progress');await route('progress');assert.equal(writes,initialized,'unchanged progress reads do not write the database');
  users.a.k7Progress.encounters.pending={id:'pending',status:'pending',readyAt:now-1,startedAt:now-100,choice:'return',decidedAt:now-100};
  await route('progress');assert.equal(writes,initialized+1,'resolving an encounter persists once');
  await route('progress');assert.equal(writes,initialized+1,'resolved encounter reads remain read only');
  console.log('OK - reads avoid database rewrites while new defaults and resolved encounters persist');
  doc.expiresAt=now-1;const before=JSON.stringify(save);
  assert.equal((await route('operation/start',{tag:'OP'})).status,409,'expired raid rejects operation start');
  doc.operation={phase:'scout',members:{}};
  assert.equal((await route('operation/contribute',{tag:'OP',role:'scout'})).status,409,'expired raid rejects paid contributions');
  assert.equal(JSON.stringify(save),before,'expired contributions consume no resources');
  console.log('OK - expired raids accept no operation or paid contribution');
  console.log('PASS release guards');
})().catch(error=>{console.error(error);process.exitCode=1;});
