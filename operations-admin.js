'use strict';

// Install inside the Kepler process, where the authoritative accounts live.
// This is a private UNIX socket; it adds no game HTTP route, JWT or password.
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { createHash } = require('node:crypto');

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const ACTIONS = ['player-block', 'player-unblock', 'player-revoke'];
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const error = code => Object.assign(new Error(code), { code });
const keys = (value, expected) => plain(value) && Object.keys(value).sort().join(',') === [...expected].sort().join(',');
const boundedText = (value, maximum) => typeof value === 'string' && value.length <= maximum && !/[\x00-\x1f\x7f]/.test(value);
const timestamp = value => Number.isSafeInteger(value) && value > 0 ? value : null;
const suspended = (user, now) => user.banned === true && (!Number.isFinite(user.bannBis) || user.bannBis <= 0 || now <= user.bannBis);
function maintenanceWindows(windows) {
  if (!Array.isArray(windows) || windows.length > 20) throw error('invalid_request');
  const seen = new Set();
  return windows.map(window => {
    if (!keys(window, ['id', 'startsAt', 'endsAt', 'message']) || !UUID.test(window.id ?? '') || seen.has(window.id) ||
        !Number.isSafeInteger(window.startsAt) || window.startsAt < 0 || !Number.isSafeInteger(window.endsAt) ||
        window.endsAt <= window.startsAt || window.endsAt - window.startsAt > 86400000 ||
        !boundedText(window.message, 240) || window.message.trim().length < 3) throw error('invalid_request');
    seen.add(window.id);
    return { id: window.id, startsAt: window.startsAt, endsAt: window.endsAt, message: window.message.trim() };
  }).sort((a, b) => a.startsAt - b.startsAt || a.id.localeCompare(b.id));
}

function createMaintenanceStore(file) {
  const read = () => {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const metadata = fs.fstatSync(fd);
      if (!metadata.isFile() || metadata.uid !== process.getuid() || metadata.mode & 0o077 || metadata.size > 65536) throw error('unsafe_maintenance_file');
      const value = JSON.parse(fs.readFileSync(fd, 'utf8'));
      if (!keys(value, ['version', 'publishedAt', 'windows']) || value.version !== 1 || !Number.isSafeInteger(value.publishedAt) || value.publishedAt < 0) throw error('invalid_maintenance_file');
      return { version: 1, publishedAt: value.publishedAt, windows: maintenanceWindows(value.windows) };
    } finally { fs.closeSync(fd); }
  };
  return {
    load() { return fs.existsSync(file) ? read() : { version: 1, publishedAt: 0, windows: [] }; },
    async save(windows, publishedAt) {
      const value = { version: 1, publishedAt, windows: maintenanceWindows(windows) };
      if (fs.existsSync(file)) read();
      const temporary = file + '.' + require('node:crypto').randomBytes(12).toString('hex') + '.tmp';
      const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      try {
        fs.renameSync(temporary, file);
        const directory = fs.openSync(path.dirname(file), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
        try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
        if (digest(read()) !== digest(value)) throw error('maintenance_readback_failed');
      } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
      return value;
    },
  };
}

function createOperationsAdmin({ getDb, saveDb, opsHealth, clock = Date.now, maintenanceStore = null, deployBackend = null }) {
  if (typeof getDb !== 'function' || typeof saveDb !== 'function' || typeof opsHealth?.snapshot !== 'function') throw error('invalid_adapter');
  const pending = new Map();
  let maintenance = maintenanceStore?.load() ?? { version: 1, publishedAt: 0, windows: [] }, publishing = false;
  const accounts = () => {
    const db = getDb();
    if (!plain(db?.users)) throw error('accounts_unavailable');
    const values = Object.values(db.users);
    if (values.length > 100000) throw error('account_limit');
    return values.filter(user => plain(user) && UUID.test(user.userId ?? '') && boundedText(user.username, 100));
  };
  const snapshot = () => digest(accounts().map(user => [user.userId, user.username, suspended(user, clock()), user.bannGrund ?? '',
    user.tokenVersion ?? 0, user.activeSessionId ?? null, user.activeSessionAt ?? null]).sort((a, b) => a[0].localeCompare(b[0])));
  const capabilities = () => ({ list: true, block: true, unblock: true, revoke: true, maintenancePublish: !!maintenanceStore, reason: null, snapshot: snapshot() });
  const accountView = user => ({
    id: user.userId, username: user.username,
    role: getDb().users.gamegeeeeek?.userId === user.userId ? 'owner' : 'player',
    suspended: suspended(user, clock()), verified: user.emailVerified === true,
    createdAt: timestamp(user.createdAt), lastLoginAt: timestamp(user.letzteAnmeldung ?? user.activeSessionAt),
    activeSessions: typeof user.activeSessionId === 'string' && user.activeSessionId ? 1 : null,
    suspensionReason: typeof user.bannGrund === 'string' ? user.bannGrund.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200) : null,
  });
  async function persisted(after) {
    await saveDb();
    const health = opsHealth.snapshot();
    // Kepler's legacy saveDb resolves even after a write error. Require its
    // explicit health proof before confirming a durable administrative result.
    if (health?.checks?.persistence !== true || !Number.isFinite(health.operationalTimes?.persistedAt) || health.operationalTimes.persistedAt < after)
      throw error('persistence_unconfirmed');
  }
  const handle = async function handle(input) {
    if (keys(input, ['action']) && input.action === 'status') return { capabilities: capabilities() };
    if (keys(input, ['action']) && input.action === 'deploy-backend') {
      if (typeof deployBackend !== 'function' || pending.size || publishing) throw error('admin_busy');
      deployBackend(); return { accepted: true };
    }
    if (keys(input, ['action']) && input.action === 'backup-prepare') {
      if (pending.size || publishing) throw error('admin_busy');
      const startedAt = clock(); await persisted(startedAt);
      return { flushed: true, persistence: true };
    }
    if (keys(input, ['action', 'windows']) && input.action === 'maintenance-publish') {
      const windows = maintenanceWindows(input.windows);
      if (!maintenanceStore) throw error('maintenance_unavailable');
      if (publishing) throw error('admin_busy');
      publishing = true;
      try {
        maintenance = await maintenanceStore.save(windows, clock());
        return { published: true, readback: true, publishedAt: maintenance.publishedAt };
      } finally { publishing = false; }
    }
    if (keys(input, ['action', 'search', 'page']) && input.action === 'players') {
      if (!boundedText(input.search, 100) || !Number.isInteger(input.page) || input.page < 0 || input.page > 10000) throw error('invalid_request');
      const search = input.search.toLocaleLowerCase('de-DE');
      const rows = accounts().filter(user => user.username.toLocaleLowerCase('de-DE').includes(search) || user.userId.includes(search))
        .sort((a, b) => a.username.localeCompare(b.username, 'de-DE') || a.userId.localeCompare(b.userId));
      return { host: 'pi', game: 'kepler', accounts: rows.slice(input.page * 25, input.page * 25 + 25).map(accountView),
        total: rows.length, page: input.page, capabilities: capabilities() };
    }
    if (!keys(input, ['action', 'accountId', 'reason', 'confirmed', 'requestId', 'expectedSnapshot']) ||
        !ACTIONS.includes(input.action) || !UUID.test(input.accountId ?? '') || !UUID.test(input.requestId ?? '') ||
        !HASH.test(input.expectedSnapshot ?? '') || input.confirmed !== true || !boundedText(input.reason, 200) || input.reason.trim().length < 3)
      throw error('invalid_request');
    const fingerprint = digest(input), db = getDb();
    if (pending.has(input.requestId)) {
      const job = pending.get(input.requestId);
      if (job.fingerprint !== fingerprint) throw error('request_conflict');
      return job.promise;
    }
    const saved = plain(db.operationsAdmin) && Array.isArray(db.operationsAdmin.actions) ? db.operationsAdmin.actions : [];
    const old = saved.find(item => item.id === input.requestId);
    if (old) {
      if (old.fingerprint !== fingerprint) throw error('request_conflict');
      await persisted(clock());
      return old.result;
    }
    if (snapshot() !== input.expectedSnapshot) throw error('stale_snapshot');
    const user = accounts().find(account => account.userId === input.accountId);
    if (!user) throw error('account_not_found');
    if (db.users.gamegeeeeek?.userId === user.userId || user.username.toLowerCase() === 'gamegeeeeek') throw error('protected_account');
    if (pending.size) throw error('admin_busy');
    if (!Number.isSafeInteger(user.tokenVersion ?? 0) || (user.tokenVersion ?? 0) < 0 || (user.tokenVersion ?? 0) >= Number.MAX_SAFE_INTEGER) throw error('account_state_invalid');
    const started = clock(), revokedSessions = typeof user.activeSessionId === 'string' && user.activeSessionId ? 1 : null;
    if (input.action === 'player-block') {
      user.banned = true; user.bannGrund = input.reason.trim(); user.bannBis = 0; user.bannSeit = started;
    } else if (input.action === 'player-unblock') {
      user.banned = false; user.bannBis = 0;
    }
    if (input.action !== 'player-unblock') {
      // The existing game middleware checks tokenVersion on every request,
      // including old JWTs that predate single-session identifiers.
      user.tokenVersion = (user.tokenVersion ?? 0) + 1;
      delete user.activeSessionId; delete user.activeSessionAt;
    }
    const result = { health: true, revokedSessions: input.action === 'player-unblock' ? 0 : revokedSessions };
    if (!plain(db.operationsAdmin)) db.operationsAdmin = {};
    db.operationsAdmin.actions = [...saved.slice(-99), { id: input.requestId, fingerprint, createdAt: started, result }];
    const promise = persisted(started).then(() => result).catch(failure => {
      // Keep conservative in-memory revocation; never report a durable success
      // or automatically repeat an uncertain write.
      db.operationsAdmin.actions = db.operationsAdmin.actions.filter(item => item.id !== input.requestId);
      throw failure;
    }).finally(() => pending.delete(input.requestId));
    pending.set(input.requestId, { fingerprint, promise });
    return promise;
  };
  handle.announcement = (at = clock()) => {
    const next = maintenance.windows.filter(window => window.endsAt >= at).sort((a, b) => a.startsAt - b.startsAt)[0];
    return next ? { text: next.message.slice(0, 200), ab: next.startsAt, dauerMinuten: (next.endsAt - next.startsAt) / 60000, gesetzt: maintenance.publishedAt } : null;
  };
  return handle;
}

async function installOperationsAdmin({ dbFile, ...options }) {
  const socketPath = path.join(path.dirname(dbFile), 'operations-admin.sock');
  const directory = fs.lstatSync(path.dirname(socketPath));
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid() || directory.mode & 0o022) throw error('unsafe_socket_directory');
  if (fs.existsSync(socketPath)) {
    const previous = fs.lstatSync(socketPath);
    if (!previous.isSocket() || previous.uid !== process.getuid() || previous.mode & 0o077) throw error('unsafe_socket');
    const occupied = await new Promise(resolve => {
      const client = net.createConnection(socketPath);
      client.setTimeout(1000);
      client.once('connect', () => { client.destroy(); resolve(true); });
      client.once('timeout', () => { client.destroy(); resolve(true); });
      client.once('error', failure => resolve(failure.code !== 'ECONNREFUSED'));
    });
    if (occupied) throw error('socket_in_use');
    fs.unlinkSync(socketPath);
  }
  const handle = createOperationsAdmin({ ...options, maintenanceStore: createMaintenanceStore(path.join(path.dirname(dbFile), 'gg-ops-maintenance.json')) });
  let active = 0;
  const server = http.createServer({ requestTimeout: 10000, headersTimeout: 5000, keepAliveTimeout: 1000, maxHeaderSize: 1024 }, async (request, response) => {
    const send = (status, value) => { const body = JSON.stringify(value); response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' }); response.end(body); };
    if (++active > 4) { active--; request.resume(); return send(429, { error: 'admin_busy' }); }
    try {
      if (request.method !== 'POST' || request.url !== '/v1' || request.headers['content-type'] !== 'application/json') { request.resume(); return send(400, { error: 'invalid_request' }); }
      const chunks = []; let size = 0;
      for await (const chunk of request) { size += chunk.length; if (size > 8192) { request.destroy(); return; } chunks.push(chunk); }
      let input;
      try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw error('invalid_request'); }
      return send(200, await handle(input));
    } catch (failure) {
      const allowed = ['invalid_request', 'account_not_found', 'protected_account', 'stale_snapshot', 'admin_busy', 'request_conflict', 'persistence_unconfirmed', 'account_state_invalid', 'accounts_unavailable', 'account_limit'];
      if (!response.destroyed) send(allowed.includes(failure.code) ? 409 : 503, { error: allowed.includes(failure.code) ? failure.code : 'administration_unavailable' });
    } finally { active--; }
  });
  server.maxConnections = 8;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  fs.chmodSync(socketPath, 0o600);
  server.announcement = handle.announcement;
  server.unref();
  return server;
}

module.exports = { createOperationsAdmin, installOperationsAdmin, maintenanceWindows };
