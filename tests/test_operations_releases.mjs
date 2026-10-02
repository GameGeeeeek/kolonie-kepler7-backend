import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createReleaseEngine, schemaProof, operationsProof } = require('../operations-release-engine.cjs');
const linux = { skip: process.platform === 'win32' && !process.env.GG_RELEASE_TEST_FS_SHIM };
const posix = { skip: process.platform === 'win32' };
const requestId = '1f3e20bc-a14d-4e8b-a769-5839d3a98b72';
const secondRequestId = '2f3e20bc-a14d-4e8b-a769-5839d3a98b72';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const baseLoader = `function loadDb() { return JSON.parse(readFileSync(DB_FILE, 'utf8')); }
function performDbWrite(db) { writeFileSync(DB_FILE, JSON.stringify(db)); }
function authMiddleware(req) { return req.session && findUserById(req.session.userId); }
function findUserById(id) { return db.users[id]; }
`;
const operationsHooks = `const opsHealth = require('./operations-health').createOperationalHealth({ dbFile: DB_FILE });
let operationsAdminBridge = null;
require('./operations-admin').installOperationsAdmin({ dbFile: DB_FILE, getDb: () => db, saveDb, opsHealth,
  deployBackend: () => starteDeploy('kolonie-kepler7-backend', DEPLOY_TARGETS['kolonie-kepler7-backend'].command, DEPLOY_TARGETS['kolonie-kepler7-backend'].dir)
}).then(server => { operationsAdminBridge = server; });
function starteDeploy(repoName, command, dir) { require('./operations-release-guard').exec(repoName, command, { timeout: DEPLOY_TIMEOUT_MS }, () => {}); }
function ankuendigungAktuell(jetzt) { return operationsAdminBridge && operationsAdminBridge.announcement(jetzt || Date.now()); }
`;
const loader = baseLoader + operationsHooks;

// Git commands operate on synthetic revision maps only. The engine performs real
// archive, checksum, backup, lock and source file I/O in one disposable directory.
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-kepler-release-'));
  fs.chmodSync(base, 0o700);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const roots = Object.fromEntries(['backend', 'frontend', 'web'].map(area => {
    const root = path.join(base, area); fs.mkdirSync(root, { mode: 0o755 }); return [area, root];
  }));
  const store = path.join(base, 'private-archives');
  const dbFile = path.join(base, 'db.json');
  const database = Buffer.from(JSON.stringify({ users: { pilot: { passwordHash: 'live-private-hash' } }, private: { score: 4 }, shared: { tick: 7 } }));
  fs.writeFileSync(dbFile, database, { mode: 0o600 });
  const versions = Object.fromEntries(['a', 'b', 'c'].map((name, index) => [name, {
    backendCommit: String(index + 1).repeat(40), frontendCommit: String(index + 4).repeat(40),
    backend: { 'server.js': loader + `const release = '${name}';\n`, 'lib/feature.js': `exports.release = '${name}';\n`,
      'operations-admin.js': 'module.exports.installOperationsAdmin = () => {};\n',
      'operations-release-guard.js': 'module.exports.exec = () => {};\n',
      'operations-health.js': 'module.exports.createOperationalHealth = () => {};\n',
      'operations-release-engine.cjs': fs.readFileSync(new URL('../operations-release-engine.cjs', import.meta.url), 'utf8') },
    frontend: { 'index.ts': `export const release = '${name}';\n` },
    web: { 'index.html': `<html>${name}</html>`, 'version.txt': `test-${name}\n`, 'assets/app.js': `window.release = '${name}';\n` },
  }]));
  const current = {}, calls = [];
  let now = 1800000000000, beforeReset = null, beforeSource = null, resetFault = null, dirty = '', namesOverride = null;
  const writeArea = (area, files) => {
    for (const name of fs.readdirSync(roots[area])) fs.rmSync(path.join(roots[area], name), { recursive: true, force: true });
    for (const [name, value] of Object.entries(files)) {
      const target = path.join(roots[area], name); fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
      fs.writeFileSync(target, value, { mode: 0o644 });
    }
  };
  const select = name => {
    const version = versions[name]; assert.ok(version);
    for (const area of Object.keys(roots)) { current[area] = name; writeArea(area, version[area]); }
  };
  const run = (command, args) => {
    assert.equal(command, '/usr/bin/git');
    const rootIndex = args.indexOf('-C'), area = Object.keys(roots).find(key => roots[key] === args[rootIndex + 1]);
    assert.ok(area === 'backend' || area === 'frontend');
    const operation = args.slice(rootIndex + 2); calls.push({ area, args: operation });
    if (operation[0] === 'status' || operation[0] === 'diff') return dirty;
    if (operation[0] === 'rev-parse') return versions[current[area]][area + 'Commit'] + '\n';
    if (operation[0] === 'ls-files') return (namesOverride?.[area] ?? Object.keys(versions[current[area]][area])).join('\0') + '\0';
    if (operation[0] === 'cat-file') {
      if (operation[1] === '-e') { assert.ok(Object.values(versions).some(version => version[area + 'Commit'] + '^{commit}' === operation[2])); return ''; }
      assert.equal(operation[1], 'blob');
      const [commit, name] = operation[2].split(':');
      beforeSource?.({ area, commit, name });
      const version = Object.values(versions).find(value => value[area + 'Commit'] === commit);
      assert.ok(version && Object.hasOwn(version[area], name)); return Buffer.from(version[area][name]);
    }
    if (operation[0] === 'ls-tree') {
      if (operation[1] === '-r') {
        const version = Object.values(versions).find(value => value[area + 'Commit'] === operation.at(-1));
        assert.ok(version); return Object.keys(version[area]).join('\0') + '\0';
      }
      return '100644 blob ' + 'a'.repeat(40) + '\t' + operation.at(-1) + '\n';
    }
    if (operation[0] === 'read-tree') {
      beforeReset?.({ area, commit: operation[1] });
      if (resetFault?.(area, operation[1])) throw Object.assign(new Error('synthetic apply failure'), { code: 'synthetic_apply_failure' });
      return '';
    }
    if (operation[0] === 'update-ref') {
      const [name] = Object.entries(versions).find(([, value]) => value[area + 'Commit'] === operation[2]);
      current[area] = name; return '';
    }
    assert.fail('Unexpected git operation: ' + operation[0]);
  };
  select('a');
  const engine = createReleaseEngine({ roots, store, dbFile, clock: () => now, run });
  const archive = id => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(store, id, 'source.json.gz'))));
  const writeArchive = (id, value) => fs.writeFileSync(path.join(store, id, 'source.json.gz'), zlib.gzipSync(Buffer.from(JSON.stringify(value))), { mode: 0o600 });
  const state = () => JSON.parse(fs.readFileSync(path.join(store, 'state.json')));
  const twoReleases = () => { const a = engine.initialize().id; now += 1000; select('b'); const b = engine.initialize().id; return { a, b }; };
  return { base, roots, store, dbFile, database, versions, calls, run, engine, select, archive, writeArchive, state, twoReleases,
    setTime(value) { now = value; }, beforeReset(value) { beforeReset = value; }, resetFault(value) { resetFault = value; },
    beforeSource(value) { beforeSource = value; },
    dirty(value) { dirty = value; }, names(value) { namesOverride = value; },
    assertDatabase() { assert.deepEqual(fs.readFileSync(dbFile), database); },
  };
}

test('release identity binds both revisions and every archived byte without overwriting an existing capture', linux, t => {
  const f = fixture(t), first = f.engine.initialize().id;
  const archiveFile = path.join(f.store, first, 'source.json.gz'), manifestFile = path.join(f.store, first, 'manifest.json');
  const firstBytes = fs.readFileSync(archiveFile), firstManifest = fs.readFileSync(manifestFile);
  f.setTime(1800000100000);
  assert.equal(f.engine.initialize().id, first);
  assert.deepEqual(fs.readFileSync(archiveFile), firstBytes);
  assert.deepEqual(fs.readFileSync(manifestFile), firstManifest);
  const archive = f.archive(first);
  assert.equal(archive.files.length, 10);
  assert.match(archive.runtimeProof, /^[a-f0-9]{64}$/);
  assert.deepEqual(archive.proof, schemaProof(f.versions.a.backend['server.js']));
  assert.deepEqual(archive.operationsProof, operationsProof(f.versions.a.backend['server.js'], archive.files));
  for (const file of archive.files) {
    const raw = Buffer.from(file.data, 'base64'); assert.equal(file.bytes, raw.length); assert.equal(file.sha256, hash(raw));
  }
  assert.equal(archive.files.some(file => file.name === 'db.json'), false);
  assert.equal(JSON.stringify(archive).includes('live-private-hash'), false);
  fs.writeFileSync(path.join(f.roots.web, 'assets/app.js'), 'different generated bytes');
  const different = f.engine.initialize().id;
  assert.notEqual(different, first); assert.equal(different.slice(0, 40), first.slice(0, 40));
  f.assertDatabase();
});

test('publishing a verified archive does not mark it deployed and a changed runtime layout blocks switching', linux, async t => {
  await t.test('publish before deployment', t => {
    const f = fixture(t), current = f.engine.initialize().id, prior = f.state();
    f.select('b'); const published = f.engine.publish();
    assert.equal(published.published, true); assert.notEqual(published.id, current);
    assert.deepEqual(f.state(), prior);
    f.select('a');
    f.engine.prepare({ requestId, target: published.id, mode: 'deploy' });
    f.engine.finish({ requestId, healthy: true });
    assert.equal(f.state().current, published.id); assert.equal(f.state().previous, current); f.assertDatabase();
  });
  await t.test('different bind mount layout', t => {
    const f = fixture(t), { a } = f.twoReleases();
    const changed = createReleaseEngine({ roots: f.roots, store: f.store, dbFile: f.dbFile, runtimeProof: 'f'.repeat(64), run: f.run });
    assert.equal(changed.inventory().releases.find(row => row.id === a).compatible, false);
    assert.throws(() => changed.prepare({ requestId, target: a, mode: 'deploy' }), error => error.code === 'release_incompatible');
    assert.equal(fs.existsSync(path.join(f.store, 'backups')), false);
    assert.equal(fs.existsSync(path.join(f.store, 'deployment.lock')), false); f.assertDatabase();
  });
});

test('tampered content, checksum or source revision disables an archive and cannot start a switch', linux, async t => {
  for (const mutation of ['content', 'checksum', 'revision']) await t.test(mutation, t => {
    const f = fixture(t), { a, b } = f.twoReleases(), changed = f.archive(a);
    if (mutation === 'content') changed.files[0].data = Buffer.from('tampered').toString('base64');
    if (mutation === 'checksum') changed.files[0].sha256 = 'f'.repeat(64);
    if (mutation === 'revision') changed.frontendCommit = 'f'.repeat(40);
    f.writeArchive(a, changed);
    assert.equal(f.engine.inventory().releases.find(row => row.id === a).compatible, false);
    assert.throws(() => f.engine.prepare({ requestId, target: a, mode: 'deploy' }));
    assert.equal(f.state().current, b); assert.equal(f.state().phase, 'complete');
    assert.equal(fs.existsSync(path.join(f.store, 'deployment.lock')), false);
    assert.equal(fs.existsSync(path.join(f.store, 'backups', requestId + '.db.json.gz')), false);
    f.assertDatabase();
  });
});

test('different JSON loader, writer, session authentication or user lookup blocks switching before backup', linux, async t => {
  for (const fn of ['loadDb', 'performDbWrite', 'authMiddleware', 'findUserById']) await t.test(fn, t => {
    const f = fixture(t), a = f.engine.initialize().id;
    f.versions.b.backend['server.js'] = f.versions.b.backend['server.js'].replace(
      new RegExp(`(function ${fn}\\([^)]*\\) \\{)`), '$1 /* changed contract */');
    f.select('b'); const b = f.engine.initialize().id;
    assert.notDeepEqual(f.archive(a).proof, f.archive(b).proof);
    assert.equal(f.engine.inventory().releases.find(row => row.id === a).compatible, false);
    assert.throws(() => f.engine.prepare({ requestId, target: a, mode: 'deploy' }), error => error.code === 'release_incompatible');
    assert.equal(f.state().current, b); assert.equal(f.state().phase, 'complete');
    assert.equal(fs.existsSync(path.join(f.store, 'backups')), false); f.assertDatabase();
  });
});

test('verified private before-backup precedes source changes and health confirmation finalizes the target', linux, t => {
  const f = fixture(t), { a, b } = f.twoReleases();
  let firstSourceRead = true;
  f.beforeSource(() => {
    if (!firstSourceRead) return;
    firstSourceRead = false;
    const backupFile = path.join(f.store, 'backups', requestId + '.db.json.gz');
    assert.deepEqual(zlib.gunzipSync(fs.readFileSync(backupFile)), f.database);
    assert.equal(fs.readFileSync(path.join(f.roots.backend, 'server.js'), 'utf8'), f.versions.b.backend['server.js']);
    assert.equal(fs.readFileSync(path.join(f.roots.web, 'version.txt'), 'utf8'), 'test-b\n');
  });
  f.beforeReset(() => {
    const backupFile = path.join(f.store, 'backups', requestId + '.db.json.gz');
    assert.deepEqual(zlib.gunzipSync(fs.readFileSync(backupFile)), f.database);
    assert.equal(f.state().phase, 'applying'); assert.equal(f.state().backup.verified, true);
    if (process.platform !== 'win32') assert.equal(fs.statSync(backupFile).mode & 0o077, 0);
  });
  assert.deepEqual(f.engine.prepare({ requestId, target: a, mode: 'rollback' }),
    { prepared: true, requestId, target: a, previous: b, backupVerified: true });
  assert.equal(firstSourceRead, false);
  assert.equal(f.engine.inventory().releaseSwitch, false);
  assert.equal(fs.readFileSync(path.join(f.roots.web, 'version.txt'), 'utf8'), 'test-a\n');
  f.assertDatabase();
  assert.deepEqual(f.engine.finish({ requestId, healthy: true }), { health: true, backupVerified: true });
  assert.equal(f.state().current, a); assert.equal(f.state().previous, b); assert.equal(f.state().phase, 'complete');
  assert.equal(f.engine.inventory().releaseSwitch, true); f.assertDatabase();
});

test('failed health restores only source and requires a second health decision before releasing the lock', linux, t => {
  const f = fixture(t), { a, b } = f.twoReleases();
  f.engine.prepare({ requestId, target: a, mode: 'deploy' });
  const newDatabase = Buffer.from(JSON.stringify({ users: {}, private: { score: 99 }, shared: { tick: 88 } }));
  fs.writeFileSync(f.dbFile, newDatabase);
  assert.deepEqual(f.engine.finish({ requestId, healthy: false }), { restored: true, restartRequired: true, backupVerified: true });
  assert.equal(f.state().phase, 'rollback-pending'); assert.equal(f.state().current, b);
  assert.equal(fs.readFileSync(path.join(f.roots.backend, 'server.js'), 'utf8'), f.versions.b.backend['server.js']);
  assert.equal(fs.readFileSync(path.join(f.roots.web, 'version.txt'), 'utf8'), 'test-b\n');
  assert.deepEqual(fs.readFileSync(f.dbFile), newDatabase);
  assert.throws(() => f.engine.beforeExternal('kolonie-kepler7'));
  assert.deepEqual(f.engine.rollbackComplete({ requestId, healthy: false }), { health: false, backupVerified: true, rolledBack: true });
  assert.equal(f.state().phase, 'rollback-unconfirmed'); assert.equal(f.engine.inventory().releaseSwitch, false);
  assert.deepEqual(fs.readFileSync(f.dbFile), newDatabase);
});

test('health success cannot finalize changed source and the held operation can still recover', linux, t => {
  const f = fixture(t), { a, b } = f.twoReleases();
  f.engine.prepare({ requestId, target: a, mode: 'deploy' });
  fs.writeFileSync(path.join(f.roots.web, 'assets/app.js'), 'unexpected bytes after apply');
  assert.throws(() => f.engine.finish({ requestId, healthy: true }), error => error.code === 'release_readback_failed');
  assert.equal(f.state().phase, 'applying'); assert.equal(f.state().current, b);
  assert.equal(fs.existsSync(path.join(f.store, 'deployment.lock')), true);
  assert.throws(() => f.engine.finish({ requestId: secondRequestId, healthy: false }), error => error.code === 'deployment_busy');
  f.engine.finish({ requestId, healthy: false });
  assert.deepEqual(f.engine.rollbackComplete({ requestId, healthy: true }), { health: true, backupVerified: true, rolledBack: true });
  assert.equal(f.state().phase, 'complete'); assert.equal(f.state().current, b);
  assert.equal(fs.readFileSync(path.join(f.roots.web, 'assets/app.js'), 'utf8'), f.versions.b.web['assets/app.js']);
  f.assertDatabase();
});

test('source apply failure recovers the prior release and a corrupt live JSON database prevents source changes', linux, async t => {
  await t.test('apply failure', t => {
    const f = fixture(t), { a, b } = f.twoReleases(); let failed = false;
    f.resetFault((area, commit) => { if (!failed && area === 'frontend' && commit === f.versions.a.frontendCommit) { failed = true; return true; } return false; });
    assert.throws(() => f.engine.prepare({ requestId, target: a, mode: 'deploy' }), error => error.code === 'synthetic_apply_failure');
    assert.equal(f.state().current, b); assert.equal(f.state().phase, 'complete');
    assert.equal(fs.readFileSync(path.join(f.roots.backend, 'server.js'), 'utf8'), f.versions.b.backend['server.js']);
    assert.equal(fs.readFileSync(path.join(f.roots.web, 'version.txt'), 'utf8'), 'test-b\n');
    assert.equal(fs.existsSync(path.join(f.store, 'deployment.lock')), false); f.assertDatabase();
  });
  await t.test('invalid backup', t => {
    const f = fixture(t), { a, b } = f.twoReleases(); fs.writeFileSync(f.dbFile, '{ invalid live db');
    let changed = 0; f.beforeReset(() => { changed++; });
    assert.throws(() => f.engine.prepare({ requestId, target: a, mode: 'deploy' }), error => error.code === 'backup_invalid');
    assert.equal(f.state().current, b); assert.equal(f.state().phase, 'complete');
    // No source was touched, so an invalid backup must not apply either revision.
    assert.equal(f.calls.filter(call => call.args[0] === 'read-tree' && call.args[1] === f.versions.a.backendCommit).length, 0);
    assert.equal(fs.readFileSync(f.dbFile, 'utf8'), '{ invalid live db'); assert.equal(changed, 0);
  });
});

test('source and legacy deployment paths share one exclusive persistent lock and preserve the previous archive', linux, t => {
  const f = fixture(t), a = f.engine.initialize().id;
  const external = f.engine.beforeExternal('kolonie-kepler7');
  assert.equal(external.previous, a); assert.equal(f.engine.inventory().releaseSwitch, false);
  assert.equal(external.backupVerified, true);
  assert.deepEqual(zlib.gunzipSync(fs.readFileSync(path.join(f.store, 'backups', external.requestId + '.db.json.gz'))), f.database);
  assert.throws(() => f.engine.beforeExternal('kolonie-kepler7-backend'));
  assert.throws(() => f.engine.prepare({ requestId, target: a, mode: 'deploy' }));
  assert.throws(() => f.engine.afterExternal({ requestId: secondRequestId, success: true }), error => error.code === 'deployment_busy');
  f.select('b');
  const completed = f.engine.afterExternal({ requestId: external.requestId, success: true });
  assert.equal(completed.archived, true); assert.notEqual(completed.id, a);
  assert.equal(f.state().previous, a); assert.equal(f.state().phase, 'complete');
  assert.equal(fs.existsSync(path.join(f.store, a, 'source.json.gz')), true);
  assert.equal(fs.existsSync(path.join(f.store, 'deployment.lock')), false);
  const failed = f.engine.beforeExternal('kolonie-kepler7-backend');
  assert.deepEqual(f.engine.afterExternal({ requestId: failed.requestId, success: false }), { archived: false });
  assert.equal(f.state().phase, 'external-unconfirmed'); assert.equal(f.engine.inventory().releaseSwitch, false); f.assertDatabase();
});

test('legacy deploy locks prevent a new switch and persistent engine locks cannot be silently replaced after restart', linux, t => {
  const f = fixture(t), { a, b } = f.twoReleases(), lockDirectory = path.join(f.base, 'legacy-locks');
  fs.mkdirSync(lockDirectory, { mode: 0o700 });
  const oldLockDirectory = process.env.DEPLOY_LOCK_DIR;
  process.env.DEPLOY_LOCK_DIR = lockDirectory;
  t.after(() => { if (oldLockDirectory === undefined) delete process.env.DEPLOY_LOCK_DIR; else process.env.DEPLOY_LOCK_DIR = oldLockDirectory; });
  const legacyLock = path.join(lockDirectory, 'kepler7-deploy-kolonie-kepler7.lock'); fs.writeFileSync(legacyLock, 'held');
  assert.throws(() => f.engine.prepare({ requestId, target: a, mode: 'deploy' }), error => error.code === 'legacy_deployment_busy');
  assert.equal(fs.existsSync(path.join(f.store, 'backups')), false); assert.equal(f.state().current, b);
  fs.unlinkSync(legacyLock);
  const external = f.engine.beforeExternal('kolonie-kepler7');
  const previousLock = fs.readFileSync(path.join(f.store, 'deployment.lock'));
  const again = createReleaseEngine({ roots: f.roots, store: f.store, dbFile: f.dbFile, run() { assert.fail('Busy deployment must not execute git'); } });
  assert.throws(() => again.beforeExternal('kolonie-kepler7'));
  assert.deepEqual(fs.readFileSync(path.join(f.store, 'deployment.lock')), previousLock);
  assert.equal(again.inventory().releaseSwitch, false);
  f.engine.afterExternal({ requestId: external.requestId, success: false }); f.assertDatabase();
});

test('unsafe tracked paths and dirty public source cannot be archived', linux, async t => {
  for (const name of ['../db.json', '/absolute.js', 'lib\\escape.js', '.git/config', 'node_modules/dependency.js']) await t.test(name, t => {
    const f = fixture(t); f.names({ backend: ['server.js', name] });
    assert.throws(() => f.engine.initialize(), error => error.code === 'unsafe_tracked_source');
    assert.equal(fs.existsSync(path.join(f.store, 'state.json')), false); f.assertDatabase();
  });
  await t.test('dirty repository', t => {
    const f = fixture(t); f.dirty('server.js\0');
    assert.throws(() => f.engine.initialize(), error => error.code === 'dirty_release_source'); f.assertDatabase();
  });
});

test('tracked and web credentials stay outside archives and survive source rollback unchanged', linux, t => {
  const f = fixture(t);
  for (const name of ['a', 'b']) {
    f.versions[name].backend['.env.production'] = 'release-specific-secret-' + name;
    f.versions[name].backend['private-key.pem'] = 'release-specific-key-' + name;
    for (const file of ['db.json', 'users.json', 'accounts.json', 'sessions.json', 'backups/older.db.json.gz'])
      f.versions[name].backend[file] = 'excluded-live-data-' + name;
    f.versions[name].web['credentials.json'] = JSON.stringify({ password: 'release-specific-password-' + name });
    f.versions[name].web['manifest.webmanifest'] = '{"name":"Kepler"}';
  }
  f.select('a'); const { a } = f.twoReleases();
  fs.writeFileSync(path.join(f.roots.backend, '.env.production'), 'current-operator-secret');
  fs.writeFileSync(path.join(f.roots.backend, 'private-key.pem'), 'current-operator-key');
  fs.writeFileSync(path.join(f.roots.web, 'credentials.json'), '{"password":"current-operator-password"}');
  fs.writeFileSync(path.join(f.roots.backend, 'db.json'), 'current-live-account-data');
  f.dirty('.env.production\0private-key.pem\0');
  assert.equal(f.archive(a).files.some(file => /env|private-key|credentials/.test(file.name)), false);
  assert.equal(f.archive(a).files.some(file => /^(?:db|users|accounts|sessions)\.json$|^backups\//.test(file.name)), false);
  assert.equal(f.archive(a).files.some(file => file.area === 'web' && file.name === 'manifest.webmanifest'), true);
  f.engine.prepare({ requestId, target: a, mode: 'rollback' });
  assert.equal(fs.readFileSync(path.join(f.roots.backend, '.env.production'), 'utf8'), 'current-operator-secret');
  assert.equal(fs.readFileSync(path.join(f.roots.backend, 'private-key.pem'), 'utf8'), 'current-operator-key');
  assert.equal(fs.readFileSync(path.join(f.roots.web, 'credentials.json'), 'utf8'), '{"password":"current-operator-password"}');
  assert.equal(fs.readFileSync(path.join(f.roots.backend, 'db.json'), 'utf8'), 'current-live-account-data');
  f.engine.finish({ requestId, healthy: true }); f.assertDatabase();
});

test('private storage permissions and symlinked source or archive files fail closed', posix, async t => {
  await t.test('public storage', t => {
    const f = fixture(t); fs.mkdirSync(f.store, { mode: 0o755 });
    assert.throws(() => f.engine.initialize(), error => error.code === 'unsafe_release_storage');
  });
  await t.test('tracked leaf symlink', t => {
    const f = fixture(t), file = path.join(f.roots.backend, 'server.js'); fs.unlinkSync(file); fs.symlinkSync(f.dbFile, file);
    assert.throws(() => f.engine.initialize()); f.assertDatabase();
  });
  await t.test('web symlink', t => {
    const f = fixture(t); fs.symlinkSync(f.dbFile, path.join(f.roots.web, 'public-app.js'));
    assert.throws(() => f.engine.initialize(), error => error.code === 'unsafe_web_source'); f.assertDatabase();
  });
  await t.test('archive symlink', t => {
    const f = fixture(t), { a } = f.twoReleases(), file = path.join(f.store, a, 'source.json.gz'); fs.unlinkSync(file); fs.symlinkSync(f.dbFile, file);
    assert.equal(f.engine.inventory().releases.find(row => row.id === a).compatible, false);
    assert.throws(() => f.engine.prepare({ requestId, target: a, mode: 'deploy' })); f.assertDatabase();
  });
});

test('archive schema proof is derived from its server source even when content IDs and file hashes are self-consistent', linux, t => {
  const f = fixture(t), { a } = f.twoReleases(), forged = f.archive(a);
  const server = forged.files.find(file => file.area === 'backend' && file.name === 'server.js');
  const raw = Buffer.from(loader.replace('JSON.parse(readFileSync', 'otherLoader(readFileSync') + "const release = 'forged';\n");
  server.data = raw.toString('base64'); server.bytes = raw.length; server.sha256 = hash(raw);
  const identity = { backendCommit: forged.backendCommit, frontendCommit: forged.frontendCommit, runtimeProof: forged.runtimeProof, proof: forged.proof,
    operationsProof: forged.operationsProof,
    files: forged.files.map(({ data: _data, ...file }) => file) };
  forged.id = forged.backendCommit + '-' + hash(JSON.stringify(identity));
  fs.mkdirSync(path.join(f.store, forged.id), { mode: 0o700 }); f.writeArchive(forged.id, forged);
  assert.notDeepEqual(schemaProof(raw.toString('utf8')), forged.proof);
  assert.equal(f.engine.inventory().releases.find(row => row.id === forged.id).compatible, false);
  assert.throws(() => f.engine.prepare({ requestId, target: forged.id, mode: 'deploy' }));
  assert.equal(fs.existsSync(path.join(f.store, 'backups', requestId + '.db.json.gz')), false); f.assertDatabase();
});

test('tracked source cannot escape through an intermediate directory symlink', posix, t => {
  const f = fixture(t), directory = path.join(f.roots.backend, 'lib');
  fs.rmSync(directory, { recursive: true });
  const outside = path.join(f.base, 'private-outside'); fs.mkdirSync(outside, { mode: 0o700 });
  fs.writeFileSync(path.join(outside, 'feature.js'), 'private outside root'); fs.symlinkSync(outside, directory, 'dir');
  assert.throws(() => f.engine.initialize());
  assert.equal(fs.existsSync(path.join(f.store, 'state.json')), false); f.assertDatabase();
});

test('operations proof requires the private bridge, health adapter, advisory and shared deploy guard', () => {
  const files = ['operations-admin.js', 'operations-release-guard.js', 'operations-health.js', 'operations-release-engine.cjs'].map(name =>
    ({ area: 'backend', name, data: Buffer.from('reviewed ' + name).toString('base64') }));
  const proof = operationsProof(loader, files);
  assert.equal(proof.format, 'kepler-private-operations-v1');
  assert.deepEqual(operationsProof(loader + 'const gameplay = 2;', files), proof);
  assert.equal(operationsProof(baseLoader, files), null);
  for (const name of files.map(file => file.name)) assert.equal(operationsProof(loader, files.filter(file => file.name !== name)), null);
  assert.equal(operationsProof(loader.replace("require('./operations-release-guard').exec", 'exec'), files), null);
  assert.equal(operationsProof(loader.replace('operationsAdminBridge.announcement', 'otherAnnouncement'), files), null);
  const changed = files.map(file => file.name === 'operations-admin.js' ? { ...file, data: Buffer.from('changed bridge').toString('base64') } : file);
  assert.notDeepEqual(operationsProof(loader, changed), proof);
});

test('an immutable pre-bridge baseline stays visible but cannot replace a working administration source', linux, t => {
  const f = fixture(t);
  f.versions.a.backend['server.js'] = baseLoader + "const release = 'a';\n";
  delete f.versions.a.backend['operations-admin.js'];
  delete f.versions.a.backend['operations-release-guard.js'];
  f.select('a'); const a = f.engine.initialize().id;
  assert.equal(f.archive(a).operationsProof, null);
  assert.equal(f.engine.inventory().releaseSwitch, false);
  f.select('b'); const b = f.engine.initialize().id;
  const old = f.engine.inventory().releases.find(row => row.id === a);
  assert.equal(old.compatible, false); assert.match(old.reason, /private Verwaltung/);
  f.calls.length = 0;
  assert.throws(() => f.engine.prepare({ requestId, target: a, mode: 'rollback' }), error => error.code === 'release_incompatible');
  assert.equal(f.state().current, b);
  assert.equal(fs.existsSync(path.join(f.store, 'backups')), false);
  assert.equal(f.calls.some(call => ['read-tree', 'update-ref'].includes(call.args[0])), false);
  assert.equal(fs.readFileSync(path.join(f.roots.backend, 'operations-admin.js'), 'utf8'), f.versions.b.backend['operations-admin.js']);
  f.assertDatabase();
});

test('a self-consistent source archive cannot reuse a different private bridge proof', linux, t => {
  const f = fixture(t), { a } = f.twoReleases(), forged = f.archive(a);
  const bridge = forged.files.find(file => file.area === 'backend' && file.name === 'operations-admin.js');
  const raw = Buffer.from('module.exports.installOperationsAdmin = () => { throw Error("unavailable"); };');
  bridge.data = raw.toString('base64'); bridge.bytes = raw.length; bridge.sha256 = hash(raw);
  const identity = { backendCommit: forged.backendCommit, frontendCommit: forged.frontendCommit, runtimeProof: forged.runtimeProof,
    proof: forged.proof, operationsProof: forged.operationsProof, files: forged.files.map(({ data: _data, ...file }) => file) };
  forged.id = forged.backendCommit + '-' + hash(JSON.stringify(identity));
  fs.mkdirSync(path.join(f.store, forged.id), { mode: 0o700 }); f.writeArchive(forged.id, forged);
  assert.equal(f.engine.inventory().releases.find(row => row.id === forged.id).compatible, false);
  assert.throws(() => f.engine.prepare({ requestId, target: forged.id, mode: 'deploy' }), error => error.code === 'invalid_release_archive');
  assert.equal(fs.existsSync(path.join(f.store, 'backups')), false); f.assertDatabase();
});

test('initialization cannot overwrite a deployment that holds the shared private lock', linux, t => {
  const f = fixture(t), { a } = f.twoReleases();
  f.engine.prepare({ requestId, target: a, mode: 'deploy' });
  const state = f.state();
  assert.throws(() => f.engine.initialize());
  assert.deepEqual(f.state(), state);
  assert.equal(fs.existsSync(path.join(f.store, 'deployment.lock')), true);
  f.engine.finish({ requestId, healthy: false });
  f.engine.rollbackComplete({ requestId, healthy: true }); f.assertDatabase();
});

test('only the internal engine-install reservation initializes an unchanged source without losing its previous release', linux, t => {
  const f = fixture(t), { a, b } = f.twoReleases();
  const lock = path.join(f.store, 'deployment.lock');
  fs.writeFileSync(lock, JSON.stringify({ requestId, action: 'engine-install', createdAt: 1800000000000 }), { mode: 0o600 });
  assert.throws(() => f.engine.initialize({ requestId, confirmed: true }), error => error.code === 'invalid_request');
  assert.equal(fs.existsSync(lock), true);
  assert.equal(f.engine.initialize({ requestId }).id, b);
  assert.equal(f.state().previous, a); assert.equal(fs.existsSync(lock), false);
  assert.equal(f.engine.initialize().id, b); assert.equal(f.state().previous, a);
  const external = f.engine.beforeExternal('kolonie-kepler7');
  const prior = f.state();
  assert.throws(() => f.engine.initialize({ requestId: external.requestId }), error => error.code === 'invalid_request');
  assert.deepEqual(f.state(), prior); assert.equal(fs.existsSync(lock), true);
  f.engine.afterExternal({ requestId: external.requestId, success: true }); f.assertDatabase();
});

test('restoring nested source checks existing parents before mkdir can follow a symlink outside the installation', posix, t => {
  const f = fixture(t);
  f.versions.a.backend['lib/nested/new/feature.js'] = 'source with deeper directory';
  f.select('a'); const { a, b } = f.twoReleases();
  const outside = path.join(f.base, 'private-outside'); fs.mkdirSync(outside, { mode: 0o700 });
  fs.symlinkSync(outside, path.join(f.roots.backend, 'lib/nested'), 'dir');
  assert.throws(() => f.engine.prepare({ requestId, target: a, mode: 'deploy' }), error => error.code === 'unsafe_release_file');
  assert.equal(fs.existsSync(path.join(outside, 'new')), false);
  assert.equal(f.state().current, b); assert.equal(f.state().phase, 'complete'); f.assertDatabase();
});
