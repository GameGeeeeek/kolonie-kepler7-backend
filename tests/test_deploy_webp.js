'use strict';
// Execute the actual native frontend deploy command in isolated source/target directories.
// Image payloads are distinct bytes; the contract here is copying, not an image decoder.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const {gunzipSync}=require('node:zlib');
const ROOT=path.resolve(__dirname,'..'),SHELL=process.env.KEPLER_DEPLOY_SHELL||'sh';
const quote=value=>"'"+value.replace(/\\/g,'/').replace(/'/g,"'\\''")+"'";
const source=fs.readFileSync(process.env.KEPLER_BACKEND_SERVER||path.join(ROOT,'server.js'),'utf8').replace(/\r\n/g,'\n');
const constant=name=>{
 const match=source.match(new RegExp('const '+name+' = ([\\s\\S]*?);\\n'));
 if(!match)throw new Error('Missing native '+name);
 return match[1];
};
const native=new Function('const DEPLOY_WEB_GZIP_DATEIEN = '+constant('DEPLOY_WEB_GZIP_DATEIEN')+';\n'+
 'const DEPLOY_WEB_GZIP = '+constant('DEPLOY_WEB_GZIP')+';\n'+
 'return '+constant('DEPLOY_WEB_COPY')+';')();
let checks=0,failures=0;
const check=(name,ok,details)=>{checks++;if(!ok)failures++;console.log((ok?'OK  ':'FAIL')+' - '+name+(details===undefined?'':' | '+JSON.stringify(details)));};
const measure=(fn,fallback=null)=>{try{return fn();}catch{return fallback;}};
const regular=(result,status)=>result.status===status&&!result.error&&result.signal===null;
const FIRST='kepler-gfx-alpha.webp',SECOND='kepler-gfx-beta.webp',PNG='kepler-gfx-alpha.png';
const bytes1=Buffer.from('RIFF\x16\0\0\0WEBPalpha-first-payload','binary');
const bytes2=Buffer.from('RIFF\x16\0\0\0WEBPbeta-second-payload','binary');
const update1=Buffer.from('RIFF\x16\0\0\0WEBPalpha-NEW-payload','binary');
const update2=Buffer.from('RIFF\x16\0\0\0WEBPbeta-NEW-payload','binary');
const png=Buffer.from('\x89PNG\r\n\x1a\noriginal-fallback','binary');
const text='Original deploy text '.repeat(200);
const owned=[];
function fixture(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kepler-deploy-webp-'));owned.push(dir);
 const from=path.join(dir,'repo'),to=path.join(dir,'web');fs.mkdirSync(from);fs.mkdirSync(to);
 for(const name of ['weltraum_kolonie.html','seiten.css','sitemap.xml','robots.txt','manifest.json','service-worker.js','version.txt','patchnotes-archiv.json'])fs.writeFileSync(path.join(from,name),text);
 fs.writeFileSync(path.join(from,PNG),png);
 return {dir,from,to};
}
const write=(u,name,bytes)=>fs.writeFileSync(path.join(u.from,name),bytes);
const equal=(u,name,bytes)=>measure(()=>fs.readFileSync(path.join(u.to,name)).equals(bytes),false);
const zipped=(u,name)=>measure(()=>gunzipSync(fs.readFileSync(path.join(u.to,name+'.gz'))).toString('utf8'));
function execute(u,extraEnv={}){
 // Preserve expansion of the original loop variable and quote temp paths with spaces.
 const command=native.split('"/deploy/web/').join(quote(u.to)+'"/').split('/deploy/web').join(quote(u.to));
 return spawnSync(SHELL,['-c',command],
  {cwd:u.from,env:{...process.env,...extraEnv},encoding:'utf8',timeout:15000,maxBuffer:1024*1024});
}
function sabotage(u,program,marker){
 const found=spawnSync(SHELL,['-c','command -v '+program],{encoding:'utf8',timeout:5000});
 if(!regular(found,0)||!found.stdout.trim())throw new Error('Missing native '+program);
 const bin=path.join(u.dir,'bin');fs.mkdirSync(bin);
 const predicate=program==='cp'?'[ "$arg" = "'+FIRST+'" ]':'case "$arg" in *.webp) true ;; *) false ;; esac';
 const script='#!/bin/sh\nfor arg in "$@"; do if '+predicate+'; then echo "'+marker+'" >&2; exit 73; fi; done\nexec '+quote(found.stdout.trim())+' "$@"\n';
 fs.writeFileSync(path.join(bin,program),script);fs.chmodSync(path.join(bin,program),0o755);
 return {PATH:bin+path.delimiter+process.env.PATH};
}
try{
 check('vorab: der native Web-Deploybefehl ist aus server.js lesbar',typeof native==='string'&&native.includes('/deploy/web'));
 {
  const u=fixture();write(u,FIRST,bytes1);write(u,SECOND,bytes2);write(u,'private.webp',bytes2);write(u,'private.json','private-data');
  const r=execute(u);
  check('1a: vorhandene WebP-Grafiken werden regulaer ausgeliefert',regular(r,0),{status:r.status,error:r.error?.message});
  check('1b: die erste WebP-Grafik wird bytegenau kopiert',equal(u,FIRST,bytes1));
  check('1c: die zweite WebP-Grafik wird bytegenau kopiert',equal(u,SECOND,bytes2));
  check('1d: der PNG-Fallback bleibt bytegenau erhalten',equal(u,PNG,png));
  check('1e: weder WebP noch PNG erhaelt eine gzip-Datei',[FIRST,SECOND,PNG].every(name=>!fs.existsSync(path.join(u.to,name+'.gz'))));
  check('1f: fremde WebP- und JSON-Dateien werden nicht mitveroeffentlicht',!fs.existsSync(path.join(u.to,'private.webp'))&&!fs.existsSync(path.join(u.to,'private.json')));
  check('1g: die bisherigen Textdateien bleiben korrekt komprimiert',zipped(u,'weltraum_kolonie.html')===text&&zipped(u,'version.txt')===text);
  write(u,FIRST,update1);write(u,SECOND,update2);
  const next=execute(u);
  check('2a: der aktualisierte WebP-Bestand wird regulaer ausgeliefert',regular(next,0),{status:next.status});
  check('2b: die erste WebP-Zieldatei enthaelt den neuen Inhalt',equal(u,FIRST,update1));
  check('2c: die zweite WebP-Zieldatei enthaelt den neuen Inhalt',equal(u,SECOND,update2));
 }
 {
  const u=fixture(),r=execute(u);
  check('3a: ein altes Frontend ohne WebP-Grafiken bleibt deploybar',regular(r,0),{status:r.status});
  check('3b: dessen normale Textdateien bleiben komprimiert',zipped(u,'weltraum_kolonie.html')===text&&zipped(u,'version.txt')===text);
  check('3c: dessen vorhandener PNG-Fallback bleibt erhalten',equal(u,PNG,png));
 }
 {
  const u=fixture();write(u,FIRST,update1);fs.writeFileSync(path.join(u.to,FIRST),bytes1);
  const r=execute(u,sabotage(u,'cp','webp-copy-failed'));
  check('4a: ein wirklicher WebP-Kopierfehler bricht regulaer ab',regular(r,1),{status:r.status,signal:r.signal,error:r.error?.message});
  check('4b: der wirkliche WebP-Kopierfehler bleibt im Protokoll',/webp-copy-failed/.test(r.stderr||''));
  check('4c: der fehlgeschlagene Kopierversuch ersetzt keinen alten Bildinhalt',equal(u,FIRST,bytes1));
  check('4d: nach dem WebP-Kopierfehler beginnt die Textkompression nicht',!fs.existsSync(path.join(u.to,'weltraum_kolonie.html.gz')));
 }
 {
  const u=fixture();fs.mkdirSync(path.join(u.from,FIRST));const r=execute(u);
  check('5a: ein vorhandener WebP-Quellpfad als Verzeichnis bricht ab',regular(r,1),{status:r.status});
  check('5b: ein Quellverzeichnis wird nicht als Bild veroeffentlicht',!fs.existsSync(path.join(u.to,FIRST)));
 }
 {
  const u=fixture();write(u,FIRST,Buffer.alloc(0));const r=execute(u);
  check('6a: eine vorhandene leere WebP-Quelldatei bricht ab',regular(r,1),{status:r.status});
  check('6b: eine leere Quelldatei wird nicht als Bild veroeffentlicht',!fs.existsSync(path.join(u.to,FIRST)));
 }
 {
  const u=fixture();write(u,FIRST,bytes1);fs.mkdirSync(path.join(u.to,FIRST));const r=execute(u);
  check('7a: ein WebP-Zielpfad als Verzeichnis bricht ab',regular(r,1),{status:r.status});
  check('7b: eine Grafik wird nicht unbemerkt in ein Zielunterverzeichnis kopiert',!fs.existsSync(path.join(u.to,FIRST,FIRST)));
 }
 {
  const u=fixture();write(u,FIRST,bytes1);const r=execute(u,sabotage(u,'gzip','webp-must-not-be-gzipped'));
  check('8a: ein nur fuer WebP scheiterndes gzip wird nie aufgerufen',regular(r,0),{status:r.status});
  check('8b: das Protokoll bestaetigt keinen WebP-gzip-Aufruf',!/webp-must-not-be-gzipped/.test(r.stderr||''));
 }
}finally{
 for(const directory of owned){
  const resolved=path.resolve(directory);
  if(path.dirname(resolved)!==path.resolve(os.tmpdir())||!path.basename(resolved).startsWith('kepler-deploy-webp-'))throw new Error('Unsafe owned fixture cleanup');
  fs.rmSync(resolved,{recursive:true,force:true});
 }
}
console.log('\n'+checks+' Pruefungen, '+failures+' fehlgeschlagen');
console.log(failures?'FEHLGESCHLAGEN':'Alles gruen');
process.exit(failures?1:0);
