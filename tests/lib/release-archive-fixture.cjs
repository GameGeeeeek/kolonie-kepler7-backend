'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),zlib=require('node:zlib');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const engineFile=()=>path.resolve(process.env.GG_RELEASE_ENGINE||path.join(__dirname,'../../operations-release-engine.cjs'));
const source=`function loadDb() { return JSON.parse(readFileSync(DB_FILE, 'utf8')); }
function performDbWrite(db) { writeFileSync(DB_FILE, JSON.stringify(db)); }
function authMiddleware(req) { return req.session && findUserById(req.session.userId); }
function findUserById(id) { return db.users[id]; }
const opsHealth = require('./operations-health').createOperationalHealth({ dbFile: DB_FILE });
let operationsAdminBridge = null;
require('./operations-admin').installOperationsAdmin({ dbFile: DB_FILE, getDb: () => db, saveDb, opsHealth,
  deployBackend: () => starteDeploy('kolonie-kepler7-backend', DEPLOY_TARGETS['kolonie-kepler7-backend'].command, DEPLOY_TARGETS['kolonie-kepler7-backend'].dir)
}).then(server => { operationsAdminBridge = server; });
function starteDeploy(repoName, command, dir) { require('./operations-release-guard').exec(repoName, command, {}, () => {}); }
function ankuendigungAktuell(jetzt) { return operationsAdminBridge && operationsAdminBridge.announcement(jetzt || Date.now()); }
`;
function fixture(t){
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'gg-archive-v2-'));fs.chmodSync(base,0o700);if(t)t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
 const roots=Object.fromEntries(['backend','frontend','web'].map(area=>{const dir=path.join(base,area);fs.mkdirSync(dir,{mode:0o755});return [area,dir];}));
 const store=path.join(base,'private-archives'),dbFile=path.join(base,'db.json'),database=Buffer.from(JSON.stringify({users:{pilot:{value:'private account data'}},private:{score:4},shared:{tick:7}}));fs.writeFileSync(dbFile,database,{mode:0o600});
 const versions=Object.fromEntries(['a','b'].map((name,i)=>[name,{backendCommit:String(i+1).repeat(40),frontendCommit:String(i+4).repeat(40),backend:{'server.js':source+`const release='${name}';`,'operations-admin.js':'exports.installOperationsAdmin=()=>{};','operations-health.js':'exports.createOperationalHealth=()=>{};','operations-release-guard.js':'exports.exec=()=>{};','operations-release-engine.cjs':fs.readFileSync(engineFile())},frontend:{'app.js':`const release='${name}';`},web:{'index.html':`<html>${name}</html>`,'version.txt':`test-${name}`}}]));
 const current={},calls=[],valueBytes=value=>value&&typeof value==='object'&&value.from?fs.readFileSync(value.from):Buffer.from(value);
 const select=name=>{for(const area of Object.keys(roots)){for(const name of fs.readdirSync(roots[area]))fs.rmSync(path.join(roots[area],name),{recursive:true,force:true});current[area]=name;for(const [file,value]of Object.entries(versions[name][area])){const to=path.join(roots[area],file);fs.mkdirSync(path.dirname(to),{recursive:true,mode:0o755});if(value&&typeof value==='object'&&value.from)fs.copyFileSync(value.from,to);else fs.writeFileSync(to,value,{mode:0o644});fs.chmodSync(to,0o644);}}};
 const run=(command,args)=>{if(command!=='/usr/bin/git')throw Error('unexpected command');const j=args.indexOf('-C'),area=Object.keys(roots).find(a=>roots[a]===args[j+1]),op=args.slice(j+2);calls.push({area,op});const v=versions[current[area]];
  if(op[0]==='diff'||op[0]==='status')return '';
  if(op[0]==='rev-parse')return v[area+'Commit']+'\n';
  if(op[0]==='ls-files')return Object.keys(v[area]).join('\0')+'\0';
  if(op[0]==='cat-file'){if(op[1]==='-e')return '';const at=op[2].indexOf(':'),commit=op[2].slice(0,at),name=op[2].slice(at+1),version=Object.values(versions).find(v=>v[area+'Commit']===commit);return valueBytes(version[area][name]);}
  if(op[0]==='ls-tree'){if(op[1]==='-r'){const version=Object.values(versions).find(v=>v[area+'Commit']===op.at(-1));return Object.keys(version[area]).join('\0')+'\0';}return '100644 blob '+'a'.repeat(40)+'\t'+op.at(-1)+'\n';}
  if(op[0]==='read-tree')return '';
  if(op[0]==='update-ref'){current[area]=Object.keys(versions).find(n=>versions[n][area+'Commit']===op[2]);return '';}
  throw Error('unexpected git operation '+op[0]);
 };
 select('a');const module=require(engineFile()),engine=module.createReleaseEngine({roots,store,dbFile,run});
 const raw=id=>JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(store,id,'source.json.gz'))));
 const state=()=>JSON.parse(fs.readFileSync(path.join(store,'state.json')));
 const addSeed=(name,bytes)=>{const dir=path.join(base,'seeds');fs.mkdirSync(dir,{recursive:true,mode:0o700});const seed=path.join(dir,name);fs.writeFileSync(seed,bytes,{mode:0o600});return {from:seed};};
 return {base,roots,store,dbFile,database,versions,current,calls,engine,module,raw,state,select,addSeed,sha,valueBytes,
  assertDatabase(){if(!fs.readFileSync(dbFile).equals(database))throw Error('database changed');},
  clean(){fs.rmSync(base,{recursive:true,force:true});}};
}
module.exports={fixture,engineFile,sha};
