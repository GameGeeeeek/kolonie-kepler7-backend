'use strict';
// Isolated genuine native command copies; every case must finish the same complete guard list.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..'),SERVER=path.join(ROOT,'server.js');
const source=fs.readFileSync(SERVER,'utf8');
const loop=' && (for f in kepler-gfx-*.webp; do if [ -e "$f" ] || [ -L "$f" ]; then [ -f "$f" ] && [ -s "$f" ] && [ ! -d "/deploy/web/$f" ] && cp -- "$f" "/deploy/web/$f" || exit 1; fi; done)';
assert.equal(source.split(loop).length,2,'unique native WebP copy block');
const guards=[
 'vorab: der native Web-Deploybefehl ist aus server.js lesbar',
 '1a: vorhandene WebP-Grafiken werden regulaer ausgeliefert',
 '1b: die erste WebP-Grafik wird bytegenau kopiert',
 '1c: die zweite WebP-Grafik wird bytegenau kopiert',
 '1d: der PNG-Fallback bleibt bytegenau erhalten',
 '1e: weder WebP noch PNG erhaelt eine gzip-Datei',
 '1f: fremde WebP- und JSON-Dateien werden nicht mitveroeffentlicht',
 '1g: die bisherigen Textdateien bleiben korrekt komprimiert',
 '2a: der aktualisierte WebP-Bestand wird regulaer ausgeliefert',
 '2b: die erste WebP-Zieldatei enthaelt den neuen Inhalt',
 '2c: die zweite WebP-Zieldatei enthaelt den neuen Inhalt',
 '3a: ein altes Frontend ohne WebP-Grafiken bleibt deploybar',
 '3b: dessen normale Textdateien bleiben komprimiert',
 '3c: dessen vorhandener PNG-Fallback bleibt erhalten',
 '4a: ein wirklicher WebP-Kopierfehler bricht regulaer ab',
 '4b: der wirkliche WebP-Kopierfehler bleibt im Protokoll',
 '4c: der fehlgeschlagene Kopierversuch ersetzt keinen alten Bildinhalt',
 '4d: nach dem WebP-Kopierfehler beginnt die Textkompression nicht',
 '5a: ein vorhandener WebP-Quellpfad als Verzeichnis bricht ab',
 '5b: ein Quellverzeichnis wird nicht als Bild veroeffentlicht',
 '6a: eine vorhandene leere WebP-Quelldatei bricht ab',
 '6b: eine leere Quelldatei wird nicht als Bild veroeffentlicht',
 '7a: ein WebP-Zielpfad als Verzeichnis bricht ab',
 '7b: eine Grafik wird nicht unbemerkt in ein Zielunterverzeichnis kopiert',
 '8a: ein nur fuer WebP scheiterndes gzip wird nie aufgerufen',
 '8b: das Protokoll bestaetigt keinen WebP-gzip-Aufruf'
];
const byId=(...ids)=>guards.filter(name=>ids.some(id=>name.startsWith(id+':')));
const frozen=['server.js','operations-release-guard.js','operations-release-engine.cjs','operations-admin.js','operations-health.js',
 'tests/test_deploy_gzip.js','tests/check_deploy_language_counterexamples.cjs','tests/test_deploy_webp.js','tests/check_deploy_webp_counterexamples.cjs'];
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT,file))).digest('hex');
const initial=frozen.map(hash);
function run(file,expected,name){
 const r=spawnSync(process.execPath,['tests/test_deploy_webp.js'],{cwd:ROOT,env:{...process.env,KEPLER_BACKEND_SERVER:file},
  encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024});
 const output=r.stdout||'';
 console.log('\nBEGIN '+name+'\n'+output.trim()+'\nEND '+name);
 assert.equal(r.error,undefined,'child error');assert.equal(r.signal,null,'child was signalled');
 assert.equal((r.stderr||'').trim(),'','unexpected child stderr:\n'+r.stderr);
 assert.equal(r.status,expected.length?1:0,'genuine child exit status:\n'+output);
 const records=output.split(/\r?\n/).flatMap(line=>{const m=/^(OK\s*|FAIL)\s+-\s+(.+?)(?: \| |$)/.exec(line);return m?[{name:m[2],ok:m[1].trim()==='OK'}]:[]});
 assert.deepEqual(records.map(r=>r.name),guards,'complete identical guard manifest/order');
 assert.deepEqual(records.filter(r=>!r.ok).map(r=>r.name),expected,'exact intended failed guards only');
 assert.deepEqual(output.split(/\r?\n/).filter(line=>/^\d+ Pruefungen, \d+ fehlgeschlagen$/.test(line)),
  [guards.length+' Pruefungen, '+expected.length+' fehlgeschlagen'],'complete final summary');
 assert.equal(output.trim().split(/\r?\n/).at(-1),expected.length?'FEHLGESCHLAGEN':'Alles gruen','final test result');
 return {name,guards:records,expected_failures:expected,status:r.status};
}
const results=[run(SERVER,[],'normal')];
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'kepler-deploy-webp-counter-'));
try{
 const failBoundary='cp -- "$f" "/deploy/web/$f" || exit 1';
 const gzipLine=source.match(/^const DEPLOY_WEB_GZIP_DATEIEN = .*$/m)?.[0];assert(gzipLine);
 const cases=[
  ['webp-copy-omitted','',byId('1b','1c','2b','2c','4a','4b','4d','5a','6a','7a')],
  ['webp-copy-fail-open',loop.replace(failBoundary,'cp -- "$f" "/deploy/web/$f" || true'),byId('4a','4d','5a','6a','7a')],
  ['webp-copy-broad-pattern',loop.replace('in kepler-gfx-*.webp','in *.webp'),byId('1f')],
  ['webp-empty-allowed',loop.replace('[ -s "$f" ] && ',''),byId('6a','6b')],
  ['webp-directory-target-allowed',loop.replace('[ ! -d "/deploy/web/$f" ] && ',''),byId('7a','7b')],
  ['webp-first-only',loop.replace('; fi; done)', '; break; fi; done)'),byId('1c','2c')]
 ];
 for(const [name,mutatedLoop,expected] of cases){
  const changed=source.replace(loop,mutatedLoop);assert.notEqual(changed,source,'genuine source mutation');
  const file=path.join(directory,name+'.js');fs.writeFileSync(file,changed);
  results.push(run(file,expected,name));
  console.log('OK - '+name+' rejects exactly '+expected.length+' intended guards in the complete '+guards.length+'-guard manifest');
 }
 const gzipChanged=source.replace(gzipLine,gzipLine.replace("';"," *.webp';"));
 assert.notEqual(gzipChanged,source,'genuine image-gzip mutation');
 const file=path.join(directory,'webp-gzip-added.js');fs.writeFileSync(file,gzipChanged);
 results.push(run(file,byId('1e','8a','8b'),'webp-gzip-added'));
 console.log('OK - webp-gzip-added rejects exactly 3 intended guards in the complete '+guards.length+'-guard manifest');
 assert.deepEqual(frozen.map(hash),initial,'native sources, operations contracts and all tested guards stayed unchanged');
 console.log('OK - normal plus seven genuine counterexamples completed with unchanged native hashes');
 if(process.env.KEPLER_DEPLOY_WEBP_PROOF)fs.writeFileSync(process.env.KEPLER_DEPLOY_WEBP_PROOF,JSON.stringify({
  guards,results,frozen:frozen.map((name,i)=>({name,sha256:initial[i]}))},null,2)+'\n');
}finally{
 const resolved=path.resolve(directory);
 assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()),'owned cleanup root');
 assert(path.basename(resolved).startsWith('kepler-deploy-webp-counter-'),'owned cleanup prefix');
 fs.rmSync(resolved,{recursive:true,force:true});
}
