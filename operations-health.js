'use strict';
const fs = require('fs');

function createOperationalHealth({ dbFile, clock = Date.now, readFile = fs.promises.readFile } = {}) {
  let loadHealthy = null, diskHealthy = null, lastProbe = 0, lastWrite = 0, writeFailed = false;
  let lastTick = 0, tickFailed = false, tickFailures = 0;
  const active = new Map();
  const isTick = name => name === 'galaxyTick' || name === 'galaxyTick-start';
  function prune() { for (const [id, at] of active) if (clock() - at >= 300000) active.delete(id); }
  return {
    load(ok) { loadHealthy = ok === true; },
    write(error) { writeFailed = Boolean(error); if (!error) lastWrite = clock(); },
    tickStart() { return tickFailures; },
    tickError(name) { if (isTick(name)) { tickFailed = true; tickFailures++; } },
    tickDone(name, before) { if (isTick(name) && before === tickFailures) { lastTick = clock(); tickFailed = false; } },
    touch(id) { prune(); if (typeof id === 'string' && id && (active.has(id) || active.size < 10000)) active.set(id, clock()); },
    async probe() {
      try {
        const raw = await readFile(dbFile, 'utf8');
        const data = JSON.parse(raw);
        diskHealthy = Boolean(data && ['users', 'private', 'shared'].every(k => data[k] && typeof data[k] === 'object' && !Array.isArray(data[k])));
      } catch { diskHealthy = false; }
      lastProbe = clock(); prune();
    },
    snapshot({ announcement, attacksPaused = false } = {}) {
      prune(); const now = clock();
      const checks = {
        database: loadHealthy === false ? false : lastProbe ? diskHealthy === true && now - lastProbe <= 90000 : null,
        simulation: tickFailed ? false : lastTick ? now - lastTick <= 18 * 60000 : null,
        persistence: writeFailed ? false : lastWrite ? now - lastWrite <= 6 * 60000 : null,
      };
      const window = Boolean(announcement && Number.isFinite(announcement.ab) && announcement.ab <= now &&
        now < announcement.ab + Number(announcement.dauerMinuten || 0) * 60000);
      return { operationsHealthVersion: 1, checks, players: active.size, playerWindowSeconds: 300,
        maintenance: { active: window || attacksPaused === true,
          mode: attacksPaused ? 'attacks-paused' : window ? 'announced-window' : 'off' },
        operationalTimes: { databaseCheckedAt: lastProbe || null, persistedAt: lastWrite || null, galaxyTickAt: lastTick || null } };
    },
  };
}
module.exports = { createOperationalHealth };
