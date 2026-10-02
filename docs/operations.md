# Private GG operations bridge and saved versions

The GG Betrieb helper talks to the authoritative game process through
`operations-admin.sock` beside the configured `DB_FILE`. The socket is owned by
the backend process and has mode 0600. No public HTTP route, password or JWT is
added. Listing returns an explicit account field allowlist; blocking or revoking
increments tokenVersion, clears the active session and verifies persisted health.
The GameGeeeeek owner is protected. Request UUIDs and account snapshots prevent
stale mutations and duplicate revocation.

Planned notices use a separate private `gg-ops-maintenance.json` file. The existing
announcement endpoint displays the next unexpired notice alongside manual owner
announcements. These messages do not pause the game.

The signed deployment webhook and the existing host cron both use the same
`starteDeploy` pending/restart path. The release guard first flushes the running
database, reserves the shared deployment lock, verifies a private database backup,
and saves an immutable source/web archive before source changes. Successful
deployment saves the new revision. Missing archive setup blocks source changes.
Install the private retained release engine with the GG Betrieb helper before
merging this feature; its local `kepler-releases.py --initialize` command reserves
the same lock and requires matching engine hashes. This initialization is local
installation work and cannot be selected through a game HTTP request.

Saved version IDs combine the backend Git commit with the complete archive
SHA256. Compatibility requires matching JSON loader, writer, authentication,
private operations and runtime layout contracts. Old versions without these
operations hooks remain visible as incompatible baselines. A verified version
switch backs up the current DB, changes only manifest source/web files, restarts
the fixed container and verifies running commit/blob plus database, persistence,
simulation and private bridge health. A failed check restores the prior source
and restarts it using the retained engine in an isolated maintenance container.
The database is never restored during a code rollback.

Environment files, private keys and credential filenames are excluded by name
without reading their contents. Version switches preserve those working-tree
files and update Git index/HEAD metadata without `reset --hard`. Archives never
contain account records; database backups are separate private files. A local
operator can prepare a candidate in the fixed private `staging/backend`,
`staging/frontend`, `staging/web` directories and publish its checked archive with
`kepler-releases.py --publish-stage` before choosing it in GG Betrieb.

Verification uses fabricated accounts and isolated source/data directories:

```
node --check server.js
node tests/test_serverstart.js
node --test tests/test_operations_admin.mjs tests/test_operations_guard.mjs tests/test_operations_releases.mjs tests/test_operations_http.mjs
```

The UNIX socket, file permissions, archive locks, preserved credentials and actual
HTTP token revocation tests run on Linux CI.
