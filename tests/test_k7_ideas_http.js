'use strict';
// Real HTTP, isolated DB/secrets, abrupt restart: no production account or files are touched.
const fs=require('fs'),path=require('path'),os=require('os'),net=require('net'),assert=require('node:assert/strict');
const {spawn}=require('child_process'),bcrypt=require('bcryptjs');
const root=path.resolve(__dirname,'..'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'k7-ideas-')),dbFile=path.join(dir,'db.json');
const sabotage=process.env.KEPLER_K7_SABOTAGE||'';
let serverFile=path.join(root,'server.js'),mutatedFiles=[];
if(sabotage){
  const mutations={gate:["(kannIdeenpaket || !ideenTypen.includes(r.type))","true"],pity:["p.victories=0;p.claims++","p.victories=12;p.claims++"],phase:["shield?(pierces?0.9:0.65)","shield?(pierces?0.9:1)"]};
  assert.ok(mutations[sabotage],'known sabotage');let source=fs.readFileSync(serverFile,'utf8');
  const target=sabotage==='gate'?'server.js':sabotage==='pity'?'k7-ideas.js':'boss-phases.js';
  let moduleSource=fs.readFileSync(path.join(root,target),'utf8');const [before,after]=mutations[sabotage];assert.equal(moduleSource.split(before).length,2,'unique mutation');moduleSource=moduleSource.replace(before,after);
  if(target==='server.js')source=moduleSource;else{const moduleFile='k7-mutation-'+process.pid+'.js';fs.writeFileSync(path.join(root,moduleFile),moduleSource);mutatedFiles.push(path.join(root,moduleFile));source=source.replace("require('./"+target.replace('.js','')+"')","require('./"+moduleFile+"')");}
  serverFile=path.join(root,'server-k7-mutation-'+process.pid+'.js');fs.writeFileSync(serverFile,source);mutatedFiles.push(serverFile);
}
const now=Date.now(),hash=bcrypt.hashSync('fixture-password',4),users={},priv={},shared={};
const ids={anna:'11111111-1111-4111-8111-111111111111',ben:'22222222-2222-4222-8222-222222222222',outsider:'33333333-3333-4333-8333-333333333333'};
function save(id){return {player:{id,name:'fixture'},resources:{energie:1000,erz:1000,kristalle:1000,deuterium:1000},buildings:{},research:{},colonies:{},fleet:{forscher:id===ids.anna?2:1,bomber:5,missions:[{id:'active',type:'expedition',startTime:now-1000,endTime:now+120000,composition:{forscher:1}}]},credits:0,battlePoints:0,xp:0,lastTick:now};}
for(const [name,id]of Object.entries(ids)){users[name]={userId:id,username:name,passwordHash:hash,createdAt:now};priv[id]={'kepler7-save-v3':name==='ben'?{value:JSON.stringify(save(id)),version:7}:JSON.stringify(save(id))};}
users.anna.k7Progress={story:{stage:0,startedAt:now-100000,choice:null,claimed:false,history:[]},encounters:{safe:{id:'safe',missionId:'past',startedAt:now-90000,readyAt:now-1000,status:'pending',choice:null,decidedAt:null,inspectionSuccess:false}},pity:{part:null,victories:11,claims:0,seen:{}}};
users.ben.k7Progress={story:{stage:3,startedAt:now-100000,choice:null,claimed:false,history:[]},encounters:{failed:{id:'failed',missionId:'past',startedAt:now-90000,readyAt:now-1000,status:'pending',choice:'inspect',decidedAt:now-50000,inspectionSuccess:false}}};
const role=(id,role)=>JSON.stringify({playerId:id,role,name:'fixture'});
for(const tag of ['OP','FINAL','SHIELD','VULN']){shared['alliance:'+tag+':role:'+ids.anna]=role(ids.anna,'admin');shared['alliance:'+tag+':role:'+ids.ben]=role(ids.ben,'member');}
function raid(id,hp=1000,maxHp=1000){return {id,level:1,bossKey:'panzerhuelle',hp,maxHp,phase:'gathering',waveNumber:1,gatherEndsAt:now+120000,expiresAt:now+3600000,status:{}};}
const op=raid('op'),final=raid('final',0),shield=raid('shield'),vuln=raid('vuln',499);
final.phase='resolved';final.result={waveNumber:1,destroyed:true,totalPower:100,topParticipantId:ids.anna,resolvedAt:now-1000,lossPct:0.05,bossKey:'panzerhuelle',ranking:[{id:ids.anna,name:'anna',power:100}],totalComposition:{bomber:5},totalShips:5,participantCount:1};
shared['alliance:FINAL:raidjoin:final-w1:'+ids.anna]=JSON.stringify({originPlanet:'home',composition:{bomber:5},power:100,arrivesAtBaseAt:now-2000,gatherEndsAt:now-1000});
for(const doc of [shield,vuln]){doc.variant='shield-cycle';doc.phase='enroute';doc.dispatch={arrivalAt:now-1,totalPower:100,totalShips:10,totalComposition:{jaeger:10},participantCount:1,participantIds:[ids.anna],topParticipantId:ids.anna,ranking:[{id:ids.anna,power:100}]};}
for(const [tag,doc]of Object.entries({OP:op,FINAL:final,SHIELD:shield,VULN:vuln}))shared['alliance:'+tag+':raid']=JSON.stringify(doc);
fs.writeFileSync(dbFile,JSON.stringify({users,private:priv,shared,galaxy:{lastTick:now,alienNester:[],wrackKonvois:[],news:[],factions:{}}}));
let srv,origin,tokens={},checks=0,log='';
function check(name,condition,detail){assert.ok(condition,name+(detail?' '+JSON.stringify(detail):''));checks++;console.log('OK - '+name);}
async function start(){
  const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const n=s.address().port;s.close(()=>resolve(n));});});origin='http://127.0.0.1:'+port+'/api';log='';
  srv=spawn(process.execPath,[serverFile],{cwd:root,env:{...process.env,DB_FILE:dbFile,PORT:String(port),SECRET_FILE:path.join(dir,'jwt'),VAPID_PUBLIC_FILE:path.join(dir,'pub'),VAPID_PRIVATE_FILE:path.join(dir,'priv')}});
  srv.stdout.on('data',d=>log+=d);srv.stderr.on('data',d=>log+=d);
  for(let i=0;i<100;i++){try{if((await fetch(origin+'/health')).ok)break;}catch(_){}await new Promise(r=>setTimeout(r,100));}
  check('real server starts',srv.exitCode===null,log.slice(-500));
  for(const name of Object.keys(ids)){const r=await request('/login',{username:name,password:'fixture-password'},null);assert.equal(r.status,200,JSON.stringify(r));tokens[name]=r.body.token;}
}
async function stop(){if(!srv)return;const p=srv;await new Promise(resolve=>{p.once('exit',resolve);p.kill('SIGKILL');});srv=null;}
async function request(url,body,who='anna'){const r=await fetch(origin+url,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(who?{Authorization:'Bearer '+tokens[who]}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json()};}
const post=(url,body={},who)=>request('/k7/'+url,body,who);
(async()=>{try{
  await start();
  check('anonymous progress forbidden',(await request('/k7/progress',undefined,null)).status===401);
  let p=(await request('/k7/progress')).body;
  check('elapsed default resolves safely and advances first chapter',p.story.stage===1&&p.encounters[0].result.automatic&&p.encounters[0].result.resources.erz===120);
  check('private random result is hidden',!('inspectionSuccess'in p.encounters[0]));
  check('story cannot skip to reward',(await post('story/claim')).status===409);
  check('real recovered data advances chapter',(await post('story/recover')).body.story.stage===2);
  check('cannot choose ending before combat',(await post('story/choice',{choice:'quarantine'})).status===409);
  let e=(await post('expedition/register',{missionId:'active'})).body.event;
  check('active saved expedition registers',e&&e.readyAt>=now+120000&&!('inspectionSuccess'in e));
  check('retry registration reuses exact event',(await post('expedition/register',{missionId:'active'})).body.event.id===e.id);
  check('invented expedition rejected',(await post('expedition/register',{missionId:'fiction'})).status===409);
  check('missing mission ID rejected',(await post('expedition/register',{})).status===400);
  check('invalid option rejected',(await post('expedition/choose',{id:e.id,choice:'rich'})).status===400);
  check('choice saved once',(await post('expedition/choose',{id:e.id,choice:'inspect'})).body.event.choice==='inspect');
  check('retry cannot change decision',(await post('expedition/choose',{id:e.id,choice:'salvage'})).body.event.choice==='inspect');
  check('outsider cannot choose another account event',(await post('expedition/choose',{id:e.id,choice:'inspect'},'outsider')).status===404);
  p=(await request('/k7/progress',undefined,'ben')).body;
  check('failed inspection grants no resources',Object.keys(p.encounters[0].result.resources).length===0);
  check('unknown pity part rejected',(await post('pity/target',{part:'mine'})).status===400);
  check('pity unavailable at eleven victories',(await post('pity/claim')).status===409);
  const claim=await request('/allianceraid/claim',{tag:'FINAL',raidId:'final',waveNumber:1});check('confirmed final raid claim succeeds',claim.status===200,claim);
  p=(await request('/k7/progress')).body;check('real victory counts once and advances combat stage',p.pity.victories===12&&p.story.stage===3,p);
  await request('/allianceraid/claim',{tag:'FINAL',raidId:'final',waveNumber:1});
  check('duplicate raid claim cannot add pity',(await request('/k7/progress')).body.pity.victories===12);
  check('choose legitimate part',(await post('pity/target',{part:'panzer_platte'})).status===200);
  check('pity grants targeted part once',(await post('pity/claim')).body.pity.victories===0);
  check('duplicate pity claim rejected',(await post('pity/claim')).status===409);
  check('first ending saved',(await post('story/choice',{choice:'quarantine'})).body.story.stage===4);
  check('ending cannot change',(await post('story/choice',{choice:'transmit'})).body.story.choice==='quarantine');
  check('completion reward once',(await post('story/claim')).body.story.claimed);
  check('completion retry is idempotent',(await post('story/claim')).body.duplicate);
  check('other ending available',(await post('story/choice',{choice:'transmit'},'ben')).body.story.choice==='transmit');
  await post('story/claim',{},'ben');
  check('second ending pays once',(await request('/pending-rewards/claim',{k7IdeasVersion:1},'ben')).body.reward.choice==='transmit');
  check('old clients retain new rewards',(await request('/pending-rewards/claim',{})).body.updateRequired===true);
  const rewards=[];for(let i=0;i<5;i++){const r=(await request('/pending-rewards/claim',{k7IdeasVersion:1})).body.reward;if(r)rewards.push(r);}
  check('only three expected rewards',rewards.length===3&&rewards.some(r=>r.type==='set-pity'&&r.bossset.defKey==='panzer_platte')&&rewards.filter(r=>r.type==='story-campaign').length===1,rewards);
  check('outsider cannot see operation',(await request('/k7/operation?tag=OP',undefined,'outsider')).status===403);
  check('member cannot start operation',(await post('operation/start',{tag:'OP'},'ben')).status===403);
  check('leader can start operation',(await post('operation/start',{tag:'OP'})).body.doc.operation.phase==='scout');
  check('out-of-order supply rejected',(await post('operation/contribute',{tag:'OP',role:'supply'},'ben')).status===409);
  check('researcher already away cannot scout',(await post('operation/contribute',{tag:'OP',role:'scout'},'ben')).status===409);
  let r=await post('operation/contribute',{tag:'OP',role:'scout'});check('real scout cost and save version',r.status===200&&r.body.cost.energie===100&&r.body.saveVersion>0,r);
  check('duplicate scout costs nothing',(await post('operation/contribute',{tag:'OP',role:'scout'})).body.duplicate);
  r=await post('operation/contribute',{tag:'OP',role:'supply'},'ben');check('object save supports supply',r.status===200&&r.body.cost.erz===250&&r.body.saveVersion===8,r);
  check('operation reaches existing attack phase',r.body.doc.operation.phase==='attack');
  check('outsider cannot activate variant',(await post('raid/variant',{tag:'OP'},'outsider')).status===403);
  check('leader activates optional variant',(await post('raid/variant',{tag:'OP'})).body.doc.variant==='shield-cycle');
  const shieldResult=(await request('/allianceraid/resolve',{tag:'SHIELD'})).body.doc.lastWaveResult;
  check('actual shield damage includes existing weakness',shieldResult.damage===49&&shieldResult.bossPhase.damage===0.65,shieldResult);
  const vulnResult=(await request('/allianceraid/resolve',{tag:'VULN'})).body.doc.lastWaveResult;
  check('actual vulnerable phase changes counter and damage',vulnResult.damage===90&&vulnResult.bossPhase.counter===0.8,vulnResult);
  await stop();
  let persisted=JSON.parse(fs.readFileSync(dbFile,'utf8'));
  check('abrupt stop preserves story and pity',persisted.users.anna.k7Progress.story.stage===5&&persisted.users.anna.k7Progress.pity.claims===1);
  const sa=JSON.parse(persisted.private[ids.anna]['kepler7-save-v3'].value),sb=JSON.parse(persisted.private[ids.ben]['kepler7-save-v3'].value);
  check('cost persisted once on both save forms',sa.resources.energie===900&&sb.resources.erz===750&&sb.resources.kristalle===900);
  const attack=JSON.parse(persisted.shared['alliance:OP:raid']);attack.phase='enroute';attack.hp=1;attack.dispatch={arrivalAt:Date.now()-1,totalPower:10000,totalShips:5,totalComposition:{bomber:5},participantCount:1,participantIds:[ids.anna],topParticipantId:ids.anna,ranking:[{id:ids.anna,power:10000}]};persisted.shared['alliance:OP:raid']=JSON.stringify(attack);fs.writeFileSync(dbFile,JSON.stringify(persisted));
  await start();
  r=await request('/allianceraid/resolve',{tag:'OP'});check('actual combat uses operation buffs',r.body.doc.result.operationEffects.counter===0.9&&r.body.doc.result.operationEffects.loss===0.9,r);
  check('operation finishes once',r.body.doc.operation.rewarded&&r.body.doc.operation.phase==='completed');
  await request('/allianceraid/resolve',{tag:'OP'});
  for(const who of ['anna','ben']){const reward=(await request('/pending-rewards/claim',{k7IdeasVersion:1},who)).body.reward;check('offline contributor '+who+' reward once',reward&&reward.type==='alliance-operation'&&reward.credits===40,reward);}
  check('duplicate completion pays nothing',(await request('/pending-rewards/claim',{k7IdeasVersion:1})).body.reward===null);
  await stop();await start();check('restart retains fixed choice',(await request('/k7/progress')).body.encounters.find(x=>x.id===e.id).choice==='inspect');
  check('no runtime errors',!/ReferenceError|TypeError/.test(log));console.log('PASS '+checks+' HTTP checks');
}finally{await stop();for(const file of mutatedFiles)fs.unlinkSync(file);fs.rmSync(dir,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
