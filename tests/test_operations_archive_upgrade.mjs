import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const repository = path.resolve(import.meta.dirname, '..');
const helperFile = path.resolve(process.env.GG_ARCHIVE_UPGRADE_HELPER || path.join(repository, 'tools/upgrade-release-archive.cjs'));
const { createUpgrade } = require(helperFile);
const linux = { skip: process.platform !== 'linux' && 'Real POSIX ownership, permissions, fsync and native Git are required.' };
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const baseline = 'f5d26daecce85d6a85fde3baa8a4d4c8d81ada52';
const source = `function loadDb() { return JSON.parse(readFileSync(DB_FILE, 'utf8')); }
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

// Real isolated repositories and real v1/v2 providers. Only the Docker boundary
// is absent: Git executes locally and authoritative flush/health are injected.
function fixture(t, { extraFile, changedServer = false } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kepler-upgrade-'));
  fs.chmodSync(base, 0o700);
  const roots = Object.fromEntries(['backend', 'frontend', 'web'].map(area => {
    const directory = path.join(base, area); fs.mkdirSync(directory, { mode: 0o755 }); return [area, directory];
  }));
  const store = path.join(base, 'private'), stage = path.join(store, 'archive-upgrade');
  fs.mkdirSync(store, { mode: 0o700 }); fs.mkdirSync(stage, { mode: 0o700 });
  const dbFile = path.join(base, 'db.json');
  const database = Buffer.from(JSON.stringify({ users: { fixture: { value: 'fabricated account' } }, private: { score: 2 }, shared: { tick: 3 } }));
  fs.writeFileSync(dbFile, database, { mode: 0o600 });
  const git = (root, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', root, ...args], { maxBuffer: 8 * 1024 * 1024 }).toString('utf8').trim();
  const commit = root => { git(root, 'add', '.'); git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture', '--quiet'); return git(root, 'rev-parse', 'HEAD'); };
  const oldBytes = execFileSync('git', ['-C', repository, 'show', baseline + ':operations-release-engine.cjs'], { maxBuffer: 2 * 1024 * 1024 });
  const newBytes = fs.readFileSync(path.join(repository, 'operations-release-engine.cjs'));
  const oldEngineSha256 = sha(oldBytes), newEngineSha256 = sha(newBytes), runtimeProof = sha('isolated-upgrade-layout');
  for (const area of ['backend', 'frontend']) git(roots[area], 'init', '-b', 'fixture', '--quiet');
  for (const [name, bytes] of Object.entries({ 'server.js': source, 'operations-admin.js': 'exports.installOperationsAdmin=()=>{};', 'operations-health.js': 'exports.createOperationalHealth=()=>{};', 'operations-release-guard.js': 'exports.exec=()=>{};', 'operations-release-engine.cjs': oldBytes })) fs.writeFileSync(path.join(roots.backend, name), bytes, { mode: 0o644 });
  fs.writeFileSync(path.join(roots.frontend, 'app.js'), 'const version="before";', { mode: 0o644 });
  fs.writeFileSync(path.join(roots.web, 'index.html'), '<html>before</html>', { mode: 0o644 });
  fs.writeFileSync(path.join(roots.web, 'version.txt'), 'fixture-before', { mode: 0o644 });
  const oldCommit = commit(roots.backend); commit(roots.frontend);
  fs.writeFileSync(path.join(roots.backend, 'operations-release-engine.cjs'), newBytes);
  if (extraFile) fs.writeFileSync(path.join(roots.backend, extraFile), 'const publicChange=true;');
  if (changedServer) fs.appendFileSync(path.join(roots.backend, 'server.js'), '\nconst gameplayChanged=true;');
  const newCommit = commit(roots.backend); git(roots.backend, 'checkout', '--detach', oldCommit, '--quiet');
  fs.writeFileSync(path.join(store, 'engine.cjs'), oldBytes, { mode: 0o600 });
  const contractBytes = Buffer.from(JSON.stringify({ version: 1, engineSha256: oldEngineSha256, runtimeProof }));
  fs.writeFileSync(path.join(store, 'runtime-contract.json'), contractBytes, { mode: 0o600 });
  const events = [], hooks = new Map();
  const run = (command, args, options = {}) => {
    assert.equal(command, '/usr/bin/git', 'The fixture permits only native Git, never Docker or a shell.');
    events.push({ command, args: [...args] });
    return execFileSync('git', args, { ...options, timeout: 10000, maxBuffer: 8 * 1024 * 1024 });
  };
  const oldProviderFile = path.join(stage, 'fixture-v1-provider.cjs'); fs.writeFileSync(oldProviderFile, oldBytes, { mode: 0o600 });
  const oldProvider = require(oldProviderFile).createReleaseEngine({ roots, store, dbFile, runtimeProof, run });
  const previous = oldProvider.initialize(), held = oldProvider.beforeExternal('kolonie-kepler7');
  const oldArchiveBytes = fs.readFileSync(path.join(store, previous.id, 'source.json.gz'));
  fs.writeFileSync(path.join(roots.frontend, 'app.js'), 'const version="after";');
  const frontendCommit = commit(roots.frontend);
  fs.writeFileSync(path.join(roots.web, 'index.html'), '<html>after</html>'); fs.writeFileSync(path.join(roots.web, 'version.txt'), 'fixture-after');
  const serverBlob = git(roots.backend, 'rev-parse', oldCommit + ':server.js');
  const config = { frontendCommit, newCommit, newEngineSha256, oldCommit, oldEngineSha256, oldRequestId: held.requestId, runtimeProof, serverBlob };
  fs.writeFileSync(path.join(stage, 'config.json'), JSON.stringify(config), { mode: 0o600 });
  fs.writeFileSync(path.join(stage, 'candidate-engine.cjs'), newBytes, { mode: 0o600 });
  const f = { base, roots, store, stage, dbFile, database, config, events, hooks, oldBytes, newBytes, contractBytes, previous, held, oldArchiveBytes, healthCommit: oldCommit, healthPatch: {}, flushError: null, pairHook: null };
  f.state = () => JSON.parse(fs.readFileSync(path.join(store, 'state.json')));
  f.receipt = () => JSON.parse(fs.readFileSync(path.join(stage, 'receipt.json')));
  f.lock = () => JSON.parse(fs.readFileSync(path.join(store, 'deployment.lock')));
  f.head = area => git(roots[area], 'rev-parse', 'HEAD');
  f.getProvider = file => {
    const module = require(file);
    return { ...module, createReleaseEngine(options) {
      const engine = module.createReleaseEngine({ ...options, run });
      return new Proxy(engine, { get(target, name) {
        const value = target[name];
        if (typeof value !== 'function') return value;
        return (...args) => {
          const result = value(...args);
          hooks.get(name)?.(result, args, file);
          return result;
        };
      } });
    } };
  };
  f.options = extra => ({ roots, store, stage, dbFile, run, getProvider: f.getProvider,
    flush: async () => { events.push({ action: 'authoritative-flush' }); if (f.flushError) throw f.flushError; },
    getHealth: async () => ({ ok: true, commit: f.healthCommit.slice(0, 7), checkout: f.healthCommit.slice(0, 7), blob: serverBlob.slice(0, 7), taktFehler: 0, checks: { database: true, simulation: true, persistence: true }, ...f.healthPatch }),
    beforePairWrite: () => f.pairHook?.(), ...extra });
  f.upgrade = () => createUpgrade(f.options());
  t.after(() => {
    try { assert.deepEqual(fs.readFileSync(dbFile), database, 'The live fixture database is never restored or changed.'); }
    finally { fs.rmSync(base, { recursive: true, force: true }); }
  });
  return f;
}

function breakReceipt(f) {
  const file = path.join(f.stage, 'receipt.json'), bytes = fs.readFileSync(file), outside = path.join(f.base, 'receipt-decoy');
  fs.writeFileSync(outside, bytes, { mode: 0o600 }); fs.unlinkSync(file); fs.symlinkSync(outside, file);
  return () => { fs.unlinkSync(file); fs.writeFileSync(file, bytes, { mode: 0o600 }); };
}

test('operator CLI rejects unknown actions and extra arguments before touching any installation', () => {
  for (const args of [[], ['deploy'], ['prepare', '/tmp/free-path'], ['finish-rollback-healthy', 'true']]) {
    const result = spawnSync(process.execPath, [helperFile, ...args], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.error, undefined); assert.equal(result.signal, null); assert.equal(result.status, 2); assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
  }
});

test('prepare archives the actual current source and verifies a fresh backup before any source or pair change', linux, async t => {
  const f = fixture(t), result = await f.upgrade().prepare();
  assert.equal(result.prepared, true); assert.equal(result.backupVerified, true); assert.notEqual(result.requestId, f.config.oldRequestId);
  assert.equal(f.head('backend'), f.config.oldCommit); assert.equal(f.lock().requestId, result.requestId); assert.equal(f.receipt().phase, 'prepared');
  const archive = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(f.store, result.checkpoint, 'source.json.gz'))));
  assert.equal(archive.version, 2); assert.equal(archive.backendCommit, f.config.oldCommit); assert.equal(archive.frontendCommit, f.config.frontendCommit);
  assert.equal(f.state().backup.verified, true);
  for (const requestId of [f.config.oldRequestId, result.requestId]) assert.deepEqual(zlib.gunzipSync(fs.readFileSync(path.join(f.store, 'backups', requestId + '.db.json.gz'))), f.database);
  assert.deepEqual(fs.readFileSync(path.join(f.store, f.previous.id, 'source.json.gz')), f.oldArchiveBytes);
  assert.deepEqual(fs.readFileSync(path.join(f.stage, 'old-engine.cjs')), f.oldBytes); assert.deepEqual(fs.readFileSync(path.join(f.store, 'engine.cjs')), f.oldBytes);
  assert.equal(f.events.filter(value => value.action === 'authoritative-flush').length, 1);
});

test('the exact fast-forward installs a matching private pair and requires running health before final archive completion', linux, async t => {
  const f = fixture(t), u = f.upgrade(); await u.prepare(); assert.equal(u.apply().installed, true);
  assert.equal(f.head('backend'), f.config.newCommit); assert.equal(f.receipt().phase, 'installed'); assert.equal(f.state().phase, 'external-deploy');
  assert.equal(sha(fs.readFileSync(path.join(f.store, 'engine.cjs'))), f.config.newEngineSha256);
  await assert.rejects(u.finalize(), /running_health_unconfirmed/); assert.equal(f.lock().requestId, f.receipt().requestId);
  f.healthCommit = f.config.newCommit; const result = await u.finalize();
  assert.equal(result.archived, true); assert.equal(f.receipt().phase, 'complete'); assert.equal(f.state().current, result.id); assert.equal(f.state().phase, 'complete');
  assert.equal(fs.existsSync(path.join(f.store, 'deployment.lock')), false);
});

test('stale failed-transaction UUID cannot clear another reservation or write a preparation receipt', linux, async t => {
  const f = fixture(t); f.config.oldRequestId = crypto.randomUUID(); fs.writeFileSync(path.join(f.stage, 'config.json'), JSON.stringify(f.config));
  const before = f.state(); await assert.rejects(f.upgrade().prepare(), /stale_slot_identity_mismatch/);
  assert.deepEqual(f.state(), before); assert.equal(f.lock().requestId, f.held.requestId); assert.equal(fs.existsSync(path.join(f.stage, 'receipt.json')), false);
});

test('candidate bytes, private storage and source cleanliness fail closed without deleting untracked files', linux, async t => {
  const f = fixture(t); fs.appendFileSync(path.join(f.stage, 'candidate-engine.cjs'), '\n// altered');
  assert.throws(() => f.upgrade(), /candidate_hash_mismatch/); fs.writeFileSync(path.join(f.stage, 'candidate-engine.cjs'), f.newBytes);
  fs.chmodSync(f.stage, 0o755); assert.throws(() => f.upgrade(), /private_storage_required/); fs.chmodSync(f.stage, 0o700);
  const untracked = path.join(f.roots.backend, 'fixture-untracked.log'); fs.writeFileSync(untracked, 'keep');
  await assert.rejects(f.upgrade().prepare(), /source_pin_or_cleanliness_mismatch/);
  assert.equal(fs.statSync(untracked).size, 4); assert.equal(f.lock().requestId, f.held.requestId);
});

test('changed server blob and unrelated public scope cannot reach the fast-forward', linux, async t => {
  for (const options of [{ changedServer: true }, { extraFile: 'game-rules.js' }]) {
    const f = fixture(t, options), u = f.upgrade(); await u.prepare();
    assert.throws(() => u.apply(), options.changedServer ? /candidate_commit_mismatch/ : /upgrade_scope_mismatch/);
    assert.equal(f.head('backend'), f.config.oldCommit); assert.equal(f.state().phase, 'external-deploy'); assert.equal(f.receipt().phase, 'prepared');
  }
});

test('failed authoritative flush keeps truthful old failure state and a resumable durable intent', linux, async t => {
  const f = fixture(t); f.flushError = new Error('fixture_flush_failed');
  await assert.rejects(f.upgrade().prepare(), /fixture_flush_failed/);
  assert.equal(f.state().phase, 'external-unconfirmed'); assert.equal(f.receipt().phase, 'preparing'); assert.equal(fs.existsSync(path.join(f.store, 'deployment.lock')), false);
  f.flushError = null; const result = await f.upgrade().prepare(); assert.equal(result.prepared, true); assert.equal(f.lock().requestId, result.requestId);
});

test('a crash after native reservation but before prepared receipt resumes only its pre-recorded UUID', linux, async t => {
  const f = fixture(t); let restore;
  f.hooks.set('beforeExternal', () => { f.hooks.delete('beforeExternal'); restore = breakReceipt(f); });
  await assert.rejects(f.upgrade().prepare(), /symlink_rejected/); restore();
  const intent = f.receipt(); assert.equal(intent.phase, 'preparing'); assert.equal(f.state().requestId, intent.requestId); assert.equal(f.lock().requestId, intent.requestId);
  const result = await f.upgrade().prepare(); assert.equal(result.requestId, intent.requestId); assert.equal(f.receipt().phase, 'prepared');
});

test('a foreign reservation during an interrupted preparation is neither adopted nor removed', linux, async t => {
  const f = fixture(t); f.flushError = new Error('stop_after_intent'); await assert.rejects(f.upgrade().prepare(), /stop_after_intent/);
  const foreign = { requestId: crypto.randomUUID(), action: 'external-deploy', createdAt: Date.now() };
  fs.writeFileSync(path.join(f.store, 'deployment.lock'), JSON.stringify(foreign), { mode: 0o600 }); f.flushError = null;
  await assert.rejects(f.upgrade().prepare()); assert.deepEqual(f.lock(), foreign); assert.equal(f.head('backend'), f.config.oldCommit);
});

test('partial pair installation preserves its reservation and can restore old source and pair through native rollback', linux, async t => {
  const f = fixture(t), u = f.upgrade(); await u.prepare(); const target = path.join(f.store, 'runtime-contract.json'), decoy = path.join(f.base, 'contract-decoy');
  f.pairHook = () => { f.pairHook = null; fs.writeFileSync(decoy, f.contractBytes, { mode: 0o600 }); fs.unlinkSync(target); fs.symlinkSync(decoy, target); };
  assert.throws(() => u.apply(), /symlink_rejected/); assert.equal(f.head('backend'), f.config.newCommit); assert.equal(f.receipt().phase, 'applying');
  assert.equal(sha(fs.readFileSync(path.join(f.store, 'engine.cjs'))), f.config.newEngineSha256); assert.equal(f.lock().requestId, f.receipt().requestId);
  fs.unlinkSync(target); fs.writeFileSync(target, f.contractBytes, { mode: 0o600 }); assert.equal(f.upgrade().rollback().restored, true);
  assert.equal(f.head('backend'), f.config.oldCommit); assert.deepEqual(fs.readFileSync(path.join(f.store, 'engine.cjs')), f.oldBytes); assert.equal(f.state().phase, 'external-rollback-pending');
});

test('rollback can resume after native source restoration and an interrupted pair write', linux, async t => {
  const f = fixture(t), u = f.upgrade(); await u.prepare(); u.apply(); f.pairHook = () => { f.pairHook = null; throw new Error('fixture_pair_interrupted'); };
  assert.throws(() => u.rollback(), /fixture_pair_interrupted/); assert.equal(f.head('backend'), f.config.oldCommit); assert.equal(f.state().phase, 'external-rollback-pending'); assert.equal(f.receipt().phase, 'installed');
  assert.equal(f.upgrade().rollback().restored, true); assert.equal(f.receipt().phase, 'rollback-pending'); assert.deepEqual(fs.readFileSync(path.join(f.store, 'engine.cjs')), f.oldBytes);
});

test('finalize resumes a completed native archive after an interrupted receipt write and validates its exact current ID', linux, async t => {
  const f = fixture(t), u = f.upgrade(); await u.prepare(); u.apply(); f.healthCommit = f.config.newCommit; let restore;
  f.hooks.set('afterExternal', (_result, args, file) => { if (file.endsWith('candidate-engine.cjs') && args[0].success) { f.hooks.delete('afterExternal'); restore = breakReceipt(f); } });
  await assert.rejects(u.finalize(), /symlink_rejected/); restore(); const completed = f.state();
  assert.equal(completed.phase, 'complete'); assert.equal(fs.existsSync(path.join(f.store, 'deployment.lock')), false); assert.equal(f.receipt().phase, 'installed');
  const result = await f.upgrade().finalize(); assert.equal(result.id, completed.current); assert.equal(f.receipt().phase, 'complete'); assert.equal(f.state().current, completed.current);
});

test('healthy source rollback remains explicitly archive-incompatible with the restored old v1 provider', linux, async t => {
  const f = fixture(t), u = f.upgrade(); await u.prepare(); u.apply(); u.rollback();
  const result = await u.finishRollback(true); assert.equal(result.health, true); assert.equal(result.archiveCompatible, false); assert.equal(result.backupVerified, true);
  assert.equal(f.state().phase, 'external-unconfirmed'); assert.equal(f.receipt().phase, 'rolled-back-archive-unconfirmed'); assert.equal(fs.existsSync(path.join(f.store, 'deployment.lock')), false);
  assert.deepEqual(fs.readFileSync(path.join(f.store, 'engine.cjs')), f.oldBytes); assert.deepEqual(fs.readFileSync(path.join(f.store, 'runtime-contract.json')), f.contractBytes);
});

test('unhealthy rollback retains the shared lock and never reports complete or a restored database', linux, async t => {
  const f = fixture(t), u = f.upgrade(); await u.prepare(); u.apply(); u.rollback();
  const result = await u.finishRollback(false); assert.equal(result.health, false); assert.equal(result.archiveCompatible, false);
  assert.equal(f.state().phase, 'external-rollback-unconfirmed'); assert.equal(f.receipt().phase, 'rollback-unconfirmed'); assert.equal(f.lock().requestId, f.receipt().requestId);
});

test('wrong running checkout, blob, simulation or persistence cannot finalize or release its lock', linux, async t => {
  const f = fixture(t), u = f.upgrade(); await u.prepare(); u.apply(); f.healthCommit = f.config.newCommit;
  for (const patch of [{ checkout: f.config.oldCommit.slice(0, 7) }, { blob: '0'.repeat(7) }, { taktFehler: 1 }, { checks: { database: true, simulation: false, persistence: true } }, { checks: { database: true, simulation: true, persistence: false } }]) {
    f.healthPatch = patch; await assert.rejects(u.finalize(), /running_health_unconfirmed/); assert.equal(f.state().phase, 'external-deploy'); assert.equal(f.lock().requestId, f.receipt().requestId);
  }
});

test('resumed old-slot preparation revalidates its external action before native old-API cleanup', linux, async t => {
  const f = fixture(t);
  const interruptedProvider = file => {
    const module = f.getProvider(file);
    if (!file.endsWith('old-engine.cjs')) return module;
    return { ...module, createReleaseEngine(options) { const engine = module.createReleaseEngine(options); engine.afterExternal = () => { throw new Error('before_old_cleanup'); }; return engine; } };
  };
  await assert.rejects(createUpgrade(f.options({ getProvider: interruptedProvider })).prepare(), /before_old_cleanup/);
  assert.equal(f.receipt().phase, 'preparing'); assert.equal(f.state().phase, 'external-deploy');
  const changed = { ...f.lock(), action: 'engine-install' }; fs.writeFileSync(path.join(f.store, 'deployment.lock'), JSON.stringify(changed));
  await assert.rejects(f.upgrade().prepare()); assert.deepEqual(f.lock(), changed); assert.equal(f.state().phase, 'external-deploy');
});

function crashPrepare(f, point, exitCode) {
  const settings = JSON.stringify({ roots: f.roots, store: f.store, stage: f.stage, dbFile: f.dbFile });
  const driver = `const fs=require('node:fs'),cp=require('node:child_process');
const options=${settings};const originalUnlink=fs.unlinkSync;
if(${JSON.stringify(point)}==='old-release')fs.unlinkSync=function(file){if(file===options.store+'/deployment.lock')process.exit(${exitCode});return originalUnlink.call(fs,file);};
options.run=(command,args,extra)=>cp.execFileSync(command,args,extra);
options.flush=async()=>{};
options.getProvider=file=>{const module=require(file);return{...module,createReleaseEngine(settings){return module.createReleaseEngine({...settings,run(command,args,extra){if(${JSON.stringify(point)}==='new-acquire'&&args.includes('diff')&&args.includes('--name-only'))process.exit(${exitCode});return cp.execFileSync(command,args,extra);}});}};};
require(${JSON.stringify(helperFile)}).createUpgrade(options).prepare().then(()=>process.exit(90)).catch(error=>{process.stderr.write(String(error));process.exit(91);});`;
  const result = spawnSync(process.execPath, ['-e', driver], { encoding: 'utf8', timeout: 20000 });
  assert.equal(result.error, undefined); assert.equal(result.signal, null); assert.equal(result.status, exitCode); assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
}

test('real process exit between old truthful state-write and unlink resumes only the verified old reservation', linux, async t => {
  const f = fixture(t); crashPrepare(f, 'old-release', 73);
  assert.equal(f.state().phase, 'external-unconfirmed'); assert.equal(f.lock().requestId, f.config.oldRequestId); assert.equal(f.receipt().phase, 'preparing');
  const result = await f.upgrade().prepare(); assert.equal(result.prepared, true); assert.notEqual(result.requestId, f.config.oldRequestId); assert.equal(f.lock().requestId, result.requestId);
});

test('real process exit after new acquire but before archive state safely cancels only its durable-intent UUID', linux, async t => {
  const f = fixture(t); crashPrepare(f, 'new-acquire', 74);
  const intent = f.receipt(); assert.equal(intent.phase, 'preparing'); assert.equal(f.state().phase, 'external-unconfirmed'); assert.equal(f.lock().requestId, intent.requestId);
  assert.equal(typeof intent.priorStateSha256, 'string');
  const result = await f.upgrade().prepare(); assert.equal(result.prepared, true); assert.notEqual(result.requestId, intent.requestId); assert.equal(f.lock().requestId, result.requestId);
});

test('finish rollback resumes an already truthful archive-incompatible result after interrupted receipt writing', linux, async t => {
  const f = fixture(t), u = f.upgrade(); await u.prepare(); u.apply(); u.rollback(); let restore;
  f.hooks.set('completeExternalRollback', () => { f.hooks.delete('completeExternalRollback'); restore = breakReceipt(f); });
  await assert.rejects(u.finishRollback(true), /symlink_rejected/); restore();
  assert.equal(f.state().phase, 'external-unconfirmed'); assert.equal(fs.existsSync(path.join(f.store, 'deployment.lock')), false); assert.equal(f.receipt().phase, 'rollback-pending');
  const result = await f.upgrade().finishRollback(true); assert.equal(result.health, true); assert.equal(result.archiveCompatible, false); assert.equal(f.receipt().phase, 'rolled-back-archive-unconfirmed');
});
