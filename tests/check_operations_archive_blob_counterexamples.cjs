'use strict';
// The negative input is the exact old engine, not a fake size or a replaced
// filesystem. Both children create and restore the same physical asset fixture.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),cp=require('node:child_process');
const root=path.resolve(__dirname,'..'),baseline='f5d26daecce85d6a85fde3baa8a4d4c8d81ada52';
const child=path.join(__dirname,'fixtures/operations-archive-bounded.cjs'),engine=path.join(root,'operations-release-engine.cjs');
const names=Object.freeze([
 'physical duplicated deployment exceeds 256 MiB logical bytes',
 'physical unique source bytes remain below 256 MiB',
 'bounded heap captures the complete duplicated deployment',
 'the captured v2 index contains metadata and no inline payload',
 'the index binds every physical source file and native revision',
 'one private blob is stored for each unique content hash',
 'every stored blob decodes to its original length and SHA256',
 'all content-addressed blobs are private regular files',
 'neither the database nor account bytes enter the source archive',
 'source-only rollback restores every original source and web byte',
 'healthy readback completes the switch with the original release identity',
 'the live database remains byte-identical throughout the archive attempt',
]);
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const inputs=['operations-release-engine.cjs','operations-release-guard.js','operations-admin.js','operations-health.js','server.js','tests/test_operations_releases.mjs','tests/test_operations_archive_blobs.mjs','tests/lib/release-archive-fixture.cjs','tests/fixtures/operations-archive-bounded.cjs','tests/check_operations_archive_blob_counterexamples.cjs'];
const hashes=()=>inputs.map(name=>({name,sha256:sha(fs.readFileSync(path.join(root,name)))}));
if(process.platform==='win32'){process.stderr.write('POSIX archive counterexamples require Linux; no guards were executed.\n');process.exitCode=2;}
else{
 const evidence=path.resolve(process.env.GG_RELEASE_EVIDENCE_DIR||path.join(root,'..','backend-release-archive-2026-10-13','archive-blobs-counter-'+new Date().toISOString().replace(/[:.]/g,'-')));
 fs.mkdirSync(evidence,{recursive:true,mode:0o700});const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'gg-old-release-engine-'));fs.chmodSync(temporary,0o700);
 const before=hashes(),proof={baseline,manifest:names,before,cases:[],complete:false};let failure=null;
 const invoke=(name,file,heap)=>{
  // NODE_OPTIONS is inherited by the engine's real streaming-index worker;
  // the CLI option alone would constrain only this parent fixture process.
  const argv=['--max-old-space-size='+heap,'--max-semi-space-size=8',child],env={...process.env,GG_RELEASE_ENGINE:file,NODE_OPTIONS:[process.env.NODE_OPTIONS,'--max-old-space-size='+heap,'--max-semi-space-size=8'].filter(Boolean).join(' ')};
  const started=Date.now(),result=cp.spawnSync(process.execPath,argv,{cwd:root,env,encoding:'utf8',timeout:300000,maxBuffer:32*1024*1024});
  fs.writeFileSync(path.join(evidence,name+'.stdout.log'),result.stdout||'',{mode:0o600});fs.writeFileSync(path.join(evidence,name+'.stderr.log'),result.stderr||'',{mode:0o600});
  const records=(result.stdout||'').split(/\r?\n/).filter(line=>line.startsWith('ARCHIVE_RECORD ')).map(line=>JSON.parse(line.slice(15)));
  const footers=(result.stdout||'').split(/\r?\n/).filter(line=>line.startsWith('ARCHIVE_COMPLETE ')).map(line=>JSON.parse(line.slice(17)));
  const row={name,argv,nodeOptions:env.NODE_OPTIONS,source:{file,sha256:sha(fs.readFileSync(file))},heapMiB:heap,status:result.status,signal:result.signal,error:result.error?String(result.error):null,elapsedMs:Date.now()-started,records,footers,stdoutSHA:sha(result.stdout||''),stderrSHA:sha(result.stderr||'')};proof.cases.push(row);
  assert.equal(row.error,null,name+' process exception');assert.equal(row.signal,null,name+' signal');assert.deepEqual(records.map(record=>record.name),names,name+' full guard order');assert.equal(records.every(record=>typeof record.ok==='boolean'),true,name+' boolean guards');assert.equal(footers.length,1,name+' one complete footer');assert.equal(footers[0].complete,true,name+' complete footer');assert.equal(footers[0].checks,names.length,name+' guard count');assert.deepEqual(footers[0].names,names,name+' footer order');assert.deepEqual(footers[0].failures,records.filter(record=>!record.ok).map(record=>record.name),name+' actual failed-name set');return row;
 };
 try{
  const old=cp.execFileSync('git',['show',baseline+':operations-release-engine.cjs'],{cwd:root,maxBuffer:2*1024*1024});
  const oldFile=path.join(temporary,'operations-release-engine.cjs');fs.writeFileSync(oldFile,old,{mode:0o600});fs.writeFileSync(path.join(evidence,'old-f5-engine.cjs'),old,{mode:0o600});proof.oldSourceSHA=sha(old);
  const positive=invoke('normal-bounded-128',engine,128);assert.equal(positive.status,0,'new bounded heap exits successfully');assert.deepEqual(positive.footers[0].failures,[],'all twelve positive guards');assert.equal(positive.footers[0].error,null,'positive has no swallowed error');assert.ok(positive.footers[0].heapLimit<160*1024*1024,'actual bounded JS heap');
  const negative=invoke('old-f5-512',oldFile,512);assert.equal(negative.status,1,'old engine exits with guard failures');assert.deepEqual(negative.footers[0].failures,names.slice(2,11),'exact old engine failures');assert.equal(negative.footers[0].error?.code,'release_size_limit','old native size failure, not OOM/timeout');
  proof.complete=true;process.stdout.write('Archive blobs: complete 12/0 at 128 MiB; old f5 complete 12/exact9.\n');
 }catch(error){failure=error;proof.error={message:error.message,stack:error.stack};process.exitCode=1;}
 finally{proof.after=hashes();try{assert.deepEqual(proof.after,before,'all archive source/test inputs remain byte-identical');proof.frozen=true;}catch(error){proof.frozen=false;proof.hashError=error.message;failure=failure||error;process.exitCode=1;}fs.writeFileSync(path.join(evidence,'proof.json'),JSON.stringify(proof,null,2)+'\n',{mode:0o600});fs.rmSync(temporary,{recursive:true,force:true});process.stdout.write('Evidence: '+path.join(evidence,'proof.json')+'\n');}
 if(failure)process.stderr.write(failure.stack+'\n');
}
