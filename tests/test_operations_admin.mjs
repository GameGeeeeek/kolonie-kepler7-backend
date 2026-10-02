import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import runtime from '../operations-admin.js';

const OWNER = '11111111-1111-4111-8111-111111111111';
const PLAYER = '22222222-2222-4222-8222-222222222222';
const now = 1700000010000;
function fixture(extra = {}) {
  const db = { users: {
    gamegeeeeek: { userId: OWNER, username: 'GameGeeeeek', passwordHash: 'owner-private-password-fixture', email: 'private-owner@example.invalid', createdAt: now - 10000 },
    player: { userId: PLAYER, username: 'FixturePlayer', passwordHash: 'player-private-password-fixture', email: 'private-player@example.invalid', emailVerified: true,
      activeSessionId: 'private-player-session-fixture', activeSessionAt: now, tokenVersion: 2, createdAt: now - 10000 },
  }, private: { [PLAYER]: { fixture: 'Game state must survive.' } }, shared: {} };
  let saved = null, writes = 0;
  const controller = runtime.createOperationsAdmin({ getDb: () => db, saveDb: async () => { writes++; saved = structuredClone(db); },
    opsHealth: { snapshot: () => ({ checks: { persistence: true }, operationalTimes: { persistedAt: now } }) }, clock: () => now, ...extra });
  const status = async () => (await controller({ action: 'status' })).capabilities;
  const input = async (action, accountId = PLAYER, requestId = randomUUID()) => ({ action, accountId, reason: 'Fixture administrative reason', confirmed: true, requestId, expectedSnapshot: (await status()).snapshot });
  return { db, controller, status, input, writes: () => writes, saved: () => saved };
}

test('Kepler search uses live RAM, bounded pages and an explicit credential-free account allowlist', async () => {
  const f = fixture();
  const answer = await f.controller({ action: 'players', search: 'fixture', page: 0 });
  assert.equal(answer.host, 'pi'); assert.equal(answer.game, 'kepler');
  assert.equal(answer.total, 1); assert.equal(answer.accounts[0].id, PLAYER); assert.equal(answer.accounts[0].activeSessions, 1);
  assert.equal(answer.accounts[0].verified, true);
  for (const value of ['private-player-session-fixture', 'player-private-password-fixture', 'private-player@example.invalid', 'tokenVersion']) assert(!JSON.stringify(answer).includes(value));
  assert.equal(f.writes(), 0);
  f.db.users.player.username = 'ChangedInRam';
  assert.equal((await f.controller({ action: 'players', search: 'ChangedInRam', page: 0 })).total, 1);
  for (let index = 0; index < 30; index++) f.db.users['extra_' + index] = { userId: randomUUID(), username: 'Extra_' + index };
  assert.equal((await f.controller({ action: 'players', search: '', page: 0 })).accounts.length, 25);
  assert.equal((await f.controller({ action: 'players', search: '', page: 1 })).accounts.length, 7);
  await assert.rejects(f.controller({ action: 'players', search: '\n', page: 0 }), { code: 'invalid_request' });
  await assert.rejects(f.controller({ action: 'players', search: '', page: -1 }), { code: 'invalid_request' });
});

test('block, unblock and revoke change the authoritative account and persist; revocation includes legacy SID-less tokens', async () => {
  const f = fixture(), player = f.db.users.player;
  const privateState = structuredClone(f.db.private);
  const blocked = await f.controller(await f.input('player-block'));
  assert.equal(blocked.health, true); assert.equal(blocked.revokedSessions, 1);
  assert.equal(player.banned, true); assert.equal(player.bannBis, 0); assert.equal(player.bannSeit, now);
  assert.equal(player.tokenVersion, 3); assert.equal(player.activeSessionId, undefined);
  assert.equal(f.saved().users.player.tokenVersion, 3);
  assert.notEqual(player.tokenVersion, 2, 'Existing middleware must reject old JWT tokenVersion even without SID');
  await f.controller(await f.input('player-unblock'));
  assert.equal(player.banned, false); assert.equal(player.tokenVersion, 3, 'Unblocking must not restore previously invalidated JWTs');
  player.activeSessionId = 'another-private-session-fixture';
  await f.controller(await f.input('player-revoke'));
  assert.equal(player.tokenVersion, 4); assert.equal(player.activeSessionId, undefined);
  assert.deepEqual(f.db.private, privateState);
  assert.equal(f.writes(), 3);
});

test('Kepler owner, stale snapshots, unknown accounts, extra fields and invalid confirmation are protected', async () => {
  const f = fixture();
  await assert.rejects(f.controller(await f.input('player-block', OWNER)), { code: 'protected_account' });
  const stale = await f.input('player-block');
  f.db.users.player.activeSessionId = 'new-session-fixture';
  await assert.rejects(f.controller(stale), { code: 'stale_snapshot' });
  await assert.rejects(f.controller(await f.input('player-block', randomUUID())), { code: 'account_not_found' });
  await assert.rejects(f.controller({ ...await f.input('player-block'), confirmed: false }), { code: 'invalid_request' });
  await assert.rejects(f.controller({ ...await f.input('player-block'), command: 'ignored-command-fixture' }), { code: 'invalid_request' });
  assert.equal(f.writes(), 0); assert.equal(f.db.users.player.tokenVersion, 2);
});

test('parallel identical and persisted requests revoke once; conflicting reuse and simultaneous mutations fail closed', async () => {
  let finish, writes = 0;
  const pending = new Promise(resolve => { finish = resolve; });
  const f = fixture({ saveDb: () => { writes++; return pending; } });
  const request = await f.input('player-revoke');
  const first = f.controller(request), second = f.controller(request);
  await assert.rejects(f.controller({ ...request, reason: 'Different reason fixture' }), { code: 'request_conflict' });
  await assert.rejects(f.controller(await f.input('player-block')), { code: 'admin_busy' });
  finish();
  const result = await Promise.all([first, second]);
  assert.deepEqual(result[0], result[1]); assert.equal(writes, 1); assert.equal(f.db.users.player.tokenVersion, 3);
  assert.deepEqual(await f.controller(request), result[0]); assert.equal(f.db.users.player.tokenVersion, 3);
});

test('legacy saveDb write failure or missing persistence proof never becomes a successful account action', async () => {
  for (const proof of [{ checks: { persistence: false }, operationalTimes: { persistedAt: now } },
    { checks: { persistence: true }, operationalTimes: { persistedAt: now - 1 } }]) {
    const f = fixture({ opsHealth: { snapshot: () => proof } });
    await assert.rejects(f.controller(await f.input('player-revoke')), { code: 'persistence_unconfirmed' });
    assert.equal(f.db.users.player.tokenVersion, 3, 'Keep conservative in-memory revocation after an uncertain disk write');
    assert.equal(f.db.operationsAdmin.actions.length, 0);
  }
});

test('planned Kepler notices persist through their separate store and feed the existing advisory without changing accounts', async () => {
  let saved = { version: 1, publishedAt: 0, windows: [] };
  const store = { load: () => structuredClone(saved), save: async (windows, publishedAt) => (saved = { version: 1, publishedAt, windows: structuredClone(windows) }) };
  const f = fixture({ maintenanceStore: store });
  const before = structuredClone(f.db);
  const windows = [{ id: randomUUID(), startsAt: now + 60000, endsAt: now + 1800000, message: 'Fixture planned maintenance' }];
  const result = await f.controller({ action: 'maintenance-publish', windows });
  assert.equal(result.published, true); assert.equal(result.readback, true);
  assert.deepEqual(f.controller.announcement(), { text: windows[0].message, ab: windows[0].startsAt, dauerMinuten: 29, gesetzt: now });
  assert.equal(f.controller.announcement(now + 1800001), null);
  assert.deepEqual(f.db, before); assert.equal(f.writes(), 0);
  const restarted = fixture({ maintenanceStore: store });
  assert.equal(restarted.controller.announcement().text, windows[0].message);
  assert.equal((await restarted.status()).maintenancePublish, true);
  await f.controller({ action: 'maintenance-publish', windows: [] }); assert.equal(f.controller.announcement(), null);
  await assert.rejects(f.controller({ action: 'maintenance-publish', windows: [windows[0], windows[0]] }), { code: 'invalid_request' });
  await assert.rejects(f.controller({ action: 'maintenance-publish', windows: [{ ...windows[0], endsAt: windows[0].startsAt + 86400001 }] }), { code: 'invalid_request' });
});
