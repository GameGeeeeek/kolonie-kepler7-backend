'use strict';
// Local operator bootstrap only. No HTTP action, arbitrary command or database restore.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const http = require('node:http');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const SHA = /^[a-f0-9]{64}$/, COMMIT = /^[a-f0-9]{40}$/, UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
function createUpgrade({ roots = { backend: '/app', frontend: '/deploy/kolonie-kepler7', web: '/deploy/web' },
  store = '/data/operations-releases', stage = '/data/operations-releases/archive-upgrade',
  dbFile = process.env.DB_FILE,
  run = (command, args) => execFileSync(command, args, { timeout: 60000, maxBuffer: 4 * 1024 * 1024 }),
  flush = () => require(path.join(roots.backend, 'operations-release-guard.js')).flush(),
  getProvider = file => require(file), beforePairWrite = () => {},
  getHealth = () => new Promise((resolve, reject) => {
    const port = Number(process.env.PORT || 3001);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return reject(new Error('invalid_health_port'));
    const request = http.get({ hostname: '127.0.0.1', port, path: '/api/health' }, response => {
      let raw = ''; response.on('data', chunk => { raw += chunk; if (raw.length > 65536) response.destroy(new Error('health_response_limit')); });
      response.on('error', reject); response.on('end', () => {
        try { if (response.statusCode !== 200) throw new Error('health_unconfirmed'); resolve(JSON.parse(raw)); }
        catch { reject(new Error('health_unconfirmed')); }
      });
    });
    request.setTimeout(10000, () => request.destroy(new Error('health_unconfirmed'))); request.on('error', reject);
  }) } = {}) {
  const fail = message => { throw new Error(message); };
  const check = (file, directory = false) => {
    if (!path.isAbsolute(file)) fail('absolute_path_required');
    let current = path.parse(file).root;
    for (const part of file.slice(current.length).split(path.sep)) {
      current = path.join(current, part); if (fs.lstatSync(current).isSymbolicLink()) fail('symlink_rejected');
    }
    const info = fs.lstatSync(file);
    if ((directory ? !info.isDirectory() : !info.isFile()) || typeof process.getuid === 'function' && info.uid !== process.getuid() || info.mode & 0o077) fail('private_storage_required');
    return info;
  };
  const read = (file, maximum = 2 * 1024 * 1024) => {
    const info = check(file); if (info.size > maximum) fail('bounded_file_required');
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { const raw = fs.readFileSync(fd); if (raw.length !== info.size) fail('file_changed'); return raw; }
    finally { fs.closeSync(fd); }
  };
  const syncDirectory = directory => { const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } };
  const save = (file, raw, exclusive = false) => {
    check(path.dirname(file), true);
    if (fs.existsSync(file)) { check(file); if (exclusive) fail('receipt_already_exists'); }
    const temporary = file + '.' + crypto.randomBytes(12).toString('hex') + '.tmp';
    const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, raw); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    // The operator's own shared deployment reservation protects this pair.
    fs.renameSync(temporary, file); syncDirectory(path.dirname(file));
    if (!read(file).equals(raw)) fail('private_write_readback_failed');
  };
  check(store, true); check(stage, true);
  const config = JSON.parse(read(path.join(stage, 'config.json')));
  const keys = ['frontendCommit', 'newCommit', 'newEngineSha256', 'oldCommit', 'oldEngineSha256', 'oldRequestId', 'runtimeProof', 'serverBlob'];
  if (Object.keys(config).sort().join(',') !== keys.sort().join(',') ||
      ![config.oldCommit, config.newCommit, config.frontendCommit, config.serverBlob].every(value => COMMIT.test(value || '')) ||
      ![config.oldEngineSha256, config.newEngineSha256, config.runtimeProof].every(value => SHA.test(value || '')) || !UUID.test(config.oldRequestId || '') ||
      config.oldEngineSha256 === config.newEngineSha256 || config.oldCommit === config.newCommit) fail('invalid_upgrade_config');
  const newFile = path.join(stage, 'candidate-engine.cjs'), newBytes = read(newFile);
  if (hash(newBytes) !== config.newEngineSha256) fail('candidate_hash_mismatch');
  const provider = getProvider(newFile).createReleaseEngine({ roots, store, dbFile, runtimeProof: config.runtimeProof });
  const git = (area, ...args) => run('/usr/bin/git', ['--no-optional-locks', '-c', 'safe.directory=' + roots[area], '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', roots[area], ...args]);
  const text = (area, ...args) => git(area, ...args).toString('utf8').trim();
  const state = () => JSON.parse(read(path.join(store, 'state.json'), 65536));
  const lock = () => JSON.parse(read(path.join(store, 'deployment.lock'), 4096));
  const receiptFile = path.join(stage, 'receipt.json');
  const receipt = () => {
    const value = JSON.parse(read(receiptFile, 65536));
    if (value.configSha256 !== hash(Buffer.from(JSON.stringify(config))) || !UUID.test(value.requestId || '')) fail('receipt_config_mismatch');
    return value;
  };
  const record = value => save(receiptFile, Buffer.from(JSON.stringify(value)));
  const legacyIdle = () => {
    for (const repo of ['kolonie-kepler7', 'kolonie-kepler7-backend']) for (const suffix of ['lock', 'pending'])
      if (fs.existsSync('/tmp/kepler7-deploy-' + repo + '.' + suffix)) fail('legacy_deployment_busy');
  };
  const own = (value, phases) => {
    legacyIdle(); const current = state(), held = lock();
    if (held.requestId !== value.requestId || held.action !== 'external-deploy' || !phases.includes(current.phase) ||
        current.phase !== 'complete' && current.requestId !== value.requestId) fail('upgrade_reservation_mismatch');
    return current;
  };
  const source = commit => {
    if (text('backend', 'rev-parse', 'HEAD') !== commit || text('frontend', 'rev-parse', 'HEAD') !== config.frontendCommit ||
        text('backend', 'rev-parse', commit + ':server.js') !== config.serverBlob ||
        text('backend', 'status', '--porcelain') || text('frontend', 'status', '--porcelain')) fail('source_pin_or_cleanliness_mismatch');
  };
  const pair = (expectedHash, bytes, contractBytes) => {
    beforePairWrite();
    save(path.join(store, 'engine.cjs'), bytes);
    save(path.join(store, 'runtime-contract.json'), contractBytes);
    const contract = JSON.parse(read(path.join(store, 'runtime-contract.json')));
    if (hash(read(path.join(store, 'engine.cjs'))) !== expectedHash || contract.engineSha256 !== expectedHash || contract.runtimeProof !== config.runtimeProof) fail('pair_readback_failed');
  };
  const checkPair = expectedHash => {
    const code = read(path.join(store, 'engine.cjs')), contractBytes = read(path.join(store, 'runtime-contract.json')), contract = JSON.parse(contractBytes);
    if (hash(code) !== expectedHash || contract.engineSha256 !== expectedHash || contract.runtimeProof !== config.runtimeProof) fail('pair_pin_mismatch');
    return { code, contractBytes };
  };
  const health = async commit => {
    const value = await getHealth();
    if (value.ok !== true || value.commit !== commit.slice(0, 7) || value.checkout !== commit.slice(0, 7) || value.blob !== config.serverBlob.slice(0, 7) ||
        value.taktFehler !== 0 || !['database', 'simulation', 'persistence'].every(name => value.checks?.[name] === true)) fail('running_health_unconfirmed');
  };
  const preserved = (name, bytes) => {
    const file = path.join(stage, name);
    if (fs.existsSync(file)) { if (!read(file).equals(bytes)) fail('preserved_pair_mismatch'); }
    else save(file, bytes, true);
  };
  return {
    async prepare() {
      legacyIdle(); source(config.oldCommit);
      const old = checkPair(config.oldEngineSha256);
      let value;
      if (fs.existsSync(receiptFile)) {
        value = receipt(); if (value.phase !== 'preparing') fail('invalid_upgrade_phase');
      } else {
        const current = state(), held = lock();
        if (current.phase !== 'external-deploy' || current.requestId !== config.oldRequestId || held.requestId !== config.oldRequestId || held.action !== 'external-deploy') fail('stale_slot_identity_mismatch');
        preserved('old-engine.cjs', old.code); preserved('old-contract.json', old.contractBytes);
        preserved('original-state.json', Buffer.from(JSON.stringify(current)));
        value = { version: 1, phase: 'preparing', configSha256: hash(Buffer.from(JSON.stringify(config))), requestId: crypto.randomUUID() };
        record(value);
      }
      if (hash(read(path.join(stage, 'old-engine.cjs'))) !== config.oldEngineSha256 || !read(path.join(stage, 'old-contract.json')).equals(old.contractBytes)) fail('preserved_pair_mismatch');
      let current = state();
      if (['external-deploy', 'external-unconfirmed'].includes(current.phase) && current.requestId === config.oldRequestId && fs.existsSync(path.join(store, 'deployment.lock')) && lock().requestId === config.oldRequestId) {
        const held = lock();
        if (held.action !== 'external-deploy') fail('stale_slot_identity_mismatch');
        // Clears only the identified failed transaction through its original API.
        getProvider(path.join(stage, 'old-engine.cjs')).createReleaseEngine({ roots, store, runtimeProof: config.runtimeProof, dbFile }).afterExternal({ requestId: config.oldRequestId, success: false });
        current = state();
      }
      if (current.phase === 'external-deploy' && current.requestId === value.requestId) {
        own(value, ['external-deploy']); if (current.backup?.verified !== true) fail('verified_backup_required');
        value = { ...value, phase: 'prepared', checkpoint: current.current, backup: current.backup }; record(value);
        return { prepared: true, requestId: value.requestId, checkpoint: value.checkpoint, backupVerified: true };
      }
      if (current.phase !== 'external-unconfirmed' || current.requestId !== config.oldRequestId) fail('stale_slot_identity_mismatch');
      const priorStateSha256 = hash(Buffer.from(JSON.stringify(current)));
      if (value.priorStateSha256 && value.priorStateSha256 !== priorStateSha256) fail('prior_state_changed');
      if (fs.existsSync(path.join(store, 'deployment.lock'))) {
        if (!value.priorStateSha256) fail('unidentified_preparation_lock');
        provider.cancelExternalPreparation({ requestId: value.requestId, priorStateSha256 });
        value = { ...value, requestId: crypto.randomUUID() };
      } else if (value.priorStateSha256) value = { ...value, requestId: crypto.randomUUID() };
      value = { ...value, priorStateSha256 }; record(value);
      await flush(); legacyIdle(); source(config.oldCommit);
      const prepared = provider.beforeExternal('kolonie-kepler7-backend', { requestId: value.requestId });
      if (prepared.backupVerified !== true) fail('verified_backup_required');
      value = { ...value, phase: 'prepared', checkpoint: prepared.previous, backup: state().backup };
      record(value); own(value, ['external-deploy']); return { prepared: true, requestId: value.requestId, checkpoint: value.checkpoint, backupVerified: true };
    },
    apply() {
      const value = receipt(); if (value.phase !== 'prepared') fail('invalid_upgrade_phase');
      own(value, ['external-deploy']); source(config.oldCommit);
      if (text('backend', 'rev-parse', '--verify', config.newCommit + '^{commit}') !== config.newCommit ||
          text('backend', 'rev-parse', config.newCommit + ':server.js') !== config.serverBlob || hash(git('backend', 'cat-file', 'blob', config.newCommit + ':operations-release-engine.cjs')) !== config.newEngineSha256) fail('candidate_commit_mismatch');
      git('backend', 'merge-base', '--is-ancestor', config.oldCommit, config.newCommit);
      const allowed = name => name === 'operations-release-engine.cjs' || name === 'docs/operations.md' || name === '.github/workflows/operations.yml' || /^tests\/[A-Za-z0-9_./-]+$/.test(name) || name === 'tools/upgrade-release-archive.cjs';
      const changes = text('backend', 'diff', '--name-only', config.oldCommit, config.newCommit).split(/\n/).filter(Boolean);
      if (!changes.length || !changes.every(allowed)) fail('upgrade_scope_mismatch');
      record({ ...value, phase: 'applying' });
      git('backend', 'merge', '--ff-only', config.newCommit); source(config.newCommit);
      pair(config.newEngineSha256, newBytes, Buffer.from(JSON.stringify({ version: 1, engineSha256: config.newEngineSha256, runtimeProof: config.runtimeProof })));
      record({ ...value, phase: 'installed' }); return { installed: true, restartRequired: true };
    },
    async finalize() {
      const value = receipt(); if (value.phase !== 'installed') fail('invalid_upgrade_phase');
      legacyIdle(); source(config.newCommit); checkPair(config.newEngineSha256); await health(config.newCommit);
      let result;
      if (fs.existsSync(path.join(store, 'deployment.lock'))) {
        own(value, ['external-deploy', 'complete']); result = provider.afterExternal({ requestId: value.requestId, success: true });
      } else {
        const current = state();
        if (current.phase !== 'complete' || current.requestId !== value.requestId || !current.current?.startsWith(config.newCommit + '-')) fail('final_archive_unconfirmed');
        const verified = provider.publish();
        if (verified.published !== true || verified.id !== current.current) fail('final_archive_unconfirmed');
        result = { archived: true, id: verified.id };
      }
      if (result.archived !== true || state().phase !== 'complete' || fs.existsSync(path.join(store, 'deployment.lock'))) fail('final_archive_unconfirmed');
      record({ ...value, phase: 'complete', archive: result.id }); return { archived: true, id: result.id };
    },
    rollback() {
      const value = receipt(); if (!['prepared', 'applying', 'installed'].includes(value.phase)) fail('invalid_upgrade_phase');
      legacyIdle();
      const current = state();
      if (current.phase === 'external-rollback-pending') {
        own(value, ['external-rollback-pending']); if (current.current !== value.checkpoint) fail('rollback_checkpoint_mismatch');
      } else {
        const result = provider.abortExternal({ requestId: value.requestId });
        if (result.restored !== true) fail('rollback_unconfirmed');
      }
      source(config.oldCommit);
      pair(config.oldEngineSha256, read(path.join(stage, 'old-engine.cjs')), read(path.join(stage, 'old-contract.json')));
      record({ ...value, phase: 'rollback-pending' }); return { restored: true, restartRequired: true };
    },
    async finishRollback(healthy) {
      if (typeof healthy !== 'boolean') fail('health_boolean_required');
      const value = receipt(); if (value.phase !== 'rollback-pending') fail('invalid_upgrade_phase');
      legacyIdle(); source(config.oldCommit); checkPair(config.oldEngineSha256);
      if (healthy) await health(config.oldCommit);
      let result;
      if (fs.existsSync(path.join(store, 'deployment.lock'))) {
        own(value, ['external-rollback-pending']); result = provider.completeExternalRollback({ requestId: value.requestId, healthy });
      } else {
        const current = state();
        if (!healthy || current.phase !== 'external-unconfirmed' || current.requestId !== value.requestId || current.current !== value.checkpoint) fail('rollback_unconfirmed');
        const verified = provider.publish(); if (!verified.published || verified.id !== value.checkpoint) fail('rollback_unconfirmed');
        result = { health: true, archiveCompatible: false, rolledBack: true, backupVerified: current.backup?.verified === true };
      }
      record({ ...value, phase: result.health ? 'rolled-back-archive-unconfirmed' : 'rollback-unconfirmed' }); return result;
    }
  };
}
module.exports = { createUpgrade };
if (require.main === module) {
  const actions = { prepare: 'prepare', apply: 'apply', finalize: 'finalize', rollback: 'rollback', 'finish-rollback-healthy': 'finishRollback' };
  const action = process.argv[2];
  if (process.argv.length !== 3 || !Object.hasOwn(actions, action)) process.exitCode = 2;
  else Promise.resolve().then(() => createUpgrade()[actions[action]](...(action === 'finish-rollback-healthy' ? [true] : [])))
    .then(result => process.stdout.write(JSON.stringify(result) + '\n')).catch(error => { process.stderr.write(JSON.stringify({ error: error.code || error.message }) + '\n'); process.exitCode = 1; });
}
