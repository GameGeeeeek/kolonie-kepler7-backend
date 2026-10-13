import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { fixture, engineFile, sha } = require('./lib/release-archive-fixture.cjs');
const posix = { skip: process.platform === 'win32' ? 'Actual private POSIX ownership and permissions require Linux.' : false };
const snapshot = root => {
  const rows = [];
  const visit = (directory, prefix = '') => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = prefix + entry.name, target = path.join(directory, entry.name), info = fs.lstatSync(target);
      assert.equal(info.isSymbolicLink(), false);
      if (info.isDirectory()) visit(target, name + '/');
      else rows.push({ name, bytes: info.size, mode: info.mode, sha256: sha(fs.readFileSync(target)) });
    }
  };
  visit(root); return rows;
};

// The actual Node permission model refuses filesystem writes in the parent and
// inherited index worker. Observers pass every original invocation unchanged.
const observer = `
const fs=require('node:fs'),path=require('node:path');
const input=JSON.parse(process.argv[1]),mkdir=fs.mkdirSync,open=fs.openSync;
const calls={mkdir:[],indexes:[]};
fs.mkdirSync=function(...args){calls.mkdir.push(String(args[0]));return Reflect.apply(mkdir,this,args);};
fs.openSync=function(...args){if(String(args[0]).endsWith(path.sep+'source.json.gz'))calls.indexes.push(String(args[0]));return Reflect.apply(open,this,args);};
try {
 const engine=require(input.engine).createReleaseEngine({roots:input.roots,store:input.store,dbFile:input.dbFile});
 process.stdout.write(JSON.stringify({inventory:engine.inventory(),calls}));
} catch(error) {process.stdout.write(JSON.stringify({error:{code:error.code||null,message:error.message},calls}));process.exitCode=1;}
`;

test('complete v2 and warmed legacy inventories work with actual filesystem writes forbidden', posix, async t => {
  for (const legacy of [false, true]) await t.test(legacy ? 'warm unchanged v1 plus current v2' : 'two v2 releases', t => {
    const f = fixture(t), first = f.engine.initialize().id;
    f.select('b'); const current = f.engine.initialize().id;
    let legacyBytes = null;
    if (legacy) {
      const archive = f.raw(first);
      archive.version = 1;
      archive.files = archive.files.map(file => ({ ...file,
        data: zlib.gunzipSync(fs.readFileSync(path.join(f.store, 'blobs', file.sha256 + '.gz'))).toString('base64') }));
      legacyBytes = zlib.gzipSync(Buffer.from(JSON.stringify(archive)));
      fs.writeFileSync(path.join(f.store, first, 'source.json.gz'), legacyBytes, { mode: 0o600 });
    }
    const before = snapshot(f.base), candidate = engineFile();
    const flags = ['--permission', '--allow-child-process', '--allow-fs-read=' + f.base, '--allow-fs-read=' + path.dirname(candidate)];
    const nodeOptions = flags.map(flag => flag.startsWith('--allow-fs-read=') ? '--allow-fs-read=' + JSON.stringify(flag.slice(16)) : flag).join(' ');
    const result = spawnSync(process.execPath, [...flags, '-e', observer,
      JSON.stringify({ engine: candidate, roots: f.roots, store: f.store, dbFile: f.dbFile })],
    { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024, env: { ...process.env, NODE_OPTIONS: nodeOptions } });
    assert.equal(result.error, undefined, 'native read-only process finishes');
    assert.equal(result.signal, null, 'native read-only process is not terminated');
    assert.equal(result.status, 0, 'no filesystem write capability is needed: ' + result.stdout + result.stderr);
    const actual = JSON.parse(result.stdout);
    assert.equal(actual.error, undefined);
    assert.equal(actual.inventory.current.id, current);
    assert.equal(actual.inventory.releaseSwitch, true);
    assert.deepEqual(actual.inventory.releases.map(row => row.id).sort(), [first, current].sort());
    assert.equal(actual.inventory.releases.every(row => row.compatible === true), true);
    assert.deepEqual(actual.calls.mkdir, [], 'existing private directories require zero mkdir invocations');
    assert.deepEqual(actual.calls.indexes.filter(file => file === path.join(f.store, current, 'source.json.gz')),
      [path.join(f.store, current, 'source.json.gz')], 'the fully verified current archive is read only once');
    assert.deepEqual(snapshot(f.base), before, 'all source, database, state, index, manifest and blob bytes/modes remain unchanged');
    if (legacy) assert.ok(fs.readFileSync(path.join(f.store, first, 'source.json.gz')).equals(legacyBytes), 'original v1 gzip bytes remain unchanged');
    f.assertDatabase();
  });
});
