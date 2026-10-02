'use strict';
/* oxlint-disable typescript/no-require-imports -- Kepler loads this exact CommonJS module in its existing backend and private recovery process. */
// Host control and both existing deploy paths use this one private archive/lock.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const ID = /^[a-f0-9]{40}-[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const canonical = value => JSON.stringify(value);
const fail = code => { throw Object.assign(new Error(code), { code }); };
const MAX_BYTES = 256 * 1024 * 1024;
const PUBLIC_FILE = /\.(?:html|css|js|mjs|json|webmanifest|xml|txt|png|jpe?g|webp|gif|svg|ico|woff2?|ttf|mp3|ogg|wasm|gz)$/i;
// Names only: excluded credentials are neither read nor restored by this engine.
const excluded = name => /(?:^|\/)(?:backups(?:\/|$)|(?:db|users|accounts|sessions)\.json$|\.env[^/]*$|[^/]*(?:private|secret|passwoerter|password|credential)[^/]*\.(?:txt|json|key|pem)$|[^/]*\.(?:key|pem|p12|pfx)$)/i.test(name);

function functionSource(source, name) {
  const start = source.indexOf('function ' + name + '(');
  if (start < 0) fail('loader_contract_missing');
  const open = source.indexOf('{', start); let depth = 0, quote = null, comment = null;
  for (let i = open; i < source.length; i++) {
    const c = source[i], next = source[i + 1];
    if (comment === 'line') { if (c === '\n') comment = null; continue; }
    if (comment === 'block') { if (c === '*' && next === '/') { comment = null; i++; } continue; }
    if (quote) { if (c === '\\') { i++; continue; } if (c === quote) quote = null; continue; }
    if (c === '/' && next === '/') { comment = 'line'; i++; continue; }
    if (c === '/' && next === '*') { comment = 'block'; i++; continue; }
    if (['"', "'", '`'].includes(c)) { quote = c; continue; }
    if (c === '{') depth++;
    if (c === '}' && --depth === 0) return source.slice(start, i + 1).replace(/\r\n/g, '\n');
  }
  fail('loader_contract_missing');
}
function schemaProof(source) {
  return { format: 'kepler-json-users-private-shared-v1',
    loader: sha(functionSource(source, 'loadDb')),
    save: sha(functionSource(source, 'performDbWrite')),
    auth: sha(functionSource(source, 'authMiddleware')),
    lookup: sha(functionSource(source, 'findUserById')) };
}

// Source compatibility also includes the private administration and shared
// deployment boundary. A pre-bridge release may be archived as a baseline,
// but restoring it must never silently remove these capabilities.
function operationsProof(source, files) {
  const names = ['operations-admin.js', 'operations-release-guard.js', 'operations-health.js', 'operations-release-engine.cjs'];
  const required = names.map(name => files.find(file => file.area === 'backend' && file.name === name));
  if (required.some(file => !file)) return null;
  const install = /require\((['"])\.\/operations-admin\1\)\.installOperationsAdmin\(\{\s*dbFile:\s*DB_FILE,\s*getDb:\s*\(\)\s*=>\s*db,\s*saveDb,\s*opsHealth,\s*deployBackend:\s*\(\)\s*=>\s*starteDeploy\(\s*['"]kolonie-kepler7-backend['"],\s*DEPLOY_TARGETS\[['"]kolonie-kepler7-backend['"]\]\.command,\s*DEPLOY_TARGETS\[['"]kolonie-kepler7-backend['"]\]\.dir\s*\)\s*\}\)/;
  const health = /const\s+opsHealth\s*=\s*require\((['"])\.\/operations-health\1\)\.createOperationalHealth\(\{\s*dbFile:\s*DB_FILE\s*\}\)/;
  try {
    const deployment = functionSource(source, 'starteDeploy');
    const announcement = functionSource(source, 'ankuendigungAktuell');
    const installation = source.match(install);
    if (!installation || !health.test(source) ||
        !/require\((['"])\.\/operations-release-guard\1\)\.exec\(\s*repoName\s*,\s*command\s*,/.test(deployment) ||
        !/operationsAdminBridge\s*&&\s*operationsAdminBridge\.announcement\(/.test(announcement)) return null;
    return { format: 'kepler-private-operations-v1',
      bridge: sha(Buffer.from(required[0].data, 'base64')),
      guard: sha(Buffer.from(required[1].data, 'base64')),
      health: sha(Buffer.from(required[2].data, 'base64')),
      engine: sha(Buffer.from(required[3].data, 'base64')),
      installation: sha(installation[0].replace(/\s+/g, '')),
      deployment: sha(deployment), announcement: sha(announcement) };
  } catch { return null; }
}

function createReleaseEngine({ roots = { backend: '/app', frontend: '/deploy/kolonie-kepler7', web: '/deploy/web' },
  store = '/data/operations-releases', dbFile = process.env.DB_FILE, clock = Date.now,
  runtimeProof = sha('isolated-fixture-layout-v1'),
  run = (command, args, options = {}) => execFileSync(command, args, { timeout: 30000, maxBuffer: MAX_BYTES, ...options }) } = {}) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const engineHash = sha(fs.readFileSync(__filename));
  const noLinks = file => {
    const resolved = path.resolve(file), parts = resolved.slice(path.parse(resolved).root.length).split(path.sep);
    let current = path.parse(resolved).root;
    for (const part of parts) { current = path.join(current, part); if (fs.lstatSync(current).isSymbolicLink()) fail('unsafe_release_file'); }
  };
  const privateCheck = (file, directory = false) => {
    const info = fs.lstatSync(file);
    if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()) || uid !== null && info.uid !== uid || info.mode & 0o077) fail('unsafe_release_storage');
    return info;
  };
  const makeDirectory = (directory, mode) => {
    let parent = directory;
    while (!fs.existsSync(parent) && parent !== path.dirname(parent)) parent = path.dirname(parent);
    noLinks(parent);
    fs.mkdirSync(directory, { recursive: true, mode });
    noLinks(directory);
  };
  const boundedRead = (file, maximum = MAX_BYTES, privateFile = false) => {
    noLinks(file);
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { const info = fs.fstatSync(fd); if (!info.isFile() || info.size > maximum || privateFile && (uid !== null && info.uid !== uid || info.mode & 0o077)) fail('unsafe_release_file'); return fs.readFileSync(fd); }
    finally { fs.closeSync(fd); }
  };
  const writePrivate = (file, bytes, exclusive = false) => {
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | (exclusive ? fs.constants.O_EXCL : fs.constants.O_TRUNC) | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  };
  const atomic = (file, value) => {
    if (fs.existsSync(file)) privateCheck(file);
    const temporary = file + '.' + crypto.randomBytes(12).toString('hex') + '.tmp';
    writePrivate(temporary, Buffer.from(canonical(value)), true); fs.renameSync(temporary, file);
    const fd = fs.openSync(path.dirname(file), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  };
  const ready = () => {
    if (!path.isAbsolute(store) || !HASH.test(runtimeProof) || Object.values(roots).some(root => !path.isAbsolute(root))) fail('invalid_release_configuration');
    makeDirectory(store, 0o700); privateCheck(store, true);
    for (const root of Object.values(roots)) { noLinks(root); const info = fs.lstatSync(root); if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o022) fail('unsafe_release_source'); }
  };
  const stateFile = path.join(store, 'state.json'), lockFile = path.join(store, 'deployment.lock');
  const state = () => fs.existsSync(stateFile) ? JSON.parse(boundedRead(stateFile, 65536, true)) : { version: 1, current: null, previous: null, phase: 'uninitialized' };
  const git = (area, ...args) => run('/usr/bin/git', ['-c', 'safe.directory=' + roots[area], '-C', roots[area], ...args], { encoding: 'utf8' }).trim();
  const safeName = name => typeof name === 'string' && name.length < 240 && !name.startsWith('/') && !name.includes('\\') &&
    !name.split('/').some(part => !part || ['.', '..', '.git', 'node_modules'].includes(part)) && !Array.from(name).some(character => character.charCodeAt(0) < 32);
  const gitFiles = area => {
    const names = git(area, 'ls-files', '-z').split('\0').filter(Boolean);
    if (!names.length || names.length > 10000 || names.some(name => !safeName(name))) fail('unsafe_tracked_source');
    return names.filter(name => !excluded(name));
  };
  const trackedClean = area => !git(area, 'diff', '--name-only', '--no-renames', '-z', 'HEAD').split('\0').filter(Boolean).some(name => !excluded(name));
  const webFiles = () => {
    const names = [];
    const visit = (directory, prefix = '') => {
      for (const name of fs.readdirSync(directory).sort()) {
        if (name.startsWith('.') || excluded(prefix + name)) continue;
        const relative = prefix + name, file = path.join(directory, name), info = fs.lstatSync(file);
        if (!safeName(relative) || info.isSymbolicLink()) fail('unsafe_web_source');
        if (info.isDirectory()) visit(file, relative + '/');
        else if (info.isFile() && PUBLIC_FILE.test(relative)) names.push(relative);
        else fail('unsupported_web_file');
        if (names.length > 10000) fail('release_file_limit');
      }
    };
    visit(roots.web); return names;
  };
  const capture = () => {
    ready();
    for (const area of ['backend', 'frontend']) if (!trackedClean(area)) fail('dirty_release_source');
    const backendCommit = git('backend', 'rev-parse', 'HEAD'), frontendCommit = git('frontend', 'rev-parse', 'HEAD');
    if (!/^[a-f0-9]{40}$/.test(backendCommit) || !/^[a-f0-9]{40}$/.test(frontendCommit)) fail('invalid_source_revision');
    let bytes = 0;
    const files = [];
    for (const area of ['backend', 'frontend', 'web']) {
      for (const name of (area === 'web' ? webFiles() : gitFiles(area)).sort()) {
        const raw = boundedRead(path.join(roots[area], name), 16 * 1024 * 1024); bytes += raw.length;
        if (bytes > MAX_BYTES) fail('release_size_limit');
        files.push({ area, name, sha256: sha(raw), bytes: raw.length, data: raw.toString('base64') });
      }
    }
    const server = files.find(file => file.area === 'backend' && file.name === 'server.js');
    if (!server) fail('loader_contract_missing');
    const serverSource = Buffer.from(server.data, 'base64').toString('utf8');
    const proof = schemaProof(serverSource), operations = operationsProof(serverSource, files);
    const versionFile = files.find(file => file.area === 'web' && file.name === 'version.txt');
    const version = versionFile ? Buffer.from(versionFile.data, 'base64').toString('utf8').trim().slice(0, 40) : null;
    const identity = { backendCommit, frontendCommit, runtimeProof, proof, operationsProof: operations, files: files.map(({ data: _data, ...file }) => file) };
    const id = backendCommit + '-' + sha(canonical(identity));
    const directory = path.join(store, id), archive = { version: 1, id, createdAt: clock(), frontendVersion: version, ...identity, files };
    if (!fs.existsSync(directory)) {
      fs.mkdirSync(directory, { mode: 0o700 });
      writePrivate(path.join(directory, 'source.json.gz'), zlib.gzipSync(Buffer.from(canonical(archive)), { level: 9 }), true);
      writePrivate(path.join(directory, 'manifest.json'), Buffer.from(canonical({ ...archive, files: identity.files })), true);
    } else load(id);
    return archive;
  };
  const load = id => {
    if (!ID.test(id)) fail('invalid_release');
    const directory = path.join(store, id); privateCheck(directory, true);
    const archive = JSON.parse(zlib.gunzipSync(boundedRead(path.join(directory, 'source.json.gz'), MAX_BYTES, true), { maxOutputLength: 400 * 1024 * 1024 }));
    if (archive.version !== 1 || archive.id !== id || !Array.isArray(archive.files) || archive.files.length > 30000) fail('invalid_release_archive');
    let bytes = 0; const seen = new Set();
    for (const file of archive.files) {
      const key = file.area + '/' + file.name;
      if (!Object.hasOwn(roots, file.area) || !safeName(file.name) || excluded(file.name) || seen.has(key) || !HASH.test(file.sha256) || typeof file.data !== 'string') fail('invalid_release_archive');
      seen.add(key); const raw = Buffer.from(file.data, 'base64'); bytes += raw.length;
      if (raw.length !== file.bytes || sha(raw) !== file.sha256 || raw.length > 16 * 1024 * 1024 || bytes > MAX_BYTES) fail('invalid_release_archive');
    }
    const identity = { backendCommit: archive.backendCommit, frontendCommit: archive.frontendCommit, runtimeProof: archive.runtimeProof, proof: archive.proof,
      ...(Object.hasOwn(archive, 'operationsProof') ? { operationsProof: archive.operationsProof } : {}), files: archive.files.map(({ data: _data, ...file }) => file) };
    const server = archive.files.find(file => file.area === 'backend' && file.name === 'server.js');
    if (!server || !HASH.test(archive.runtimeProof ?? '') || !/^[a-f0-9]{40}$/.test(archive.frontendCommit ?? '') || archive.backendCommit + '-' + sha(canonical(identity)) !== id || canonical(schemaProof(Buffer.from(server.data, 'base64').toString('utf8'))) !== canonical(archive.proof)) fail('invalid_release_archive');
    const operations = operationsProof(Buffer.from(server.data, 'base64').toString('utf8'), archive.files);
    if (canonical(operations) !== canonical(archive.operationsProof ?? null)) fail('invalid_release_archive');
    archive.operationsProof ??= null;
    return archive;
  };
  const acquire = (requestId, action) => { ready(); if (!UUID.test(requestId)) fail('invalid_request'); writePrivate(lockFile, Buffer.from(canonical({ requestId, action, createdAt: clock() })), true); };
  const held = requestId => { const value = JSON.parse(boundedRead(lockFile, 4096, true)); if (value.requestId !== requestId) fail('deployment_busy'); return value; };
  const release = requestId => { held(requestId); fs.unlinkSync(lockFile); };
  const legacyLocks = ignore => {
    for (const name of ['kolonie-kepler7', 'kolonie-kepler7-backend']) if (name !== ignore && fs.existsSync(path.join(process.env.DEPLOY_LOCK_DIR || '/tmp', 'kepler7-deploy-' + name + '.lock'))) fail('legacy_deployment_busy');
  };
  const restore = archive => {
    for (const area of ['backend', 'frontend']) {
      const commit = area === 'backend' ? archive.backendCommit : archive.frontendCommit;
      git(area, 'cat-file', '-e', commit + '^{commit}');
      const files = archive.files.filter(file => file.area === area), wanted = new Set(files.map(file => file.name));
      // Check objects before changing source; only public manifest paths are read.
      const namesAtCommit = git(area, 'ls-tree', '-r', '--name-only', '-z', commit).split('\0').filter(Boolean).filter(name => !excluded(name));
      if (namesAtCommit.length !== wanted.size || namesAtCommit.some(name => !wanted.has(name))) fail('source_revision_mismatch');
      for (const file of files) {
        const raw = run('/usr/bin/git', ['-c', 'safe.directory=' + roots[area], '-C', roots[area], 'cat-file', 'blob', commit + ':' + file.name]);
        if (sha(raw) !== file.sha256) fail('source_revision_mismatch');
      }
      const priorCommit = git(area, 'rev-parse', 'HEAD');
      for (const name of gitFiles(area)) if (!wanted.has(name)) { const target = path.join(roots[area], name); noLinks(target); fs.unlinkSync(target); }
      for (const file of files) {
        const target = path.join(roots[area], file.name); makeDirectory(path.dirname(target), 0o755);
        if (fs.existsSync(target)) noLinks(target);
        const temporary = target + '.gg-release-' + crypto.randomBytes(6).toString('hex');
        const mode = git(area, 'ls-tree', commit, '--', file.name).startsWith('100755 ') ? 0o755 : 0o644;
        fs.writeFileSync(temporary, Buffer.from(file.data, 'base64'), { mode, flag: 'wx' }); fs.renameSync(temporary, target);
      }
      // Index/HEAD bookkeeping changes no excluded working-tree credential file.
      git(area, 'read-tree', commit); git(area, 'update-ref', 'HEAD', commit, priorCommit);
      if (!trackedClean(area)) fail('dirty_release_source');
    }
    const wanted = new Set(archive.files.filter(file => file.area === 'web').map(file => file.name));
    for (const name of webFiles()) if (!wanted.has(name)) fs.unlinkSync(path.join(roots.web, name));
    for (const file of archive.files.filter(file => file.area === 'web')) {
      const target = path.join(roots.web, file.name); makeDirectory(path.dirname(target), 0o755);
      if (fs.existsSync(target)) noLinks(target);
      const temporary = target + '.gg-release-' + crypto.randomBytes(6).toString('hex');
      fs.writeFileSync(temporary, Buffer.from(file.data, 'base64'), { mode: 0o644, flag: 'wx' }); fs.renameSync(temporary, target);
    }
  };
  const backup = requestId => {
    if (typeof dbFile !== 'string' || !path.isAbsolute(dbFile) || path.dirname(dbFile) !== '/data' && store === '/data/operations-releases') fail('invalid_database_configuration');
    const raw = boundedRead(dbFile, MAX_BYTES);
    let data; try { data = JSON.parse(raw); } catch { fail('backup_invalid'); }
    if (!data || !['users', 'private', 'shared'].every(key => data[key] && typeof data[key] === 'object' && !Array.isArray(data[key]))) fail('backup_invalid');
    const directory = path.join(store, 'backups'); makeDirectory(directory, 0o700); privateCheck(directory, true);
    const file = path.join(directory, requestId + '.db.json.gz'); writePrivate(file, zlib.gzipSync(raw, { level: 6 }), true);
    if (sha(zlib.gunzipSync(boundedRead(file, MAX_BYTES, true), { maxOutputLength: MAX_BYTES })) !== sha(raw)) fail('backup_readback_failed');
    return { verified: true, sha256: sha(raw), bytes: raw.length, createdAt: clock() };
  };
  const inventory = () => {
    ready(); const currentState = state();
    const current = currentState.current && ID.test(currentState.current) ? load(currentState.current) : null;
    const serverSource = boundedRead(path.join(roots.backend, 'server.js'), 2 * 1024 * 1024).toString('utf8');
    const proof = schemaProof(serverSource), liveFiles = [];
    for (const name of ['operations-admin.js', 'operations-release-guard.js', 'operations-health.js', 'operations-release-engine.cjs']) {
      try { liveFiles.push({ area: 'backend', name, data: boundedRead(path.join(roots.backend, name), 2 * 1024 * 1024).toString('base64') }); }
      catch { /* Missing or unsafe hooks make switching unavailable. */ }
    }
    const operations = operationsProof(serverSource, liveFiles);
    const important = new Set([currentState.current, currentState.previous]);
    const releases = fs.readdirSync(store).filter(name => ID.test(name)).sort((a, b) => Number(important.has(b)) - Number(important.has(a)) || fs.lstatSync(path.join(store, b)).mtimeMs - fs.lstatSync(path.join(store, a)).mtimeMs).slice(0, 40).map(id => {
      try { const archive = load(id); const compatible = !!operations && !!archive.operationsProof && operations.engine === engineHash && archive.runtimeProof === runtimeProof &&
          canonical(archive.proof) === canonical(proof) && canonical(archive.operationsProof) === canonical(operations);
        return { id, commit: archive.backendCommit, version: archive.frontendVersion, current: id === currentState.current,
          compatible, reason: compatible ? null : !operations || !archive.operationsProof ? 'Die private Verwaltung oder gemeinsame Releasesperre fehlt im Quellstand.' :
            'Der Daten-, Sitzungs- oder Verwaltungsvertrag unterscheidet sich.', createdAt: archive.createdAt };
      } catch { return { id, version: null, current: false, compatible: false, reason: 'Das Archiv konnte nicht verifiziert werden.' }; }
    }).sort((a, b) => b.createdAt - a.createdAt);
    return { current: current ? { id: current.id, version: current.frontendVersion, commit: current.backendCommit, previous: currentState.previous } : null,
      releases, releaseSwitch: !!current && !!operations && operations.engine === engineHash && !!current.operationsProof && currentState.phase === 'complete' && !fs.existsSync(lockFile),
      reason: !operations || !current?.operationsProof ? 'Die private Verwaltung und gemeinsame Releasesperre sind noch nicht vollständig im Quellstand.' :
        operations.engine !== engineHash ? 'Die gespeicherte Release-Engine stimmt nicht mit dem freigegebenen Quellstand überein.' :
        currentState.phase === 'complete' ? null : 'Die unveränderliche Kepler-Versionserfassung ist noch nicht abgeschlossen.' };
  };
  return {
    inventory,
    publish() {
      const requestId = crypto.randomUUID(); legacyLocks(); acquire(requestId, 'publish');
      try { const archive = capture(); return { published: true, id: archive.id }; }
      finally { release(requestId); }
    },
    initialize(input) {
      let requestId;
      if (input !== undefined && input !== null) {
        if (typeof input !== 'object' || Object.keys(input).join(',') !== 'requestId' || !UUID.test(input.requestId ?? '') || held(input.requestId).action !== 'engine-install') fail('invalid_request');
        requestId = input.requestId;
      } else { requestId = crypto.randomUUID(); legacyLocks(); acquire(requestId, 'initialize'); }
      try { const archive = capture(), prior = state(); atomic(stateFile, { version: 1, current: archive.id,
        previous: archive.id === prior.current ? prior.previous : prior.current, phase: 'complete' }); return { initialized: true, id: archive.id }; }
      finally { release(requestId); }
    },
    prepare(input) {
      if (!input || !UUID.test(input.requestId ?? '') || !ID.test(input.target ?? '') || !['deploy', 'rollback'].includes(input.mode)) fail('invalid_request');
      legacyLocks(); acquire(input.requestId, 'release-switch');
      const prior = state(); let before, changed = false;
      try {
        before = capture(); const target = load(input.target);
        if (input.target === before.id || input.mode === 'rollback' && prior.previous !== input.target || !before.operationsProof || !target.operationsProof || before.operationsProof.engine !== engineHash ||
            target.runtimeProof !== runtimeProof || canonical(target.proof) !== canonical(before.proof) ||
            canonical(target.operationsProof) !== canonical(before.operationsProof)) fail('release_incompatible');
        const verifiedBackup = backup(input.requestId);
        atomic(stateFile, { version: 1, current: before.id, previous: prior.previous, phase: 'applying', requestId: input.requestId, target: target.id, backup: verifiedBackup });
        changed = true;
        restore(target);
        return { prepared: true, requestId: input.requestId, target: target.id, previous: before.id, backupVerified: true };
      } catch (failure) {
        if (before && changed) { try { restore(before); } catch { fail('rollback_unconfirmed'); } }
        atomic(stateFile, { ...prior, phase: 'complete' }); release(input.requestId); throw failure;
      }
    },
    finish(input) {
      if (!input || !UUID.test(input.requestId ?? '') || typeof input.healthy !== 'boolean') fail('invalid_request'); held(input.requestId);
      const current = state(); if (current.requestId !== input.requestId || current.phase !== 'applying') fail('invalid_release_state');
      if (input.healthy) {
        const actual = capture(); if (actual.id !== current.target) fail('release_readback_failed');
        atomic(stateFile, { version: 1, current: actual.id, previous: current.current, phase: 'complete', changedAt: clock(), backup: current.backup }); release(input.requestId);
        return { health: true, backupVerified: true };
      }
      restore(load(current.current));
      atomic(stateFile, { version: 1, current: current.current, previous: current.previous, phase: 'rollback-pending', requestId: input.requestId, backup: current.backup });
      return { restored: true, restartRequired: true, backupVerified: true };
    },
    rollbackComplete(input) {
      if (!input || !UUID.test(input.requestId ?? '') || typeof input.healthy !== 'boolean') fail('invalid_request');
      held(input.requestId); const current = state(); if (current.phase !== 'rollback-pending') fail('invalid_release_state');
      atomic(stateFile, { ...current, phase: input.healthy ? 'complete' : 'rollback-unconfirmed' }); release(input.requestId);
      return { health: input.healthy === true, backupVerified: true, rolledBack: true };
    },
    beforeExternal(repoName) {
      if (!['kolonie-kepler7', 'kolonie-kepler7-backend'].includes(repoName)) fail('invalid_request');
      const requestId = crypto.randomUUID(); legacyLocks(repoName); acquire(requestId, 'external-deploy');
      try { const archive = capture(), verifiedBackup = backup(requestId); atomic(stateFile, { version: 1, current: archive.id, previous: state().previous, phase: 'external-deploy', requestId, backup: verifiedBackup }); return { requestId, previous: archive.id, backupVerified: true }; }
      catch (failure) { release(requestId); throw failure; }
    },
    afterExternal(input) {
      held(input.requestId); const current = state();
      if (!input.success) { atomic(stateFile, { ...current, phase: 'external-unconfirmed' }); release(input.requestId); return { archived: false }; }
      const actual = capture(); atomic(stateFile, { version: 1, current: actual.id, previous: actual.id === current.current ? current.previous : current.current, phase: 'complete' }); release(input.requestId);
      return { archived: true, id: actual.id };
    },
  };
}

module.exports = { createReleaseEngine, schemaProof, operationsProof };
