'use strict';
// Kepler operations contract v1: shared immutable archives, no public control.
const fs = require('node:fs');
const crypto = require('node:crypto');
const http = require('node:http');
const child = require('node:child_process');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function privateSocket() {
  const info = fs.lstatSync('/data/operations-admin.sock');
  if (!info.isSocket() || info.isSymbolicLink() || info.uid !== process.getuid() || info.mode & 0o077)
    throw new Error('private_operations_socket_unavailable');
}

function engine() {
  const directory = '/data/operations-releases', file = directory + '/engine.cjs';
  for (const [target, directoryFlag] of [[directory, true], [file, false], [directory + '/runtime-contract.json', false]]) {
    const info = fs.lstatSync(target);
    if (info.isSymbolicLink() || (directoryFlag ? !info.isDirectory() : !info.isFile()) || info.uid !== process.getuid() || info.mode & 0o077)
      throw Object.assign(new Error('private_release_engine_unavailable'), { code: 'private_release_engine_unavailable' });
  }
  const contract = JSON.parse(fs.readFileSync(directory + '/runtime-contract.json'));
  if (!/^[a-f0-9]{64}$/.test(contract.runtimeProof ?? '') || sha(fs.readFileSync(file)) !== contract.engineSha256 ||
      sha(fs.readFileSync(require('node:path').join(__dirname, 'operations-release-engine.cjs'))) !== contract.engineSha256)
    throw Object.assign(new Error('private_release_engine_unavailable'), { code: 'private_release_engine_unavailable' });
  delete require.cache[require.resolve(file)];
  return require(file).createReleaseEngine({ runtimeProof: contract.runtimeProof });
}

function flush() {
  return new Promise((resolve, reject) => {
    try { privateSocket(); } catch (error) { reject(error); return; }
    const request = http.request({ socketPath: '/data/operations-admin.sock', path: '/v1', method: 'POST', headers: { 'Content-Type': 'application/json' } }, response => {
      let raw = '';
      response.on('data', chunk => { raw += chunk; if (raw.length > 4096) response.destroy(); });
      response.on('error', reject);
      response.on('end', () => {
        try { const value = JSON.parse(raw); if (response.statusCode !== 200 || value.flushed !== true || value.persistence !== true) throw new Error('predeploy_backup_unconfirmed'); resolve(); }
        catch { reject(new Error('predeploy_backup_unconfirmed')); }
      });
    });
    request.setTimeout(10000, () => request.destroy(new Error('predeploy_backup_unconfirmed')));
    request.on('error', reject); request.end('{"action":"backup-prepare"}');
  });
}

function createGuard({ getEngine = engine, prepareBackup = flush, execute = child.exec } = {}) {
return function guardedExec(repoName, command, options, callback) {
  if (!['kolonie-kepler7', 'kolonie-kepler7-backend'].includes(repoName) || typeof command !== 'string' || typeof callback !== 'function')
    throw new Error('invalid_deploy_target');
  let controller, prepared;
  // Capture before changing source. A missing/broken private engine blocks a
  // deploy; it cannot silently overwrite a recorded immutable revision.
  prepareBackup().then(() => {
    controller = getEngine(); prepared = controller.beforeExternal(repoName);
    execute(command, options, (error, stdout, stderr) => {
      try {
        const result = controller.afterExternal({ requestId: prepared.requestId, success: !error });
        if (!error && result.archived !== true) throw new Error('postdeploy_archive_unconfirmed');
      } catch { error = Object.assign(new Error('postdeploy_archive_unconfirmed'), { code: 'postdeploy_archive_unconfirmed' }); }
      callback(error, stdout, stderr);
    });
  }).catch(() => {
    if (prepared) { try { controller.afterExternal({ requestId: prepared.requestId, success: false }); } catch {} }
    callback(Object.assign(new Error('predeploy_archive_unconfirmed'), { code: 'predeploy_archive_unconfirmed' }), '', '');
  });
};
}

const guardedExec = createGuard();
module.exports = { exec: guardedExec, engine, flush, createGuard };

// The existing host cron enters this fixed command inside the same container.
// Git arguments and target are local constants, never dashboard request fields.
if (require.main === module) {
  if (process.argv.length !== 3 || process.argv[2] !== 'autodeploy') process.exitCode = 2;
  else {
    try { privateSocket(); } catch { process.exitCode = 2; return; }
    const request = http.request({ socketPath: '/data/operations-admin.sock', path: '/v1', method: 'POST', headers: { 'Content-Type': 'application/json' } }, response => {
      let raw = ''; response.on('data', chunk => { raw += chunk; if (raw.length > 4096) response.destroy(); });
      response.on('end', () => { try { if (response.statusCode !== 200 || JSON.parse(raw).accepted !== true) throw Error(); process.stdout.write('{"accepted":true}\n'); } catch { process.exitCode = 2; } });
    });
    request.setTimeout(10000, () => request.destroy()); request.on('error', () => { process.exitCode = 2; }); request.end('{"action":"deploy-backend"}');
  }
}
