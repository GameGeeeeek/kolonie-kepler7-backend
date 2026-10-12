'use strict';
// The real native copy/gzip command is measured by the complete deploy test.
// Each isolated counter copy must retain every original guard in the same order.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {spawnSync,execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),server=path.join(root,'server.js');
const source=fs.readFileSync(server,'utf8');
const copyBlock=' && (if [ -e kepler-english.json ] || [ -L kepler-english.json ]; then [ -f kepler-english.json ] && [ ! -d /deploy/web/kepler-english.json ] && cp -f kepler-english.json /deploy/web/ || exit 1; fi)';
assert.equal(source.split(copyBlock).length,2,'unique optional native catalog copy block');
const gzipLine=source.match(/^const DEPLOY_WEB_GZIP_DATEIEN = .*$/m)?.[0];
assert(gzipLine&&gzipLine.split(' kepler-english.json').length===2,'unique explicitly compressed catalog');
const withoutGzip=source.replace(gzipLine,gzipLine.replace(' kepler-english.json',''));
const guards=[
 'vorab: DEPLOY_WEB_COPY und die gzip-Liste sind aus server.js lesbar',
 '1a: der Deploy-Befehl laeuft durch',
 '1b: jede ausgelieferte Textdatei hat eine .gz',
 '1c: das Original bleibt liegen (nginx braucht beide)',
 '1d: die .gz ist deutlich kleiner als das Original',
 '1e: die .gz enthaelt genau den ausgelieferten Inhalt',
 '2a: der zweite Deploy laeuft durch',
 '2b: die .gz traegt den NEUEN Stand, nicht den alten',
 '3a: das PNG wird ausgeliefert',
 '3b: aber ohne .gz - gzip macht Bilder nur groesser',
 '4a: eine fehlende optionale Datei reisst den Deploy nicht',
 '4b: die uebrigen Dateien sind trotzdem komprimiert',
 '5a: ein gescheitertes gzip reisst den Deploy (Exit != 0)',
 '5b: ... und der Grund steht im Protokoll',
 '6a: jede kopierte Textdatei steht in der gzip-Liste',
 '6b: die gzip-Liste nennt nichts, was gar nicht ausgeliefert wird',
 '6c: die Kopierliste wurde ueberhaupt erkannt (sonst waere 6a hohl)',
 '7a: ein Frontend mit englischem Katalog wird regulaer ausgeliefert',
 '7b: der englische Katalog wird bytegenau kopiert',
 '7c: seine gzip-Datei enthaelt genau denselben Katalog',
 '7d: beliebige andere JSON-Dateien werden nicht mitveroeffentlicht',
 '7e: ein aktualisierter englischer Katalog wird regulaer ausgeliefert',
 '7f: das Katalogoriginal traegt den neuen Inhalt',
 '7g: die Katalog-gzip-Datei traegt den neuen Inhalt',
 '8a: ein altes Frontend ohne englischen Katalog bleibt deploybar',
 '8b: dessen normale Spiel- und Versionsdateien bleiben komprimiert',
 '9a: ein Kopierfehler des vorhandenen Katalogs bricht den Deploy regulaer ab',
 '9b: der wirkliche Katalog-Kopierfehler bleibt im Protokoll',
 '9c: der fehlgeschlagene Katalog-Kopierversuch ueberschreibt keinen alten Inhalt',
 '10a: ein gzip-Fehler des vorhandenen Katalogs bricht den Deploy regulaer ab',
 '10b: der wirkliche Katalog-gzip-Fehler bleibt im Protokoll',
 '10c: eine alte Katalog-gzip-Datei ist nicht als neuer Erfolg umgeschrieben',
 '11a: ein vorhandener Katalogpfad als Verzeichnis wird nicht als fehlende Altdatei behandelt',
 '12a: ein Verzeichnis am Katalogziel wird nicht als erfolgreiches Kopieren behandelt'
];
const byId=(...ids)=>guards.filter(name=>ids.some(id=>name.startsWith(id+':')));
const frozen=['server.js','operations-release-guard.js','operations-release-engine.cjs','operations-admin.js','operations-health.js','tests/test_deploy_gzip.js','tests/check_deploy_language_counterexamples.cjs'].map(name=>path.join(root,name));
const hashes=()=>frozen.map(file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
const initialHashes=hashes();
function run(file,failures){
 const r=spawnSync(process.execPath,['tests/test_deploy_gzip.js'],{cwd:root,env:{...process.env,KEPLER_BACKEND_SERVER:file},encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024});
 const output=r.stdout||'';
 assert.equal(r.error,undefined,'deploy test subprocess error: '+r.error);
 assert.equal(r.signal,null,'deploy test subprocess was signalled');
 assert.equal((r.stderr||'').trim(),'','deploy test subprocess stderr:\n'+r.stderr);
 assert.equal(r.status,failures.length?1:0,'deploy test exited with an unrelated status:\n'+output);
 const records=output.split(/\r?\n/).flatMap(line=>{const m=/^(OK\s*|FAIL)\s+-\s+(.+?)(?: \| |$)/.exec(line);return m?[{name:m[2],ok:m[1].trim()==='OK'}]:[]});
 assert.deepEqual(records.map(x=>x.name),guards,'deploy test guard names/order/count changed:\n'+output);
 assert.deepEqual(records.filter(x=>!x.ok).map(x=>x.name),failures,'counter failed unrelated guards:\n'+output);
 const summary=output.split(/\r?\n/).filter(line=>/^\d+ Pruefungen, \d+ fehlgeschlagen$/.test(line));
 assert.deepEqual(summary,[guards.length+' Pruefungen, '+failures.length+' fehlgeschlagen'],'incomplete final deploy summary');
 assert.equal(output.trim().split(/\r?\n/).at(-1),failures.length?'FEHLGESCHLAGEN':'Alles gruen','missing final deploy result');
 return {records,output};
}
run(server,[]);
console.log('OK - native catalog deployment passes all '+guards.length+' complete original and catalog guards');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'kepler-deploy-catalog-counter-'));
try{
 const old=execFileSync('git',['show','dda5d5d3c1dbfb5eeef9ecf5c88227014415c1ef:server.js'],{cwd:root,encoding:'utf8',maxBuffer:8*1024*1024});
 const copyFailure='cp -f kepler-english.json /deploy/web/ || exit 1';
 const gzipFailure='gzip -9 -kf "$f" || exit 1';
 assert.equal(source.split(copyFailure).length,2,'unique catalog copy failure boundary');
 assert.equal(source.split(gzipFailure).length,2,'unique original native gzip failure boundary');
 const cases=[
  ['old-native',old,byId('7b','7c','7f','7g','9a','9b','10a','10b','11a','12a')],
  ['catalog-copy-omitted',source.replace(copyBlock,''),byId('6b','7b','7c','7f','7g','9a','9b','11a','12a')],
  ['catalog-gzip-omitted',withoutGzip,byId('6a','7c','7g','10a','10b')],
  ['catalog-copy-fail-open',source.replace(copyFailure,'cp -f kepler-english.json /deploy/web/ || true'),byId('9a','11a','12a')],
  ['catalog-gzip-fail-open',source.replace(gzipFailure,'gzip -9 -kf "$f" || true'),byId('5a','10a')]
 ];
 for(const [name,copy,failures] of cases){
  assert.notEqual(copy,source,'counter does not change native source');
  const file=path.join(directory,name+'.js');fs.writeFileSync(file,copy);
  run(file,failures);
  console.log('MEASURE - '+name+': '+JSON.stringify(failures));
  console.log('OK - '+name+' rejects exactly '+failures.length+' intended guards in the full '+guards.length+'-guard manifest');
 }
 assert.deepEqual(hashes(),initialHashes,'native source, operations contract or tested guards changed during counterexamples');
 console.log('OK - every native deployment source and test hash stayed unchanged');
}finally{
 const resolved=path.resolve(directory);
 assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()),'counter cleanup escapes its owned temp directory');
 assert(path.basename(resolved).startsWith('kepler-deploy-catalog-counter-'),'counter cleanup lacks owned prefix');
 fs.rmSync(resolved,{recursive:true,force:true});
}
