import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url),{fixture,sha,engineFile}=require('./lib/release-archive-fixture.cjs');
const posix={skip:process.platform==='win32'},MiB=1024*1024;
const requestId='3f3e20bc-a14d-4e8b-a769-5839d3a98b72',otherId='4f3e20bc-a14d-4e8b-a769-5839d3a98b72';
const privateWrite=(file,value)=>fs.writeFileSync(file,typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value),{mode:0o600});
const blob=(f,file)=>path.join(f.store,'blobs',file.sha256+'.gz');
const metadata=files=>files.map(({data:_data,...file})=>file);
const indexWrite=(f,id,value)=>{privateWrite(path.join(f.store,id,'source.json.gz'),zlib.gzipSync(Buffer.from(JSON.stringify(value))));privateWrite(path.join(f.store,id,'manifest.json'),{...value,version:1,files:metadata(value.files)});};
const rootsSnapshot=f=>Object.fromEntries(Object.keys(f.roots).map(area=>[area,Object.fromEntries(Object.keys(f.versions[f.current[area]][area]).map(name=>[name,sha(fs.readFileSync(path.join(f.roots[area],name)))]))]));
const two=f=>{const a=f.engine.initialize().id;f.select('b');const b=f.engine.initialize().id;return {a,b};};
const noSourceCommands=f=>assert.equal(f.calls.some(call=>['read-tree','update-ref'].includes(call.op[0])),false);
const assertRefused=(f,target,prior,expected)=>{
 const before=rootsSnapshot(f),db=fs.readFileSync(f.dbFile),lock=path.join(f.store,'deployment.lock');f.calls.length=0;
 assert.equal(f.engine.inventory().releases.find(row=>row.id===target)?.compatible,false);
 assert.throws(()=>f.engine.prepare({requestId,target,mode:'rollback'}),expected);
 assert.deepEqual(rootsSnapshot(f),before);noSourceCommands(f);assert.equal(f.state().current,prior);assert.equal(f.state().phase,'complete');assert.equal(fs.existsSync(lock),false);assert.deepEqual(fs.readFileSync(f.dbFile),db);assert.equal(fs.existsSync(path.join(f.store,'backups',requestId+'.db.json.gz')),false);
};

test('v2 archives bind metadata-only indexes to one private blob per unique source byte sequence',posix,t=>{
 const f=fixture(t),seed=f.addSeed('shared',crypto.randomBytes(MiB));f.versions.a.frontend['assets/shared.png']=seed;f.versions.a.web['assets/shared.png']=seed;f.select('a');const id=f.engine.initialize().id,value=f.raw(id),manifest=JSON.parse(fs.readFileSync(path.join(f.store,id,'manifest.json')));
 assert.equal(value.version,2);assert.equal(manifest.version,1);assert.deepEqual(manifest,{...value,version:1});
 const identity={backendCommit:value.backendCommit,frontendCommit:value.frontendCommit,runtimeProof:value.runtimeProof,proof:value.proof,operationsProof:value.operationsProof,files:value.files};assert.equal(id,value.backendCommit+'-'+sha(JSON.stringify(identity)));
 for(const file of value.files){assert.deepEqual(Object.keys(file).sort(),['area','bytes','name','sha256']);const raw=zlib.gunzipSync(fs.readFileSync(blob(f,file)));assert.equal(raw.length,file.bytes);assert.equal(sha(raw),file.sha256);assert.deepEqual(raw,fs.readFileSync(path.join(f.roots[file.area],file.name)));assert.equal(fs.lstatSync(blob(f,file)).mode&0o777,0o600);}
 const unique=new Set(value.files.map(file=>file.sha256));assert.equal(fs.readdirSync(path.join(f.store,'blobs')).length,unique.size);assert.equal(value.files.filter(file=>file.sha256===sha(fs.readFileSync(seed.from))).length,2);assert.equal(fs.lstatSync(path.join(f.store,'blobs')).mode&0o777,0o700);assert.equal(value.files.some(file=>file.name==='db.json'),false);assert.equal(JSON.stringify(value).includes('private account data'),false);f.assertDatabase();
});

test('an exact 16 MiB incompressible file remains readable with bounded gzip overhead',posix,t=>{
 const f=fixture(t),seed=f.addSeed('boundary',crypto.randomBytes(16*MiB));f.versions.a.frontend['boundary.png']=seed;f.versions.a.web['boundary.png']=seed;f.select('a');const id=f.engine.initialize().id,file=f.raw(id).files.find(file=>file.area==='frontend'&&file.name==='boundary.png');assert.equal(file.bytes,16*MiB);const packed=fs.readFileSync(blob(f,file));assert.ok(packed.length>16*MiB);assert.ok(packed.length<=16*MiB+64*1024);assert.equal(sha(zlib.gunzipSync(packed)),file.sha256);assert.equal(f.engine.inventory().releases.find(row=>row.id===id).compatible,true);f.assertDatabase();
});

test('a physical source file above the 16 MiB cap cannot publish an archive or keep a lock',posix,t=>{
 const f=fixture(t),seed=f.addSeed('too-large',Buffer.alloc(16*MiB+1,71));f.versions.a.frontend['too-large.png']=seed;f.select('a');assert.equal(fs.statSync(path.join(f.roots.frontend,'too-large.png')).size,16*MiB+1);assert.throws(()=>f.engine.initialize());assert.equal(fs.existsSync(path.join(f.store,'state.json')),false);assert.equal(fs.existsSync(path.join(f.store,'deployment.lock')),false);assert.equal(fs.readdirSync(f.store).filter(name=>/^[a-f0-9]{40}-[a-f0-9]{64}$/.test(name)).length,0);f.assertDatabase();
});

test('physical logical source bytes above 512 MiB remain rejected despite deduplication',posix,t=>{
 const f=fixture(t),seed=f.addSeed('logical',Buffer.alloc(8*MiB,73));for(let i=0;i<33;i++){f.versions.a.frontend['asset-'+i+'.png']=seed;f.versions.a.web['asset-'+i+'.png']=seed;}f.select('a');const logical=['frontend','web'].reduce((sum,area)=>sum+Object.keys(f.versions.a[area]).reduce((n,name)=>n+fs.statSync(path.join(f.roots[area],name)).size,0),0);assert.ok(logical>512*MiB);assert.throws(()=>f.engine.initialize(),error=>error.code==='release_size_limit');assert.equal(fs.existsSync(path.join(f.store,'state.json')),false);assert.equal(fs.existsSync(path.join(f.store,'deployment.lock')),false);f.assertDatabase();
});

test('physical unique source bytes above 256 MiB remain rejected below the logical cap',posix,t=>{
 const f=fixture(t);for(let i=0;i<33;i++)f.versions.a.frontend['unique-'+i+'.png']=f.addSeed('unique-'+i,crypto.randomBytes(8*MiB));f.select('a');const files=Object.keys(f.versions.a.frontend).filter(name=>name.startsWith('unique-')),physical=files.reduce((n,name)=>n+fs.statSync(path.join(f.roots.frontend,name)).size,0),hashes=new Set(files.map(name=>sha(fs.readFileSync(path.join(f.roots.frontend,name)))));assert.equal(hashes.size,33);assert.equal(physical,264*MiB);assert.ok(physical<512*MiB);assert.throws(()=>f.engine.initialize(),error=>error.code==='release_size_limit');assert.equal(fs.existsSync(path.join(f.store,'state.json')),false);assert.equal(fs.existsSync(path.join(f.store,'deployment.lock')),false);f.assertDatabase();
});

test('missing corrupt mismatched and non-private later blobs refuse rollback before any source write',posix,async t=>{
 for(const kind of ['missing','corrupt-gzip','wrong-content','public-mode','symlink'])await t.test(kind,t=>{
  const f=fixture(t),{a,b}=two(f),file=f.raw(a).files.find(file=>file.area==='web'&&file.name==='version.txt'),target=blob(f,file);assert.ok(file);assert.notEqual(file.sha256,f.raw(b).files.find(file=>file.area==='web'&&file.name==='version.txt').sha256);
  if(kind==='missing')fs.unlinkSync(target);if(kind==='corrupt-gzip')privateWrite(target,Buffer.from('not gzip'));if(kind==='wrong-content')privateWrite(target,zlib.gzipSync(Buffer.from('other bytes')));if(kind==='public-mode')fs.chmodSync(target,0o644);if(kind==='symlink'){fs.unlinkSync(target);fs.symlinkSync(f.dbFile,target);}
  assertRefused(f,a,b);
 });
});

test('a symlinked blob directory never permits reading or restoring external private files',posix,t=>{
 const f=fixture(t),{a,b}=two(f),directory=path.join(f.store,'blobs'),elsewhere=path.join(f.base,'outside-blobs');fs.renameSync(directory,elsewhere);fs.symlinkSync(elsewhere,directory,'dir');const before=rootsSnapshot(f),state=f.state();f.calls.length=0;assert.throws(()=>f.engine.prepare({requestId,target:a,mode:'rollback'}));assert.deepEqual(rootsSnapshot(f),before);assert.deepEqual(f.state(),state);assert.equal(f.state().current,b);noSourceCommands(f);assert.equal(fs.existsSync(path.join(f.store,'deployment.lock')),false);f.assertDatabase();
});

test('v2 metadata digest schema duplicate paths and traversal are verified before source writes',posix,async t=>{
 for(const kind of ['revision','hash','size','extra-data','duplicate','traversal'])await t.test(kind,t=>{
  const f=fixture(t),{a,b}=two(f),value=f.raw(a);if(kind==='revision')value.frontendCommit='f'.repeat(40);if(kind==='hash')value.files.at(-1).sha256='f'.repeat(64);if(kind==='size')value.files.at(-1).bytes++;if(kind==='extra-data')value.files[0].data='eA==';if(kind==='duplicate')value.files.push({...value.files[0]});if(kind==='traversal')value.files.at(-1).name='../outside.js';indexWrite(f,a,value);assertRefused(f,a,b);assert.equal(fs.existsSync(path.join(f.base,'outside.js')),false);
 });
});

test('a real decompressed v2 index larger than 16 MiB cannot be loaded',posix,t=>{
 const f=fixture(t),{a,b}=two(f),value=f.raw(a);value.padding='x'.repeat(16*MiB);const raw=Buffer.from(JSON.stringify(value));assert.ok(raw.length>16*MiB);privateWrite(path.join(f.store,a,'source.json.gz'),zlib.gzipSync(raw));assertRefused(f,a,b,error=>error.code==='invalid_release_archive');
});

test('self-consistent indexes cannot smuggle excluded credential paths into a source rollback',posix,async t=>{
 for(const name of ['db.json','.env.production','keys/private.pem','private-credentials.json','backups/account.json'])await t.test(name,t=>{
  const f=fixture(t),{a,b}=two(f),value=f.raw(a);value.files.at(-1).name=name;const identity={backendCommit:value.backendCommit,frontendCommit:value.frontendCommit,runtimeProof:value.runtimeProof,proof:value.proof,operationsProof:value.operationsProof,files:value.files};value.id=value.backendCommit+'-'+sha(JSON.stringify(identity));fs.mkdirSync(path.join(f.store,value.id),{mode:0o700});indexWrite(f,value.id,value);assertRefused(f,value.id,b,error=>error.code==='invalid_release_archive');f.assertDatabase();
 });
});

test('legacy v1 inline archives retain their identity and bytes through verification and exact rollback',posix,t=>{
 const f=fixture(t),a=f.engine.initialize().id,value=f.raw(a),legacy={...value,version:1,files:value.files.map(file=>({...file,data:zlib.gunzipSync(fs.readFileSync(blob(f,file))).toString('base64')}))};privateWrite(path.join(f.store,a,'source.json.gz'),zlib.gzipSync(Buffer.from(JSON.stringify(legacy))));const sourceBytes=fs.readFileSync(path.join(f.store,a,'source.json.gz')),manifestBytes=fs.readFileSync(path.join(f.store,a,'manifest.json'));fs.rmSync(path.join(f.store,'blobs'),{recursive:true});const original=rootsSnapshot(f);f.select('b');f.engine.initialize();assert.equal(f.engine.inventory().releases.find(row=>row.id===a).compatible,true);f.engine.prepare({requestId,target:a,mode:'rollback'});assert.deepEqual(rootsSnapshot(f),original);f.engine.finish({requestId,healthy:true});assert.equal(f.state().current,a);assert.equal(f.state().phase,'complete');assert.deepEqual(fs.readFileSync(path.join(f.store,a,'source.json.gz')),sourceBytes);assert.deepEqual(fs.readFileSync(path.join(f.store,a,'manifest.json')),manifestBytes);assert.equal(f.raw(a).version,1);f.assertDatabase();
});

test('legacy v1 retains its original 256 MiB logical cap with actual inline payloads',posix,async t=>{
 const f=fixture(t),seed=f.addSeed('legacy-logical',Buffer.alloc(8*MiB,83));for(let i=0;i<17;i++){f.versions.a.frontend['asset-'+i+'.png']=seed;f.versions.a.web['asset-'+i+'.png']=seed;}f.select('a');const a=f.engine.initialize().id,value=f.raw(a);assert.ok(value.files.reduce((n,file)=>n+file.bytes,0)>256*MiB);f.select('b');const b=f.engine.initialize().id;
 // Stream real legacy payloads to disk, so this oracle does not itself build
 // the all-base64 archive that the production fix is meant to eliminate.
 const file=path.join(f.store,a,'source.json.gz'),out=fs.createWriteStream(file,{mode:0o600}),gzip=zlib.createGzip();gzip.pipe(out);const finished=once(out,'close'),write=async text=>{if(!gzip.write(text))await once(gzip,'drain');};const head={...value,version:1};delete head.files;await write(JSON.stringify(head).slice(0,-1)+',"files":[');for(let i=0;i<value.files.length;i++){const entry=value.files[i],raw=zlib.gunzipSync(fs.readFileSync(blob(f,entry)));await write((i?',':'')+JSON.stringify({...entry,data:raw.toString('base64')}));}gzip.end(']}');await finished;assertRefused(f,a,b,error=>error.code==='invalid_release_archive');
});

test('the database backup cap remains 256 MiB and refuses an oversized physical JSON file',posix,t=>{
 const f=fixture(t);f.engine.initialize();const fd=fs.openSync(f.dbFile,'w'),block=Buffer.alloc(8*MiB,32);try{fs.writeSync(fd,'{"users":{},"private":{},"shared":{}}');for(let i=0;i<33;i++)fs.writeSync(fd,block);}finally{fs.closeSync(fd);}assert.ok(fs.statSync(f.dbFile).size>256*MiB);assert.throws(()=>f.engine.beforeExternal('kolonie-kepler7'));assert.equal(fs.existsSync(path.join(f.store,'deployment.lock')),false);assert.equal(fs.existsSync(path.join(f.store,'backups')),false);assert.equal(f.state().phase,'complete');assert.ok(fs.statSync(f.dbFile).size>256*MiB);
});

test('postdeploy capture failure records uncertainty and releases only its own external lock',posix,t=>{
 const f=fixture(t),id=f.engine.initialize().id,input=f.engine.beforeExternal('kolonie-kepler7');const backupFile=path.join(f.store,'backups',input.requestId+'.db.json.gz'),backupBytes=fs.readFileSync(backupFile),large=path.join(f.roots.web,'oversized.png');fs.writeFileSync(large,Buffer.alloc(16*MiB+1));assert.throws(()=>f.engine.afterExternal({requestId:input.requestId,success:true}));const state=f.state();assert.equal(state.phase,'external-unconfirmed');assert.equal(state.current,id);assert.equal(state.requestId,input.requestId);assert.equal(state.backup.verified,true);assert.equal(fs.existsSync(path.join(f.store,'deployment.lock')),false);assert.deepEqual(fs.readFileSync(backupFile),backupBytes);assert.equal(fs.statSync(large).size,16*MiB+1);f.assertDatabase();
});

test('a postdeploy result cannot release a foreign action UUID or phase reservation',posix,async t=>{
 for(const kind of ['uuid','action','phase'])await t.test(kind,t=>{
  const f=fixture(t);f.engine.initialize();const input=f.engine.beforeExternal('kolonie-kepler7'),lockFile=path.join(f.store,'deployment.lock');if(kind==='uuid')privateWrite(lockFile,{requestId:otherId,action:'external-deploy'});if(kind==='action')privateWrite(lockFile,{requestId:input.requestId,action:'release-switch'});if(kind==='phase')privateWrite(path.join(f.store,'state.json'),{...f.state(),phase:'applying'});const state=fs.readFileSync(path.join(f.store,'state.json')),lock=fs.readFileSync(lockFile);assert.throws(()=>f.engine.afterExternal({requestId:input.requestId,success:false}),error=>error.code===(kind==='uuid'?'deployment_busy':'invalid_release_state'));assert.deepEqual(fs.readFileSync(path.join(f.store,'state.json')),state);assert.deepEqual(fs.readFileSync(lockFile),lock);f.assertDatabase();
 });
});

test('an interrupted complete external transaction can release only after exact source readback',posix,async t=>{
 for(const kind of ['same','changed-id','changed-engine'])await t.test(kind,t=>{
  const f=fixture(t);f.engine.initialize();const input=f.engine.beforeExternal('kolonie-kepler7');f.select('b');const completed=f.engine.afterExternal({requestId:input.requestId,success:true});assert.equal(completed.archived,true);const complete=f.state();assert.equal(complete.phase,'complete');assert.equal(complete.requestId,input.requestId);assert.equal(complete.backup.verified,true);const lockFile=path.join(f.store,'deployment.lock');privateWrite(lockFile,{requestId:input.requestId,action:'external-deploy'});
  if(kind==='changed-id')fs.writeFileSync(path.join(f.roots.web,'index.html'),'<html>unverified later bytes</html>');
  if(kind==='changed-engine'){
   fs.appendFileSync(path.join(f.roots.backend,'operations-release-engine.cjs'),'\n// another engine revision\n');
   // Its real archive ID now matches the live source: only the provider's
   // different engine hash can refuse this interrupted transaction.
   fs.unlinkSync(lockFile);const published=f.engine.publish();privateWrite(path.join(f.store,'state.json'),{...complete,current:published.id});privateWrite(lockFile,{requestId:input.requestId,action:'external-deploy'});
  }
  const expectedState=f.state();if(kind==='same'){assert.deepEqual(f.engine.afterExternal({requestId:input.requestId,success:true}),{archived:true,id:completed.id});assert.equal(fs.existsSync(lockFile),false);}else{assert.throws(()=>f.engine.afterExternal({requestId:input.requestId,success:true}),error=>error.code==='release_readback_failed');assert.equal(fs.existsSync(lockFile),true);}assert.deepEqual(f.state(),expectedState);f.assertDatabase();
 });
});

test('external rollback restores only source and revisions and preserves newer database and backup bytes',posix,async t=>{
 for(const released of [false,true])await t.test(released?'released-unconfirmed-slot':'held-external-slot',t=>{
  const f=fixture(t),id=f.engine.initialize().id,original=rootsSnapshot(f),input=f.engine.beforeExternal('kolonie-kepler7'),backupFile=path.join(f.store,'backups',input.requestId+'.db.json.gz'),backupBytes=fs.readFileSync(backupFile);f.select('b');if(released)f.engine.afterExternal({requestId:input.requestId,success:false});const newer=Buffer.from(JSON.stringify({users:{newPlayer:{}},private:{later:true},shared:{tick:9}}));privateWrite(f.dbFile,newer);
  assert.deepEqual(f.engine.abortExternal({requestId:input.requestId}),{restored:true,restartRequired:true,backupVerified:true});assert.deepEqual(rootsSnapshot(f),original);assert.equal(f.current.backend,'a');assert.equal(f.current.frontend,'a');assert.equal(f.state().phase,'external-rollback-pending');assert.equal(f.state().current,id);assert.equal(JSON.parse(fs.readFileSync(path.join(f.store,'deployment.lock'))).requestId,input.requestId);assert.deepEqual(fs.readFileSync(f.dbFile),newer);assert.deepEqual(fs.readFileSync(backupFile),backupBytes);
  assert.deepEqual(f.engine.completeExternalRollback({requestId:input.requestId,healthy:true}),{health:true,archiveCompatible:true,rolledBack:true,backupVerified:true});assert.equal(f.state().phase,'complete');assert.equal(fs.existsSync(path.join(f.store,'deployment.lock')),false);assert.deepEqual(fs.readFileSync(f.dbFile),newer);assert.deepEqual(fs.readFileSync(backupFile),backupBytes);
 });
});

test('external rollback rejects malformed inputs foreign locks and mismatched state without changes',posix,async t=>{
 for(const kind of ['extra','bad-uuid','foreign-lock','wrong-action','wrong-phase','wrong-state-uuid','missing-held-lock'])await t.test(kind,t=>{
  const f=fixture(t);f.engine.initialize();const input=f.engine.beforeExternal('kolonie-kepler7'),lockFile=path.join(f.store,'deployment.lock');let call={requestId:input.requestId};if(kind==='extra')call.confirmed=true;if(kind==='bad-uuid')call.requestId='bad';if(kind==='foreign-lock')privateWrite(lockFile,{requestId:otherId,action:'external-deploy'});if(kind==='wrong-action')privateWrite(lockFile,{requestId:input.requestId,action:'release-switch'});if(kind==='wrong-phase')privateWrite(path.join(f.store,'state.json'),{...f.state(),phase:'complete'});if(kind==='wrong-state-uuid')privateWrite(path.join(f.store,'state.json'),{...f.state(),requestId:otherId});if(kind==='missing-held-lock')fs.unlinkSync(lockFile);const before=rootsSnapshot(f),state=fs.readFileSync(path.join(f.store,'state.json')),lock=fs.existsSync(lockFile)?fs.readFileSync(lockFile):null;assert.throws(()=>f.engine.abortExternal(call),error=>error.code===(kind==='extra'||kind==='bad-uuid'?'invalid_request':kind==='foreign-lock'?'deployment_busy':'invalid_release_state'));assert.deepEqual(rootsSnapshot(f),before);assert.deepEqual(fs.readFileSync(path.join(f.store,'state.json')),state);assert.deepEqual(fs.existsSync(lockFile)?fs.readFileSync(lockFile):null,lock);f.assertDatabase();
 });
});

test('a damaged external rollback archive retains its own lock and never writes source',posix,t=>{
 const f=fixture(t),a=f.engine.initialize().id,input=f.engine.beforeExternal('kolonie-kepler7'),entry=f.raw(a).files.find(file=>file.area==='web'&&file.name==='index.html');f.select('b');privateWrite(blob(f,entry),zlib.gzipSync(Buffer.from('corrupt archived HTML')));const before=rootsSnapshot(f);f.calls.length=0;assert.throws(()=>f.engine.abortExternal({requestId:input.requestId}));assert.deepEqual(rootsSnapshot(f),before);noSourceCommands(f);assert.equal(f.state().phase,'external-rollback-unconfirmed');assert.equal(JSON.parse(fs.readFileSync(path.join(f.store,'deployment.lock'))).requestId,input.requestId);f.assertDatabase();
});

test('unhealthy or changed-source rollback readback keeps the matching reservation unconfirmed',posix,async t=>{
 for(const kind of ['unhealthy','changed-source'])await t.test(kind,t=>{
  const f=fixture(t);f.engine.initialize();const input=f.engine.beforeExternal('kolonie-kepler7');f.select('b');f.engine.abortExternal({requestId:input.requestId});if(kind==='changed-source')fs.writeFileSync(path.join(f.roots.web,'index.html'),'unverified new source');if(kind==='unhealthy')assert.deepEqual(f.engine.completeExternalRollback({requestId:input.requestId,healthy:false}),{health:false,archiveCompatible:false,rolledBack:true,backupVerified:true});else assert.throws(()=>f.engine.completeExternalRollback({requestId:input.requestId,healthy:true}),error=>error.code==='release_readback_failed');assert.equal(f.state().phase,'external-rollback-unconfirmed');assert.equal(JSON.parse(fs.readFileSync(path.join(f.store,'deployment.lock'))).requestId,input.requestId);f.assertDatabase();
 });
});

test('a genuine old-engine archive can restore source but cannot declare the new provider compatible',posix,t=>{
 const f=fixture(t),old=execFileSync('git',['show','f5d26daecce85d6a85fde3baa8a4d4c8d81ada52:operations-release-engine.cjs'],{cwd:path.resolve(path.dirname(engineFile())),maxBuffer:2*MiB});assert.notEqual(sha(old),sha(fs.readFileSync(engineFile())));f.versions.a.backend['operations-release-engine.cjs']=old;f.select('a');const a=f.engine.initialize().id,input=f.engine.beforeExternal('kolonie-kepler7');f.select('b');f.engine.afterExternal({requestId:input.requestId,success:false});f.engine.abortExternal({requestId:input.requestId});assert.deepEqual(fs.readFileSync(path.join(f.roots.backend,'operations-release-engine.cjs')),old);assert.deepEqual(f.engine.completeExternalRollback({requestId:input.requestId,healthy:true}),{health:true,archiveCompatible:false,rolledBack:true,backupVerified:true});assert.equal(f.state().current,a);assert.equal(f.state().phase,'external-unconfirmed');assert.equal(fs.existsSync(path.join(f.store,'deployment.lock')),false);assert.equal(f.engine.inventory().releaseSwitch,false);f.assertDatabase();
});

test('a prewritten external UUID is used exactly and malformed preparation options acquire no slot',posix,async t=>{
 await t.test('exact UUID',t=>{const f=fixture(t);f.engine.initialize();const input=f.engine.beforeExternal('kolonie-kepler7',{requestId});assert.equal(input.requestId,requestId);assert.equal(f.state().requestId,requestId);assert.equal(JSON.parse(fs.readFileSync(path.join(f.store,'deployment.lock'))).requestId,requestId);assert.equal(fs.existsSync(path.join(f.store,'backups',requestId+'.db.json.gz')),true);f.engine.afterExternal({requestId,success:false});f.assertDatabase();});
 for(const [kind,options]of [['null',null],['string',requestId],['missing',{}],['bad UUID',{requestId:'bad'}],['extra',{requestId,confirmed:true}]])await t.test(kind,t=>{const f=fixture(t);f.engine.initialize();const before=f.state();assert.throws(()=>f.engine.beforeExternal('kolonie-kepler7',options),error=>error.code==='invalid_request');assert.deepEqual(f.state(),before);assert.equal(fs.existsSync(path.join(f.store,'deployment.lock')),false);assert.equal(fs.existsSync(path.join(f.store,'backups')),false);f.assertDatabase();});
});

test('rollback completion rejects malformed or foreign transaction reservations without changes',posix,async t=>{
 for(const kind of ['extra','bad-uuid','missing-health','foreign-lock','wrong-action','wrong-phase','wrong-state-uuid'])await t.test(kind,t=>{
  const f=fixture(t);f.engine.initialize();const input=f.engine.beforeExternal('kolonie-kepler7');f.select('b');f.engine.abortExternal({requestId:input.requestId});let call={requestId:input.requestId,healthy:true};const lockFile=path.join(f.store,'deployment.lock');if(kind==='extra')call.confirmed=true;if(kind==='bad-uuid')call.requestId='bad';if(kind==='missing-health')delete call.healthy;if(kind==='foreign-lock')privateWrite(lockFile,{requestId:otherId,action:'external-deploy'});if(kind==='wrong-action')privateWrite(lockFile,{requestId:input.requestId,action:'release-switch'});if(kind==='wrong-phase')privateWrite(path.join(f.store,'state.json'),{...f.state(),phase:'external-deploy'});if(kind==='wrong-state-uuid')privateWrite(path.join(f.store,'state.json'),{...f.state(),requestId:otherId});const before=rootsSnapshot(f),state=fs.readFileSync(path.join(f.store,'state.json')),lock=fs.readFileSync(lockFile);assert.throws(()=>f.engine.completeExternalRollback(call),error=>error.code===(['extra','bad-uuid','missing-health'].includes(kind)?'invalid_request':kind==='foreign-lock'?'deployment_busy':'invalid_release_state'));assert.deepEqual(rootsSnapshot(f),before);assert.deepEqual(fs.readFileSync(path.join(f.store,'state.json')),state);assert.deepEqual(fs.readFileSync(lockFile),lock);f.assertDatabase();
 });
});

test('a crash before external state persistence can cancel only its own new lock and unchanged prior state',posix,async t=>{
 for(const kind of ['same','extra','bad-hash','foreign-lock','wrong-action','wrong-phase','same-state-uuid','changed-state'])await t.test(kind,t=>{
  const f=fixture(t);f.engine.initialize();const prior=f.engine.beforeExternal('kolonie-kepler7');f.engine.afterExternal({requestId:prior.requestId,success:false});const stateFile=path.join(f.store,'state.json'),priorStateSha256=sha(fs.readFileSync(stateFile)),lockFile=path.join(f.store,'deployment.lock');privateWrite(lockFile,{requestId,action:'external-deploy'});let call={requestId,priorStateSha256};if(kind==='extra')call.confirmed=true;if(kind==='bad-hash')call.priorStateSha256='bad';if(kind==='foreign-lock')privateWrite(lockFile,{requestId:otherId,action:'external-deploy'});if(kind==='wrong-action')privateWrite(lockFile,{requestId,action:'release-switch'});if(kind==='wrong-phase')privateWrite(stateFile,{...f.state(),phase:'complete'});if(kind==='same-state-uuid')privateWrite(stateFile,{...f.state(),requestId});if(kind==='changed-state')privateWrite(stateFile,{...f.state(),previous:'f'.repeat(40)+'-'+'f'.repeat(64)});const before=rootsSnapshot(f),state=fs.readFileSync(stateFile),lock=fs.readFileSync(lockFile),backupFile=path.join(f.store,'backups',prior.requestId+'.db.json.gz'),backupBytes=fs.readFileSync(backupFile);
  if(kind==='same'){assert.deepEqual(f.engine.cancelExternalPreparation(call),{cancelled:true});assert.equal(fs.existsSync(lockFile),false);}else{assert.throws(()=>f.engine.cancelExternalPreparation(call),error=>error.code===(kind==='extra'||kind==='bad-hash'?'invalid_request':kind==='foreign-lock'?'deployment_busy':'invalid_release_state'));assert.deepEqual(fs.readFileSync(lockFile),lock);}assert.deepEqual(rootsSnapshot(f),before);assert.deepEqual(fs.readFileSync(stateFile),state);assert.deepEqual(fs.readFileSync(backupFile),backupBytes);f.assertDatabase();
 });
});
