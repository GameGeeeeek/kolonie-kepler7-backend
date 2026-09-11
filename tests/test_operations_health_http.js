const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path'),net=require('net');
const {spawn}=require('child_process');
const jwt=require('jsonwebtoken');
test('real HTTP health counts only authenticated players and reports actual startup probes',async()=>{
 const root=path.resolve(__dirname,'..'),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'kepler-ops-'));
 const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
 fs.writeFileSync(path.join(tmp,'db.json'),JSON.stringify({users:{probe:{userId:'probe',username:'probe'}},private:{},shared:{}}));
 fs.writeFileSync(path.join(tmp,'secret'),'isolated-test-secret');
 const child=spawn(process.execPath,[process.env.KEPLER_SERVER_JS||path.join(root,'server.js')],{cwd:root,env:{...process.env,PORT:String(port),DB_FILE:path.join(tmp,'db.json'),SECRET_FILE:path.join(tmp,'secret'),VAPID_PUBLIC_FILE:path.join(tmp,'pub'),VAPID_PRIVATE_FILE:path.join(tmp,'priv'),RESEND_API_KEY:''},stdio:'ignore'});
 const get=(route,token)=>fetch(`http://127.0.0.1:${port}${route}`,token?{headers:{authorization:'Bearer '+token}}:{});
 try{
  let health;
  for(let i=0;i<50;i++){await new Promise(r=>setTimeout(r,100));try{health=await (await get('/api/health')).json();if(health.operationsHealthVersion===1&&health.checks.database!==null)break;}catch{}}
  assert.equal(health?.operationsHealthVersion,1,'versioned operational health is exposed');
  assert.equal(health.checks.database,true,'actual database probe succeeded');
  assert.equal(health.checks.simulation,true,'startup galaxy tick completed');
  assert.equal(health.players,0,'total accounts are not active players');
  assert.equal((await get('/api/me','invalid')).status,401);
  assert.equal((await (await get('/api/health')).json()).players,0,'invalid authentication does not count');
  const token=jwt.sign({userId:'probe',username:'probe'},'isolated-test-secret');
  assert.equal((await get('/api/me',token)).status,200);
  health=await (await get('/api/health')).json();assert.equal(health.players,1,'validated request counted');
  assert.equal(health.maintenance.active,false);assert.equal(health.playerWindowSeconds,300);
 }finally{child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));fs.rmSync(tmp,{recursive:true,force:true});}
});
