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
// The database budget stays independent of source references and compression.
const FILE_BYTES = 16 * 1024 * 1024;
const BLOB_BYTES = FILE_BYTES + 64 * 1024;
const INDEX_BYTES = 16 * 1024 * 1024;
const LOGICAL_BYTES = 512 * 1024 * 1024;
const PROOF_BYTES = 2 * 1024 * 1024;
const PUBLIC_FILE = /\.(?:html|css|js|mjs|json|webmanifest|xml|txt|png|jpe?g|webp|gif|svg|ico|woff2?|ttf|mp3|ogg|wasm|gz)$/i;
// Names only: excluded credentials are neither read nor restored by this engine.
const EXCLUDED_FILE = /(?:^|\/)(?:backups(?:\/|$)|(?:db|users|accounts|sessions)\.json$|\.env[^/]*$|[^/]*(?:private|secret|passwoerter|password|credential)[^/]*\.(?:txt|json|key|pem)$|[^/]*\.(?:key|pem|p12|pfx)$)/i;
const excluded = name => EXCLUDED_FILE.test(name);

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

// A synchronous caller still reads legacy archives without constructing their
// combined base64 payload. The isolated worker retains at most one file entry;
// its stdout is the bounded metadata index, never file contents.
async function archiveIndexWorker(config) {
  const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), zlib = require('node:zlib');
  const { StringDecoder } = require('node:string_decoder');
  const fail = code => { throw Object.assign(new Error(code), { code }); };
  const hash = value => crypto.createHash('sha256').update(value).digest('hex');
  const noLinks = file => {
    const resolved = path.resolve(file); let current = path.parse(resolved).root;
    for (const part of resolved.slice(current.length).split(path.sep)) {
      current = path.join(current, part); if (fs.lstatSync(current).isSymbolicLink()) fail('unsafe_release_file');
    }
  };
  const check = (file, directory = false) => {
    noLinks(file); const stat = fs.lstatSync(file);
    if ((directory ? !stat.isDirectory() : !stat.isFile()) || config.uid !== null && stat.uid !== config.uid || stat.mode & 0o077) fail('unsafe_release_storage');
    return stat;
  };
  const readBlob = file => {
    check(file); const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const info = fs.fstatSync(fd);
      if (info.size > config.blobBytes || !info.isFile() || config.uid !== null && info.uid !== config.uid || info.mode & 0o077) fail('invalid_release_blob');
      const bytes = Buffer.alloc(info.size); let offset = 0;
      while (offset < bytes.length) { const read = fs.readSync(fd, bytes, offset, bytes.length - offset, null); if (!read) fail('invalid_release_blob'); offset += read; }
      if (fs.fstatSync(fd).size !== info.size) fail('invalid_release_blob');
      return zlib.gunzipSync(bytes, { maxOutputLength: config.fileBytes });
    } finally { fs.closeSync(fd); }
  };
  const putBlob = (digest, raw) => {
    check(config.blobs, true); const file = path.join(config.blobs, digest + '.gz');
    if (fs.existsSync(file)) {
      const existing = readBlob(file); if (existing.length !== raw.length || hash(existing) !== digest) fail('invalid_release_blob'); return;
    }
    const temporary = file + '.' + crypto.randomBytes(12).toString('hex') + '.tmp';
    const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, zlib.gzipSync(raw, { level: 6 })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    try { fs.linkSync(temporary, file); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = readBlob(file); if (existing.length !== raw.length || hash(existing) !== digest) fail('invalid_release_blob');
    } finally { fs.unlinkSync(temporary); }
    const directory = fs.openSync(config.blobs, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  };
  const safeName = name => typeof name === 'string' && name.length < 240 && !name.startsWith('/') && !name.includes('\\') &&
    !name.split('/').some(part => !part || ['.', '..', '.git', 'node_modules'].includes(part)) && !Array.from(name).some(c => c.charCodeAt(0) < 32);
  const excluded = new RegExp(config.excluded, 'i');
  const files = [], seen = new Set(), unique = new Map();
  let prefix = '', suffix = '', mode = 'prefix', quote = false, escaped = false, depth = 0;
  let entry = [], entryLength = 0, afterEntry = false, expectEntry = true, total = 0, metadataBytes = 0, logical = 0, uniqueBytes = 0, version;
  const accept = () => {
    let file; try { file = JSON.parse(entry.join('')); } catch { fail('invalid_release_archive'); }
    entry = []; entryLength = 0;
    const key = file.area + '/' + file.name, keys = Object.keys(file).sort().join(',');
    if (!['backend', 'frontend', 'web'].includes(file.area) || !safeName(file.name) || excluded.test(file.name) || seen.has(key) ||
        !/^[a-f0-9]{64}$/.test(file.sha256 ?? '') || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > config.fileBytes ||
        keys !== (version === 1 ? 'area,bytes,data,name,sha256' : 'area,bytes,name,sha256')) fail('invalid_release_archive');
    seen.add(key); logical += file.bytes;
    if (logical > (version === 1 ? config.uniqueBytes : config.logicalBytes)) fail('invalid_release_archive');
    if (unique.has(file.sha256) && unique.get(file.sha256) !== file.bytes) fail('invalid_release_archive');
    if (!unique.has(file.sha256)) { unique.set(file.sha256, file.bytes); uniqueBytes += file.bytes; }
    if (uniqueBytes > config.uniqueBytes) fail('invalid_release_archive');
    if (version === 1) {
      if (typeof file.data !== 'string' || file.data.length > 4 * Math.ceil(config.fileBytes / 3)) fail('invalid_release_archive');
      const raw = Buffer.from(file.data, 'base64');
      if (raw.length !== file.bytes || hash(raw) !== file.sha256) fail('invalid_release_archive');
      putBlob(file.sha256, raw); delete file.data;
    }
    metadataBytes += Buffer.byteLength(JSON.stringify(file)) + 1;
    if (metadataBytes > config.indexBytes || files.length >= 30000) fail('invalid_release_archive');
    files.push(file);
  };
  const consume = text => {
    let part = -1;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (mode === 'suffix') { suffix += text.slice(i); break; }
      if (mode === 'prefix') {
        prefix += c;
        if (prefix.length > config.indexBytes) fail('invalid_release_archive');
        if (quote) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quote = false; continue; }
        if (c === '"') { quote = true; continue; }
        if (c === '[' && depth === 1 && /"files"\s*:\s*\[$/.test(prefix)) {
          let head; try { head = JSON.parse(prefix.slice(0, -1) + '[]}'); } catch { fail('invalid_release_archive'); }
          version = head.version; if (version !== 1 && version !== 2) fail('invalid_release_archive');
          if (version === 2 && config.compressedBytes > config.indexBytes + 65536) fail('invalid_release_archive');
          prefix = prefix.slice(0, -1); mode = 'files'; depth = 0; continue;
        }
        if (c === '{' || c === '[') depth++; else if (c === '}' || c === ']') depth--;
        continue;
      }
      if (!depth) {
        if (/\s/.test(c)) continue;
        if (c === ']' && (afterEntry || expectEntry && !files.length)) { mode = 'suffix'; continue; }
        if (c === ',' && afterEntry) { afterEntry = false; expectEntry = true; continue; }
        if (c !== '{' || !expectEntry) fail('invalid_release_archive');
        expectEntry = false; depth = 1; part = i; continue;
      }
      if (quote) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quote = false; }
      else if (c === '"') quote = true;
      else if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') depth--;
      if (!depth) {
        entry.push(text.slice(part < 0 ? 0 : part, i + 1)); entryLength += i + 1 - (part < 0 ? 0 : part); part = -1;
        if (entryLength > 4 * Math.ceil(config.fileBytes / 3) + 4096) fail('invalid_release_archive');
        accept(); afterEntry = true;
      }
    }
    if (mode === 'files' && depth) {
      entry.push(text.slice(part < 0 ? 0 : part)); entryLength += text.length - (part < 0 ? 0 : part);
      if (entryLength > 4 * Math.ceil(config.fileBytes / 3) + 4096) fail('invalid_release_archive');
    }
    if (Buffer.byteLength(prefix) + Buffer.byteLength(suffix) + metadataBytes > config.indexBytes) fail('invalid_release_archive');
  };
  const decoder = new StringDecoder('utf8');
  const input = fs.createReadStream(null, { fd: 0, autoClose: false });
  let compressedRead = 0;
  input.on('data', chunk => { compressedRead += chunk.length; if (compressedRead > config.compressedBytes) input.destroy(Object.assign(new Error('invalid_release_archive'), { code: 'invalid_release_archive' })); });
  const stream = input.pipe(zlib.createGunzip()); input.on('error', error => stream.destroy(error));
  for await (const chunk of stream) {
    total += chunk.length; if (total > (version === 2 ? config.indexBytes : 400 * 1024 * 1024)) fail('invalid_release_archive');
    consume(decoder.write(chunk));
  }
  consume(decoder.end());
  if (mode !== 'suffix' || quote || depth) fail('invalid_release_archive');
  let archive; try { archive = JSON.parse(prefix + '[]' + suffix); } catch { fail('invalid_release_archive'); }
  if (archive.version !== version || !Array.isArray(archive.files) || archive.files.length) fail('invalid_release_archive');
  archive.files = files; const result = JSON.stringify(archive);
  if (Buffer.byteLength(result) > config.indexBytes) fail('invalid_release_archive');
  process.stdout.write(result);
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
    if (fs.existsSync(directory)) {
      noLinks(directory);
      if (!fs.lstatSync(directory).isDirectory()) fail('unsafe_release_file');
      return;
    }
    let parent = directory;
    while (!fs.existsSync(parent) && parent !== path.dirname(parent)) parent = path.dirname(parent);
    noLinks(parent);
    fs.mkdirSync(directory, { recursive: true, mode });
    noLinks(directory);
  };
  const boundedRead = (file, maximum = MAX_BYTES, privateFile = false) => {
    noLinks(file);
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const info = fs.fstatSync(fd);
      if (!info.isFile() || info.size > maximum || privateFile && (uid !== null && info.uid !== uid || info.mode & 0o077)) fail('unsafe_release_file');
      const raw = Buffer.alloc(info.size); let offset = 0;
      while (offset < raw.length) { const read = fs.readSync(fd, raw, offset, raw.length - offset, null); if (!read) fail('unsafe_release_file'); offset += read; }
      if (fs.fstatSync(fd).size !== info.size) fail('unsafe_release_file'); return raw;
    }
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
  const blobDirectory = path.join(store, 'blobs');
  const blobsReady = () => { makeDirectory(blobDirectory, 0o700); privateCheck(blobDirectory, true); };
  const readBlob = file => {
    if (!HASH.test(file.sha256 ?? '') || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > FILE_BYTES) fail('invalid_release_blob');
    privateCheck(blobDirectory, true); noLinks(blobDirectory);
    const target = path.join(blobDirectory, file.sha256 + '.gz'); noLinks(target); privateCheck(target);
    let raw;
    try { raw = zlib.gunzipSync(boundedRead(target, BLOB_BYTES, true), { maxOutputLength: FILE_BYTES }); }
    catch (error) { if (['unsafe_release_file', 'unsafe_release_storage'].includes(error.code)) throw error; fail('invalid_release_blob'); }
    if (raw.length !== file.bytes || sha(raw) !== file.sha256) fail('invalid_release_blob'); return raw;
  };
  const storeBlob = (file, raw) => {
    blobsReady(); const target = path.join(blobDirectory, file.sha256 + '.gz');
    if (fs.existsSync(target)) { readBlob(file); return; }
    const compressed = zlib.gzipSync(raw, { level: 6 }); if (compressed.length > BLOB_BYTES) fail('release_size_limit');
    const temporary = target + '.' + crypto.randomBytes(12).toString('hex') + '.tmp'; writePrivate(temporary, compressed, true);
    try { fs.linkSync(temporary, target); }
    catch (error) { if (error.code !== 'EEXIST') throw error; readBlob(file); }
    finally { fs.unlinkSync(temporary); }
    const fd = fs.openSync(blobDirectory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  };
  const validateBlobs = files => {
    const checked = new Set();
    for (const file of files) if (!checked.has(file.sha256)) { readBlob(file); checked.add(file.sha256); }
  };
  const proofFromFiles = files => {
    const server = files.find(file => file.area === 'backend' && file.name === 'server.js');
    if (!server || server.bytes > PROOF_BYTES) fail('loader_contract_missing');
    const source = readBlob(server).toString('utf8'), small = [];
    for (const name of ['operations-admin.js', 'operations-release-guard.js', 'operations-health.js', 'operations-release-engine.cjs']) {
      const file = files.find(file => file.area === 'backend' && file.name === name);
      if (file && file.bytes <= PROOF_BYTES) small.push({ ...file, data: readBlob(file).toString('base64') });
    }
    return { proof: schemaProof(source), operations: operationsProof(source, small) };
  };
  const readIndex = file => {
    noLinks(file); const info = privateCheck(file);
    if (info.size > MAX_BYTES) fail('invalid_release_archive');
    blobsReady(); const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const config = { blobs: blobDirectory, uid, fileBytes: FILE_BYTES, blobBytes: BLOB_BYTES, indexBytes: INDEX_BYTES,
        uniqueBytes: MAX_BYTES, logicalBytes: LOGICAL_BYTES, compressedBytes: info.size, excluded: EXCLUDED_FILE.source };
      const script = '(' + archiveIndexWorker.toString() + ')(JSON.parse(process.argv[1])).catch(error => {process.stderr.write(JSON.stringify({code:error.code||"invalid_release_archive"}));process.exitCode=1;});';
      let output;
      try { output = execFileSync(process.execPath, ['-e', script, canonical(config)], { stdio: [fd, 'pipe', 'pipe'], timeout: 120000, maxBuffer: INDEX_BYTES }); }
      catch (error) {
        let code; try { code = JSON.parse(error.stderr?.toString() || '{}').code; } catch { /* Worker output is diagnostics only. */ }
        if (['unsafe_release_file', 'unsafe_release_storage', 'invalid_release_blob'].includes(code)) fail(code);
        fail('invalid_release_archive');
      }
      if (fs.fstatSync(fd).size !== info.size) fail('invalid_release_archive');
      return JSON.parse(output);
    } finally { fs.closeSync(fd); }
  };
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
    let logical = 0, uniqueBytes = 0, indexBytes = 0;
    const files = [], unique = new Map();
    for (const area of ['backend', 'frontend', 'web']) {
      for (const name of (area === 'web' ? webFiles() : gitFiles(area)).sort()) {
        const raw = boundedRead(path.join(roots[area], name), FILE_BYTES);
        const file = { area, name, sha256: sha(raw), bytes: raw.length };
        logical += raw.length;
        if (!unique.has(file.sha256)) { unique.set(file.sha256, file.bytes); uniqueBytes += file.bytes; }
        indexBytes += Buffer.byteLength(canonical(file)) + 1;
        if (logical > LOGICAL_BYTES || uniqueBytes > MAX_BYTES || indexBytes > INDEX_BYTES) fail('release_size_limit');
        storeBlob(file, raw); files.push(file);
      }
    }
    if (!trackedClean('backend') || !trackedClean('frontend') || git('backend', 'rev-parse', 'HEAD') !== backendCommit || git('frontend', 'rev-parse', 'HEAD') !== frontendCommit) fail('dirty_release_source');
    const { proof, operations } = proofFromFiles(files);
    const versionFile = files.find(file => file.area === 'web' && file.name === 'version.txt');
    const version = versionFile ? readBlob(versionFile).toString('utf8').trim().slice(0, 40) : null;
    const identity = { backendCommit, frontendCommit, runtimeProof, proof, operationsProof: operations, files };
    const id = backendCommit + '-' + sha(canonical(identity));
    const directory = path.join(store, id), archive = { version: 2, id, createdAt: clock(), frontendVersion: version, ...identity, files };
    const index = Buffer.from(canonical(archive)), manifest = Buffer.from(canonical({ ...archive, version: 1 }));
    if (index.length > INDEX_BYTES || manifest.length > INDEX_BYTES) fail('release_size_limit');
    if (!fs.existsSync(directory)) {
      const staging = path.join(store, '.archive-' + crypto.randomBytes(12).toString('hex'));
      fs.mkdirSync(staging, { mode: 0o700 }); privateCheck(staging, true);
      writePrivate(path.join(staging, 'source.json.gz'), zlib.gzipSync(index, { level: 9 }), true);
      writePrivate(path.join(staging, 'manifest.json'), manifest, true);
      const fd = fs.openSync(staging, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(staging, directory);
      const parent = fs.openSync(store, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
      try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
    }
    // Publication, including the first capture, requires full private readback.
    return load(id);
  };
  // Historical rows with a different contract can be displayed without reading
  // payloads. This verifies only the private manifest and identity; it never
  // establishes source-byte validity or permits restoration.
  const readManifest = id => {
    if (!ID.test(id)) fail('invalid_release');
    const directory = path.join(store, id); noLinks(directory); privateCheck(directory, true);
    const archive = JSON.parse(boundedRead(path.join(directory, 'manifest.json'), INDEX_BYTES, true));
    if (!archive || archive.version !== 1 || archive.id !== id || !Array.isArray(archive.files) || archive.files.length > 30000) fail('invalid_release_archive');
    const validProof = (value, format, fields) => value && typeof value === 'object' && !Array.isArray(value) &&
      value.format === format && Object.keys(value).sort().join(',') === ['format', ...fields].sort().join(',') &&
      fields.every(field => typeof value[field] === 'string' && HASH.test(value[field]));
    if (!validProof(archive.proof, 'kepler-json-users-private-shared-v1', ['loader', 'save', 'auth', 'lookup']) ||
        archive.operationsProof != null && !validProof(archive.operationsProof, 'kepler-private-operations-v1', ['bridge', 'guard', 'health', 'engine', 'installation', 'deployment', 'announcement'])) fail('invalid_release_archive');
    let logical = 0, uniqueBytes = 0; const seen = new Set(), unique = new Map();
    for (const file of archive.files) {
      if (!file || typeof file !== 'object') fail('invalid_release_archive');
      const key = file.area + '/' + file.name;
      if (!Object.hasOwn(roots, file.area) || !safeName(file.name) || excluded(file.name) || seen.has(key) || !HASH.test(file.sha256 ?? '') ||
          Object.keys(file).sort().join(',') !== 'area,bytes,name,sha256' || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > FILE_BYTES) fail('invalid_release_archive');
      seen.add(key); logical += file.bytes;
      if (unique.has(file.sha256) && unique.get(file.sha256) !== file.bytes) fail('invalid_release_archive');
      if (!unique.has(file.sha256)) { unique.set(file.sha256, file.bytes); uniqueBytes += file.bytes; }
      if (logical > LOGICAL_BYTES || uniqueBytes > MAX_BYTES) fail('invalid_release_archive');
    }
    const identity = { backendCommit: archive.backendCommit, frontendCommit: archive.frontendCommit, runtimeProof: archive.runtimeProof, proof: archive.proof,
      ...(Object.hasOwn(archive, 'operationsProof') ? { operationsProof: archive.operationsProof } : {}), files: archive.files };
    if (!HASH.test(archive.runtimeProof ?? '') || !/^[a-f0-9]{40}$/.test(archive.backendCommit ?? '') || !/^[a-f0-9]{40}$/.test(archive.frontendCommit ?? '') ||
        archive.backendCommit + '-' + sha(canonical(identity)) !== id) fail('invalid_release_archive');
    return archive;
  };
  const load = id => {
    if (!ID.test(id)) fail('invalid_release');
    const directory = path.join(store, id); noLinks(directory); privateCheck(directory, true);
    const archive = readIndex(path.join(directory, 'source.json.gz'));
    if (![1, 2].includes(archive.version) || archive.id !== id || !Array.isArray(archive.files) || archive.files.length > 30000) fail('invalid_release_archive');
    let logical = 0, uniqueBytes = 0; const seen = new Set(), unique = new Map();
    for (const file of archive.files) {
      const key = file.area + '/' + file.name;
      if (!Object.hasOwn(roots, file.area) || !safeName(file.name) || excluded(file.name) || seen.has(key) || !HASH.test(file.sha256 ?? '') ||
          Object.keys(file).sort().join(',') !== 'area,bytes,name,sha256' || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > FILE_BYTES) fail('invalid_release_archive');
      seen.add(key); logical += file.bytes;
      if (unique.has(file.sha256) && unique.get(file.sha256) !== file.bytes) fail('invalid_release_archive');
      if (!unique.has(file.sha256)) { unique.set(file.sha256, file.bytes); uniqueBytes += file.bytes; }
      if (logical > (archive.version === 1 ? MAX_BYTES : LOGICAL_BYTES) || uniqueBytes > MAX_BYTES) fail('invalid_release_archive');
    }
    const manifest = JSON.parse(boundedRead(path.join(directory, 'manifest.json'), INDEX_BYTES, true));
    if (canonical(manifest) !== canonical({ ...archive, version: 1 })) fail('invalid_release_archive');
    const identity = { backendCommit: archive.backendCommit, frontendCommit: archive.frontendCommit, runtimeProof: archive.runtimeProof, proof: archive.proof,
      ...(Object.hasOwn(archive, 'operationsProof') ? { operationsProof: archive.operationsProof } : {}), files: archive.files };
    if (!HASH.test(archive.runtimeProof ?? '') || !/^[a-f0-9]{40}$/.test(archive.frontendCommit ?? '') || archive.backendCommit + '-' + sha(canonical(identity)) !== id) fail('invalid_release_archive');
    validateBlobs(archive.files);
    const { proof, operations } = proofFromFiles(archive.files);
    if (canonical(proof) !== canonical(archive.proof)) fail('invalid_release_archive');
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
    // A missing/corrupt later blob must not permit even the first source write.
    validateBlobs(archive.files);
    for (const area of ['backend', 'frontend']) {
      const commit = area === 'backend' ? archive.backendCommit : archive.frontendCommit;
      git(area, 'cat-file', '-e', commit + '^{commit}');
      const files = archive.files.filter(file => file.area === area), wanted = new Set(files.map(file => file.name));
      // Check objects before changing source; only public manifest paths are read.
      const namesAtCommit = git(area, 'ls-tree', '-r', '--name-only', '-z', commit).split('\0').filter(Boolean).filter(name => !excluded(name));
      if (namesAtCommit.length !== wanted.size || namesAtCommit.some(name => !wanted.has(name))) fail('source_revision_mismatch');
      for (const file of files) {
        const raw = run('/usr/bin/git', ['-c', 'safe.directory=' + roots[area], '-C', roots[area], 'cat-file', 'blob', commit + ':' + file.name], { maxBuffer: FILE_BYTES });
        if (sha(raw) !== file.sha256) fail('source_revision_mismatch');
      }
      const priorCommit = git(area, 'rev-parse', 'HEAD');
      for (const name of gitFiles(area)) if (!wanted.has(name)) { const target = path.join(roots[area], name); noLinks(target); fs.unlinkSync(target); }
      for (const file of files) {
        const target = path.join(roots[area], file.name); makeDirectory(path.dirname(target), 0o755);
        if (fs.existsSync(target)) noLinks(target);
        const temporary = target + '.gg-release-' + crypto.randomBytes(6).toString('hex');
        const mode = git(area, 'ls-tree', commit, '--', file.name).startsWith('100755 ') ? 0o755 : 0o644;
        fs.writeFileSync(temporary, readBlob(file), { mode, flag: 'wx' }); fs.renameSync(temporary, target);
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
      fs.writeFileSync(temporary, readBlob(file), { mode: 0o644, flag: 'wx' }); fs.renameSync(temporary, target);
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
    const compatibleMetadata = archive => !!operations && !!archive.operationsProof && operations.engine === engineHash && archive.runtimeProof === runtimeProof &&
      canonical(archive.proof) === canonical(proof) && canonical(archive.operationsProof) === canonical(operations);
    const important = new Set([currentState.current, currentState.previous]);
    const releases = fs.readdirSync(store).filter(name => ID.test(name)).sort((a, b) => Number(important.has(b)) - Number(important.has(a)) || fs.lstatSync(path.join(store, b)).mtimeMs - fs.lstatSync(path.join(store, a)).mtimeMs).slice(0, 40).map(id => {
      try {
        let archive = current?.id === id ? current : readManifest(id);
        if (archive !== current && compatibleMetadata(archive)) archive = load(id);
        const compatible = compatibleMetadata(archive);
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
    beforeExternal(repoName, options) {
      if (!['kolonie-kepler7', 'kolonie-kepler7-backend'].includes(repoName)) fail('invalid_request');
      if (options !== undefined && (!options || typeof options !== 'object' || Object.keys(options).join(',') !== 'requestId' || !UUID.test(options.requestId ?? ''))) fail('invalid_request');
      const requestId = options === undefined ? crypto.randomUUID() : options.requestId; legacyLocks(repoName); acquire(requestId, 'external-deploy');
      try { const archive = capture(), verifiedBackup = backup(requestId); atomic(stateFile, { version: 1, current: archive.id, previous: state().previous, phase: 'external-deploy', requestId, backup: verifiedBackup }); return { requestId, previous: archive.id, backupVerified: true }; }
      catch (failure) { release(requestId); throw failure; }
    },
    afterExternal(input) {
      if (!input || Object.keys(input).sort().join(',') !== 'requestId,success' || !UUID.test(input.requestId ?? '') || typeof input.success !== 'boolean') fail('invalid_request');
      const lock = held(input.requestId), current = state();
      if (lock.action !== 'external-deploy' || current.requestId !== input.requestId) fail('invalid_release_state');
      if (input.success && current.phase === 'complete') {
        const actual = capture();
        if (actual.id !== current.current || actual.operationsProof?.engine !== engineHash) fail('release_readback_failed');
        release(input.requestId); return { archived: true, id: actual.id };
      }
      if (current.phase !== 'external-deploy') fail('invalid_release_state');
      if (!input.success) { atomic(stateFile, { ...current, phase: 'external-unconfirmed' }); release(input.requestId); return { archived: false }; }
      let actual;
      try {
        actual = capture(); atomic(stateFile, { version: 1, current: actual.id, previous: actual.id === current.current ? current.previous : current.current,
          phase: 'complete', requestId: input.requestId, backup: current.backup });
      } catch (failure) {
        // The lock is released only after the truthful state is durable. A
        // failure of that state write retains the lock and prevents completion.
        atomic(stateFile, { ...current, phase: 'external-unconfirmed' }); release(input.requestId); throw failure;
      }
      release(input.requestId);
      return { archived: true, id: actual.id };
    },
    cancelExternalPreparation(input) {
      if (!input || Object.keys(input).sort().join(',') !== 'priorStateSha256,requestId' || !UUID.test(input.requestId ?? '') || !HASH.test(input.priorStateSha256 ?? '')) fail('invalid_request');
      const lock = held(input.requestId), current = state();
      if (lock.action !== 'external-deploy' || current.phase !== 'external-unconfirmed' || current.requestId === input.requestId ||
          sha(canonical(current)) !== input.priorStateSha256) fail('invalid_release_state');
      release(input.requestId); return { cancelled: true };
    },
    abortExternal(input) {
      if (!input || Object.keys(input).join(',') !== 'requestId' || !UUID.test(input.requestId ?? '')) fail('invalid_request');
      ready(); const current = state();
      if (current.requestId !== input.requestId || !['external-deploy', 'external-unconfirmed'].includes(current.phase) || !ID.test(current.current ?? '')) fail('invalid_release_state');
      if (fs.existsSync(lockFile)) {
        if (held(input.requestId).action !== 'external-deploy') fail('invalid_release_state');
      } else {
        if (current.phase !== 'external-unconfirmed') fail('invalid_release_state');
        acquire(input.requestId, 'external-deploy');
      }
      if (canonical(state()) !== canonical(current)) fail('invalid_release_state');
      try {
        restore(load(current.current));
        atomic(stateFile, { ...current, phase: 'external-rollback-pending' });
        return { restored: true, restartRequired: true, backupVerified: current.backup?.verified === true };
      } catch (failure) {
        atomic(stateFile, { ...current, phase: 'external-rollback-unconfirmed' }); throw failure;
      }
    },
    completeExternalRollback(input) {
      if (!input || Object.keys(input).sort().join(',') !== 'healthy,requestId' || !UUID.test(input.requestId ?? '') || typeof input.healthy !== 'boolean') fail('invalid_request');
      const lock = held(input.requestId), current = state();
      if (lock.action !== 'external-deploy' || current.requestId !== input.requestId || current.phase !== 'external-rollback-pending') fail('invalid_release_state');
      if (!input.healthy) {
        atomic(stateFile, { ...current, phase: 'external-rollback-unconfirmed' });
        return { health: false, archiveCompatible: false, rolledBack: true, backupVerified: current.backup?.verified === true };
      }
      let actual;
      try { actual = capture(); if (actual.id !== current.current) fail('release_readback_failed'); }
      catch (failure) { atomic(stateFile, { ...current, phase: 'external-rollback-unconfirmed' }); throw failure; }
      const compatible = !!actual.operationsProof && actual.operationsProof.engine === engineHash;
      atomic(stateFile, { ...current, phase: compatible ? 'complete' : 'external-unconfirmed' }); release(input.requestId);
      return { health: true, archiveCompatible: compatible, rolledBack: true, backupVerified: current.backup?.verified === true };
    },
  };
}

module.exports = { createReleaseEngine, schemaProof, operationsProof };
