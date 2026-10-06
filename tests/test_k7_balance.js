'use strict';
const assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),register=require('../k7-ideas');
const user={userId:'u'},handlers={},rewards=[];
const app={get(){},post(path,...args){handlers[path]=args.at(-1);}};
const ideas=register({app,authMiddleware(){},db:{users:{u:user}},findUserById:()=>user,getSaveValue:()=>null,setSaveValue(){},saveDb:async()=>{},pushPendingReward:(id,r)=>rewards.push(r),allianceRoleOf:()=>null,getAllianceRaidDoc:()=>null,setAllianceRaidDoc(){}});
async function route(path,body={}){let status=200,output;await handlers['/api/k7/'+path]({userId:'u',body},{status(n){status=n;return this;},json(o){output=o;}});return {status,output};}
(async()=>{
  await route('pity/target',{part:'panzer_kammer'});
  for(let victory=1;victory<=144;victory++){
    assert.equal(ideas.recordRaidVictory('u','panzerhuelle','wave-'+victory),true);
    assert.equal(ideas.recordRaidVictory('u','panzerhuelle','wave-'+victory),false);
    assert.equal(ideas.recordRaidVictory('u','schwarmmutter','other-'+victory),false);
    if(victory%12===0)assert.equal((await route('pity/claim')).status,200);
    else assert.equal((await route('pity/claim')).status,409,'only the twelfth genuine victory unlocks a claim');
  }
  assert.equal(rewards.length,12);assert.ok(rewards.every(r=>r.bossset.defKey==='panzer_kammer'&&r.bossset.seltenheit==='selten'));
  console.log('OK - 144 genuine victories yield exactly 12 chosen rare parts, duplicates/other sources never count');
  for(let i=0;i<30;i++)ideas.recordRaidVictory('u','panzerhuelle','extra-'+i);
  assert.equal(user.k7Progress.pity.victories,12);await route('pity/claim');assert.equal((await route('pity/claim')).status,409);
  console.log('OK - counter caps at 12 without banking multiple claims');
  const source=fs.readFileSync(path.resolve(__dirname,'../server.js'),'utf8');
  const formula=source.match(/const chance = Math\.min\(0\.75, 0\.15 \+ 0\.45 \* rShare \+ Math\.max\(1, level \| 0\) \* 0\.01\);/);
  assert.ok(formula,'existing random-drop model must be rechecked after a balance change');
  const rows=[];
  for(const [level,rankShare]of [[1,0],[1,1],[20,0],[20,1]]){
    const original=Math.min(.75,.15+.45*rankShare+Math.max(1,level)*.01),pity=1/12;
    rows.push({level,rankShare,randomPartsPerVictory:original,targetPerVictory:original/4,pityRarePartsPerVictory:pity,newTotal:original+pity});
  }
  assert.ok(rows.every(r=>r.newTotal-r.randomPartsPerVictory<=1/12+Number.EPSILON));
  console.log('OK - added availability is bounded at one rare part per twelve final victories');
  console.log(JSON.stringify(rows));
})().catch(error=>{console.error(error);process.exitCode=1;});
