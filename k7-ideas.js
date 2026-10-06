'use strict';
// Progress with rewards lives on the account; generic private/shared storage cannot write it.
const crypto=require('node:crypto');
const PITY_PARTS=Object.freeze(['panzer_platte','panzer_niete','panzer_kiel','panzer_kammer']);
const PITY_REQUIRED=12;
function fail(status,message){throw Object.assign(new Error(message),{status});}
module.exports=function registerIdeas(ctx){
  const {app,authMiddleware,findUserById,getSaveValue,setSaveValue,saveDb,pushPendingReward,addReport,allianceRoleOf,getAllianceRaidDoc,setAllianceRaidDoc}=ctx;
  const now=()=>Date.now();
  function account(id){const user=findUserById(id);if(!user)fail(401,'Konto nicht gefunden.');if(!user.k7Progress)user.k7Progress={};return user.k7Progress;}
  function saveOf(id){try{const value=JSON.parse(getSaveValue(id)||'null');if(value&&typeof value==='object'&&!Array.isArray(value))return value;}catch(_){}fail(409,'Kein gültiger Spielstand vorhanden.');}
  function storyOf(id){const progress=account(id);if(!progress.story)progress.story={stage:0,startedAt:null,choice:null,claimed:false,history:[]};return progress.story;}
  function moveStory(id,stage,evidence){const story=storyOf(id);if(!story.startedAt||story.stage!==stage-1)return false;story.stage=stage;story.history.push({stage,at:now(),evidence});return true;}
  function eventsOf(id){const progress=account(id);if(!progress.encounters)progress.encounters={};return progress.encounters;}
  function resolveEncounter(id,event){
    if(event.status==='resolved'||now()<event.readyAt)return false;
    const choice=event.choice||'salvage';
    const amount=choice==='return'?0:choice==='inspect'?(event.inspectionSuccess?500:0):120;
    event.status='resolved';event.choice=choice;event.resolvedAt=now();event.result={resources:amount?{erz:amount,kristalle:Math.floor(amount/2)}:{},inspectionSuccess:choice==='inspect'?event.inspectionSuccess:null,automatic:!event.decidedAt};
    const report={type:'expedition-choice',encounterId:event.id,choice,...event.result};
    if(addReport)addReport(id,report);
    if(amount)pushPendingReward(id,report);
    const story=storyOf(id);
    if(choice!=='return'&&event.startedAt>=story.startedAt)moveStory(id,1,event.id);
    return true;
  }
  function encounterView(event){const {inspectionSuccess,...view}=event;return view;}
  function state(id){let changed=false;for(const event of Object.values(eventsOf(id)))changed=resolveEncounter(id,event)||changed;if(changed)saveDb();return {story:storyOf(id),encounters:Object.values(eventsOf(id)).sort((a,b)=>b.startedAt-a.startedAt).slice(0,25).map(encounterView),pity:{...pityOf(id),required:PITY_REQUIRED,parts:PITY_PARTS}};}
  function registerEncounter(id,missionId){
    if(!['string','number'].includes(typeof missionId)||!String(missionId)||String(missionId).length>120||typeof missionId==='number'&&!Number.isFinite(missionId))fail(400,'Ungültige Expeditionskennung.');
    const save=saveOf(id),missions=[save.fleet,...Object.values(save.colonies||{}).map(c=>c.fleet)].filter(Boolean).flatMap(f=>Array.isArray(f.missions)?f.missions:[]);
    const mission=missions.find(m=>m.type==='expedition'&&String(m.id)===String(missionId));
    if(!mission||!mission.composition||(mission.composition.forscher||0)<1||!Number.isFinite(mission.startTime)||!Number.isFinite(mission.endTime)||mission.endTime<=now()||mission.endTime<=mission.startTime)fail(409,'Eine laufende Expedition ist erforderlich.');
    const duration=mission.endTime-mission.startTime;if(duration<30000||duration>7*86400000)fail(400,'Ungültige Expeditionsdauer.');
    const key=crypto.createHash('sha256').update(String(mission.id)+':'+mission.startTime).digest('hex');
    const events=eventsOf(id);if(events[key])return encounterView(events[key]);
    const progress=account(id);
    if((progress.lastEncounterAt||0)>now()-60000)fail(429,'Pro Minute kann ein Wrack-Ereignis registriert werden.');
    const pending=Object.values(events).filter(e=>e.status!=='resolved');if(pending.length>=8)fail(409,'Bereits acht offene Expeditionsentscheidungen.');
    if(Object.keys(events).length>=2000)fail(409,'Das Expeditionsarchiv ist voll. Bestehende Ereignisse bleiben erhalten.');
    const event={id:key,missionId:String(mission.id),startedAt:now(),readyAt:Math.max(now()+60000,mission.endTime),status:'pending',choice:null,decidedAt:null,inspectionSuccess:crypto.randomInt(100)>=20};
    events[key]=event;progress.lastEncounterAt=now();return encounterView(event);
  }
  function chooseEncounter(id,eventId,choice){
    const events=eventsOf(id);
    if(typeof eventId!=='string'||!Object.prototype.hasOwnProperty.call(events,eventId))fail(404,'Ereignis nicht gefunden.');
    const event=events[eventId];
    if(!['salvage','inspect','return'].includes(choice))fail(400,'Ungültige Entscheidung.');
    resolveEncounter(id,event);if(event.status==='resolved'||event.decidedAt)return encounterView(event);
    event.choice=choice;event.decidedAt=now();return encounterView(event);
  }
  function pityOf(id){const p=account(id);if(!p.pity)p.pity={part:null,victories:0,claims:0,seen:{}};return p.pity;}
  function recordRaidVictory(id,bossKey,waveKey){
    if(bossKey!=='panzerhuelle')return false;
    const p=pityOf(id);if(p.seen[waveKey])return false;p.seen[waveKey]=true;p.victories=Math.min(PITY_REQUIRED,p.victories+1);return true;
  }
  function claimPity(id){const p=pityOf(id);if(!PITY_PARTS.includes(p.part)||p.victories<PITY_REQUIRED)fail(409,'Pechschutz noch nicht bereit.');
    const part=p.part;p.victories=0;p.claims++;pushPendingReward(id,{type:'set-pity',claim:p.claims,bossset:{bossKey:'panzerhuelle',seltenheit:'selten',defKey:part}});return {ok:true,pity:{...p,required:PITY_REQUIRED,parts:PITY_PARTS}};
  }
  function operationDoc(id,tag){if(typeof tag!=='string'||!allianceRoleOf(tag,id))fail(403,'Nur Mitglieder dieser Allianz.');const doc=getAllianceRaidDoc(tag);if(!doc)fail(404,'Kein Allianz-Raid vorhanden.');return doc;}
  function operationStart(id,tag){const role=allianceRoleOf(tag,id);if(!['admin','officer'].includes(role))fail(403,'Nur Allianzleitung oder Offiziere.');
    const doc=operationDoc(id,tag);if(doc.operation)return doc;
    if(!['gathering','idle'].includes(doc.phase)||doc.hp<=0)fail(409,'Operation vor dem nächsten Abflug beginnen.');
    doc.operation={id:doc.id+':operation',phase:'scout',startedAt:now(),members:{},completedAt:null,rewarded:false};setAllianceRaidDoc(tag,doc);return doc;
  }
  function contribute(id,tag,role){
    const doc=operationDoc(id,tag),op=doc.operation;if(!op||op.completedAt||op.cancelledAt)fail(409,'Keine offene Operation.');
    if(!['scout','supply'].includes(role))fail(400,'Unbekannter Beitrag.');
    const member=op.members[id]||{};
    if(member[role])return {ok:true,doc,duplicate:true};
    if(op.phase!==role||!['gathering','idle'].includes(doc.phase))fail(409,'Dieser Beitrag ist gerade nicht möglich.');
    const save=saveOf(id),fleets=[save.fleet,...Object.values(save.colonies||{}).map(c=>c.fleet)].filter(Boolean);
    const stationed=f=>['spionageschiff','forscher'].some(key=>{
      const away=(f.missions||[]).reduce((sum,m)=>sum+Math.max(0,Number((m.composition||m.schiffe||{})[key])||0),0);
      return (f[key]||0)-away>0;
    });
    if(role==='scout'&&!fleets.some(stationed))fail(409,'Ein stationierter Spionagekreuzer oder ein Forschungsschiff ist erforderlich.');
    const cost=role==='scout'?{energie:100}:{erz:250,kristalle:100};
    if(Object.entries(cost).some(([key,value])=>!Number.isFinite((save.resources||{})[key])||save.resources[key]<value))fail(409,'Nicht genug Ressourcen.');
    for(const [key,value]of Object.entries(cost))save.resources[key]-=value;
    member[role]={at:now(),cost};op.members[id]=member;op.phase=role==='scout'?'supply':'attack';
    setAllianceRaidDoc(tag,doc);const saveVersion=setSaveValue(id,JSON.stringify(save));return {ok:true,doc,cost,saveVersion};
  }
  function operationEffects(tag,doc){const op=doc&&doc.operation;if(!op||op.phase!=='attack')return {counter:1,loss:1};
    const active=Object.entries(op.members).filter(([id])=>allianceRoleOf(tag,id));
    return {counter:active.some(([,m])=>m.scout)?0.9:1,loss:active.some(([,m])=>m.supply)?0.9:1};
  }
  function operationComplete(tag,doc){const op=doc.operation;if(!op||op.phase!=='attack'||op.rewarded)return false;
    op.completedAt=now();op.phase='completed';op.rewarded=true;
    for(const [id,member]of Object.entries(op.members))if(allianceRoleOf(tag,id)&&(member.scout||member.supply))pushPendingReward(id,{type:'alliance-operation',operationId:op.id,credits:40});
    return true;
  }
  function onReward(id,reward){if(['festung','alien-nest','wrackkonvoi'].includes(reward.type))moveStory(id,3,reward.type+':'+now());}
  function onCombat(id,evidence){moveStory(id,3,evidence);}
  const route=(method,url,handler)=>app[method](url,authMiddleware,async(req,res)=>{
    try{const result=handler(req.userId,req.body||{},req);await saveDb();res.json(result);}catch(error){res.status(error.status||500).json({error:error.status?error.message:'Die Aktion konnte nicht gespeichert werden.'});}
  });
  route('get','/api/k7/progress',id=>state(id));
  route('post','/api/k7/story/start',id=>{const s=storyOf(id);if(!s.startedAt){s.startedAt=now();s.history.push({stage:0,at:now(),evidence:'start'});}return {ok:true,story:s};});
  route('post','/api/k7/story/recover',id=>{const s=storyOf(id);if(s.stage!==1)fail(409,'Zuerst das Signal mit einer Expedition bergen.');const event=Object.values(eventsOf(id)).find(e=>e.status==='resolved'&&e.choice!=='return'&&e.startedAt>=s.startedAt);if(!event)fail(409,'Keine geborgenen Expeditionsdaten.');moveStory(id,2,event.id);return {ok:true,story:s};});
  route('post','/api/k7/story/choice',(id,body)=>{const s=storyOf(id);if(!['quarantine','transmit'].includes(body.choice))fail(400,'Ungültiger Abschluss.');if(s.choice)return {ok:true,story:s};if(s.stage!==3)fail(409,'Zuerst die Gefahr mit einem serverbestätigten PvE-Beitrag überwinden.');s.choice=body.choice;moveStory(id,4,body.choice);return {ok:true,story:s};});
  route('post','/api/k7/story/claim',id=>{const s=storyOf(id);if(s.claimed)return {ok:true,story:s,duplicate:true};if(s.stage!==4||!s.choice)fail(409,'Kampagne noch nicht abgeschlossen.');s.claimed=true;moveStory(id,5,'completion');pushPendingReward(id,{type:'story-campaign',campaign:'silent-research-vessel',choice:s.choice,credits:100});return {ok:true,story:s};});
  route('post','/api/k7/expedition/register',(id,body)=>({ok:true,event:registerEncounter(id,body.missionId)}));
  route('post','/api/k7/expedition/choose',(id,body)=>({ok:true,event:chooseEncounter(id,body.id,body.choice)}));
  route('post','/api/k7/pity/target',(id,body)=>{if(!PITY_PARTS.includes(body.part))fail(400,'Ungültiges Teil des Panzerhüllen-Sets.');const pity=pityOf(id);pity.part=body.part;return {ok:true,pity:{...pity,required:PITY_REQUIRED,parts:PITY_PARTS}};});
  route('post','/api/k7/pity/claim',id=>claimPity(id));
  route('get','/api/k7/operation',(id,body,req)=>({ok:true,doc:operationDoc(id,req.query.tag)}));
  route('post','/api/k7/operation/start',(id,body)=>({ok:true,doc:operationStart(id,body.tag)}));
  route('post','/api/k7/operation/cancel',(id,body)=>{
    const doc=operationDoc(id,body.tag),op=doc.operation;
    if(!['admin','officer'].includes(allianceRoleOf(body.tag,id)))fail(403,'Nur Allianzleitung oder Offiziere.');
    if(!op||op.completedAt)fail(409,'Keine offene Operation.');
    if(op.cancelledAt)return {ok:true,doc,duplicate:true};
    if(!['idle','gathering'].includes(doc.phase))fail(409,'Abbruch nur vor dem Abflug.');
    op.phase='cancelled';op.cancelledAt=now();setAllianceRaidDoc(body.tag,doc);return {ok:true,doc};
  });
  route('post','/api/k7/operation/contribute',(id,body)=>contribute(id,body.tag,body.role));
  route('post','/api/k7/raid/variant',(id,body)=>{
    const doc=operationDoc(id,body.tag),role=allianceRoleOf(body.tag,id);
    if(!['admin','officer'].includes(role))fail(403,'Nur Allianzleitung oder Offiziere.');
    if(doc.variant==='shield-cycle')return {ok:true,doc};
    if(doc.bossKey!=='panzerhuelle'||doc.phase!=='gathering'||doc.waveNumber!==1)fail(409,'Schildzyklus nur vor der ersten Panzerhüllen-Welle wählen.');
    doc.variant='shield-cycle';setAllianceRaidDoc(body.tag,doc);return {ok:true,doc};
  });
  const timer=setInterval(()=>{let changed=false;for(const user of Object.values(ctx.db.users)){
    if(!user.k7Progress||!user.k7Progress.encounters)continue;
    for(const event of Object.values(user.k7Progress.encounters))changed=resolveEncounter(user.userId,event)||changed;
  }if(changed)saveDb();},5000);timer.unref();
  return {recordRaidVictory,onReward,onCombat,operationEffects,operationComplete};
};
module.exports.PITY_PARTS=PITY_PARTS;
module.exports.PITY_REQUIRED=PITY_REQUIRED;
