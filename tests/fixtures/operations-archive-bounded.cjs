'use strict';
// Physical input, not a mocked stat/size: 18 different 8-MiB assets appear in
// both the frontend checkout and web directory. The old inline-base64 archive
// exceeds its 256-MiB logical cap; v2 stores each identical pair only once.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),zlib=require('node:zlib'),v8=require('node:v8');
const {fixture,sha}=require('../lib/release-archive-fixture.cjs');
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
const records=[],f=fixture(),requestId='7f3e20bc-a14d-4e8b-a769-5839d3a98b72';
const record=(name,ok,detail)=>{const value={name,ok:ok===true,detail};records.push(value);process.stdout.write('ARCHIVE_RECORD '+JSON.stringify(value)+'\n');};
const snapshot=()=>{const files=[];for(const [area,root]of Object.entries(f.roots)){const visit=(dir,prefix='')=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const name=prefix+entry.name,p=path.join(dir,entry.name);if(entry.isDirectory())visit(p,name+'/');else {const raw=fs.readFileSync(p);files.push({area,name,bytes:raw.length,sha256:sha(raw)});}}};visit(root);}return files.sort((a,b)=>(a.area+'\0'+a.name).localeCompare(b.area+'\0'+b.name));};
let archive=null,id=null,initial=[],error=null,restored=false,completed=false,blobRows=[];
try{
 for(let i=0;i<18;i++){const seed=f.addSeed('asset-'+i,crypto.randomBytes(8*1024*1024));f.versions.a.frontend['assets/asset-'+i+'.png']=seed;f.versions.a.web['assets/asset-'+i+'.png']=seed;}
 f.select('a');initial=snapshot();const logical=initial.reduce((n,row)=>n+row.bytes,0),unique=[...new Map(initial.map(row=>[row.sha256,row])).values()].reduce((n,row)=>n+row.bytes,0);
 record(names[0],logical>256*1024*1024&&logical<=512*1024*1024,{logical});
 record(names[1],unique<256*1024*1024&&unique>128*1024*1024,{unique});
 try{id=f.engine.initialize().id;archive=f.raw(id);}catch(e){error={code:e.code||null,message:e.message};}
 record(names[2],!!archive&&archive.id===id,{id,error,heapLimit:v8.getHeapStatistics().heap_size_limit,maxRSS:process.resourceUsage().maxRSS});
 record(names[3],!!archive&&archive.version===2&&archive.files.every(row=>Object.keys(row).sort().join(',')==='area,bytes,name,sha256'&&!Object.hasOwn(row,'data')),{version:archive?.version,files:archive?.files.length});
 const normalized=archive?.files.map(row=>({area:row.area,name:row.name,bytes:row.bytes,sha256:row.sha256})).sort((a,b)=>(a.area+'\0'+a.name).localeCompare(b.area+'\0'+b.name));
 record(names[4],!!archive&&JSON.stringify(normalized)===JSON.stringify(initial)&&archive.backendCommit===f.versions.a.backendCommit&&archive.frontendCommit===f.versions.a.frontendCommit,{physicalFiles:initial.length,indexFiles:archive?.files.length});
 if(archive){const dir=path.join(f.store,'blobs');if(fs.existsSync(dir))blobRows=fs.readdirSync(dir).map(name=>({name,file:path.join(dir,name)}));}
 const expectedHashes=[...new Set(initial.map(row=>row.sha256))].sort(),actualHashes=blobRows.map(row=>row.name.replace(/\.gz$/,'')).sort();
 record(names[5],!!archive&&JSON.stringify(expectedHashes)===JSON.stringify(actualHashes),{stored:actualHashes.length,unique:expectedHashes.length});
 let exact=!!archive&&blobRows.length>0,privateFiles=exact;
 for(const row of blobRows){const st=fs.lstatSync(row.file);privateFiles=privateFiles&&st.isFile()&&!st.isSymbolicLink()&&(st.mode&0o777)===0o600;try{const raw=zlib.gunzipSync(fs.readFileSync(row.file)),expected=initial.find(file=>file.sha256===sha(raw));exact=exact&&!!expected&&expected.bytes===raw.length&&row.name===sha(raw)+'.gz';}catch{exact=false;}}
 record(names[6],exact,{stored:blobRows.length});record(names[7],privateFiles,{stored:blobRows.length});
 record(names[8],!!archive&&!archive.files.some(row=>row.name==='db.json')&&!JSON.stringify(archive).includes('private account data')&&!blobRows.some(row=>row.name===sha(f.database)+'.gz'),{files:archive?.files.length});
 if(archive){try{f.select('b');f.engine.initialize();f.engine.prepare({requestId,target:id,mode:'rollback'});restored=JSON.stringify(snapshot())===JSON.stringify(initial);f.engine.finish({requestId,healthy:true});const state=f.state();completed=state.current===id&&state.phase==='complete'&&!fs.existsSync(path.join(f.store,'deployment.lock'))&&zlib.gunzipSync(fs.readFileSync(path.join(f.store,'backups',requestId+'.db.json.gz'))).equals(f.database);}catch(e){error={code:e.code||null,message:e.message};}}
 record(names[9],restored,{error});record(names[10],completed,{error});record(names[11],fs.readFileSync(f.dbFile).equals(f.database),{});
}catch(e){error={code:e.code||null,message:e.message,stack:e.stack};while(records.length<names.length)record(names[records.length],false,{aborted:error});}
finally{f.clean();}
const footer={names,checks:records.length,failures:records.filter(row=>!row.ok).map(row=>row.name),error,heapLimit:v8.getHeapStatistics().heap_size_limit,maxRSS:process.resourceUsage().maxRSS,complete:records.length===names.length};
process.stdout.write('ARCHIVE_COMPLETE '+JSON.stringify(footer)+'\n');process.exitCode=footer.failures.length?1:0;
