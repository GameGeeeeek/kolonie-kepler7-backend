import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

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
const observeReads = (targets, callback) => {
  const watched = new Set(targets), touched = [], originals = new Map();
  for (const name of ['existsSync', 'lstatSync', 'statSync', 'openSync', 'readFileSync']) {
    const original = fs[name]; originals.set(name, original);
    fs[name] = function(...args) {
      if (watched.has(String(args[0]))) touched.push({ name, file: String(args[0]) });
      return Reflect.apply(original, this, args);
    };
  }
  try { return { value: callback(), touched }; }
  finally { for (const [name, original] of originals) fs[name] = original; }
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
    // noLinks checks ancestor metadata as well; forbid writes, not those reads.
    const flags = ['--permission', '--allow-child-process', '--allow-fs-read=*'];
    const nodeOptions = flags.join(' ');
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

test('an incompatible historical manifest displays its version without touching payloads or enabling restore', posix, t => {
  const f = fixture(t), candidate = engineFile();
  const oldEngine = execFileSync('git', ['show', 'f5d26daecce85d6a85fde3baa8a4d4c8d81ada52:operations-release-engine.cjs'],
    { cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), maxBuffer: 2 * 1024 * 1024 });
  assert.notEqual(sha(oldEngine), sha(fs.readFileSync(candidate)), 'actual historical engine has a different operations contract');
  f.versions.a.backend['operations-release-engine.cjs'] = oldEngine; f.select('a');
  const historical = f.engine.initialize().id;
  f.select('b'); const current = f.engine.initialize().id;
  const index = path.join(f.store, historical, 'source.json.gz'), oldBlob = path.join(f.store, 'blobs', sha(oldEngine) + '.gz');
  const indexBytes = fs.readFileSync(index), blobBytes = fs.readFileSync(oldBlob);
  fs.unlinkSync(index); fs.unlinkSync(oldBlob);
  const before = snapshot(f.base), actual = observeReads([index, oldBlob], () => f.engine.inventory());
  const row = actual.value.releases.find(row => row.id === historical);
  assert.equal(row.version, 'test-a'); assert.equal(row.compatible, false); assert.equal(row.current, false);
  assert.match(row.reason, /vertrag unterscheidet/);
  assert.equal(actual.value.current.id, current); assert.equal(actual.value.releaseSwitch, true);
  assert.deepEqual(actual.touched, [], 'no index, blob or even payload-path stat is required for a contract mismatch');
  assert.deepEqual(snapshot(f.base), before, 'the metadata-only inventory writes no files');
  fs.writeFileSync(index, indexBytes, { mode: 0o600 }); fs.writeFileSync(oldBlob, blobBytes, { mode: 0o600 });
  assert.throws(() => f.engine.prepare({ requestId: '09f2d00d-9b25-4d6c-9ba5-dda976e9dc35', target: historical, mode: 'deploy' }),
    error => error.code === 'release_incompatible');
  assert.equal(fs.existsSync(path.join(f.store, 'backups')), false, 'incompatible historical source never starts a DB backup');
  assert.equal(fs.existsSync(path.join(f.store, 'deployment.lock')), false);
  assert.equal(f.state().current, current); assert.equal(f.state().phase, 'complete'); f.assertDatabase();
});

test('potentially compatible historical metadata still requires actual index and blob verification', posix, t => {
  const f = fixture(t), historical = f.engine.initialize().id;
  f.select('b'); const current = f.engine.initialize().id;
  const archive = f.raw(historical), server = archive.files.find(file => file.area === 'backend' && file.name === 'server.js');
  const index = path.join(f.store, historical, 'source.json.gz'), blob = path.join(f.store, 'blobs', server.sha256 + '.gz');
  fs.writeFileSync(blob, Buffer.from('damaged actual payload'), { mode: 0o600 });
  const before = snapshot(f.base), actual = observeReads([index, blob], () => f.engine.inventory());
  const row = actual.value.releases.find(row => row.id === historical);
  assert.equal(row.compatible, false); assert.equal(row.version, null); assert.match(row.reason, /nicht verifiziert/);
  assert.ok(actual.touched.some(call => call.name === 'openSync' && call.file === index), 'the real historical index was read');
  assert.ok(actual.touched.some(call => call.name === 'openSync' && call.file === blob), 'the real historical blob was read');
  assert.equal(actual.value.current.id, current); assert.equal(actual.value.releaseSwitch, true);
  assert.deepEqual(snapshot(f.base), before); f.assertDatabase();
  assert.throws(() => f.engine.prepare({ requestId: '91f7b87d-a6ef-4eaa-a550-367573db4bf8', target: historical, mode: 'deploy' }));
  assert.equal(fs.existsSync(path.join(f.store, 'backups')), false); assert.equal(fs.existsSync(path.join(f.store, 'deployment.lock')), false);
});
