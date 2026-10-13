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

Saved version IDs combine the backend Git commit with the canonical source
manifest SHA256, including both revisions, file hashes and compatibility proofs.
Compatibility requires matching JSON loader, writer, authentication,
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

## Content-addressed archives and local upgrade (13 October 2026)

New captures use archive format 2. `source.json.gz` contains bounded metadata,
not combined base64 file contents. Private `blobs/<SHA256>.gz` files hold source
bytes once even when the same asset appears in frontend and web directories or
in several releases. Every file reference still binds its area, name, byte count
and hash. Capture publishes an archive directory only after its files have been
flushed, then loads it again and verifies the complete manifest, all referenced
blobs and the source-derived compatibility proofs. Restore validates all blobs
before changing source files.

The budget remains 256 MiB of distinct decoded source bytes per release, with a
separate 512 MiB limit on the logical file references including duplicates.
Individual decoded files are limited to 16 MiB, the metadata index to 16 MiB,
and an archive to 30,000 references. The existing 256 MiB database backup limit
is unchanged. Compression and duplicate references do not weaken the decoded
byte, path, owner, permission or checksum checks. A capture does not assemble
the entire release payload in memory.

Existing format-1 archives and their manifests remain byte-for-byte intact.
The compatibility reader streams one legacy file entry at a time into verified
private blobs and preserves the original release ID. Supporting the old file
format does not make a different engine, loader, session or operations contract
a compatible source rollback target. Blobs referenced by retained releases are
not deleted by this upgrade.

An interrupted old deployment whose current frontend and web assets exceed the
format-1 aggregate limit needs the reviewed local operator bootstrap in
`tools/upgrade-release-archive.cjs`. Ordinary `kepler-releases.py --initialize`
rejects an existing deployment lock and cannot take over that transaction. The
bootstrap is not a game HTTP action. Its CLI has fixed production roots, store
and stage paths; dependency injection is available only through the module for
isolated tests.

The private `/data/operations-releases/archive-upgrade` stage and its files must
have mode 0700 and 0600. Its `config.json` binds the full old/new backend commits,
frontend commit, unchanged server Git blob, old/new engine SHA256, runtime proof
and exact failed transaction UUID. `candidate-engine.cjs` must contain the
approved Git bytes; newline conversion would invalidate its hash. Existing
untracked operational files must be preserved separately by the operator before
the bootstrap, which requires clean repositories. Quarantine uses metadata and
same-filesystem moves; it does not inspect file contents or delete them.

The old checkout does not yet contain the new helper. Stage the approved helper
as `/data/operations-releases/archive-upgrade/upgrade.cjs` before running these
commands inside the fixed backend container. Run the stages in order:

1. `node /data/operations-releases/archive-upgrade/upgrade.cjs prepare` preserves the old engine,
   contract and state, and fsyncs a preparation intent with its next UUID. It
   marks only the identified failed old transaction unconfirmed through its
   native API, flushes the authoritative process and uses format 2 to archive
   the actual current source plus a fresh verified private database backup.
2. `node /data/operations-releases/archive-upgrade/upgrade.cjs apply` requires that same reservation,
   the unchanged source pins and the approved limited diff. It fast-forwards
   the backend and replaces the retained engine and runtime contract with
   separate fsynced file renames and readback checks. The old pair stays private
   in the stage; the two renames are not one atomic pair operation.
3. Restart the fixed backend container through the existing operator path.
   Pin and update the installed GG helper's adjacent engine bytes separately;
   its own hash check must agree with the retained engine. Preserve that
   mirror's old bytes for recovery. Then run
   `node /data/operations-releases/archive-upgrade/upgrade.cjs finalize`. It independently verifies
   running commit, checkout, server blob, all three health checks and zero tick
   errors before the final capture and release of its own reservation. Check
   the private bridge, inventory and public deployment proof afterwards.

Preparation, final capture and rollback have narrow crash-replay checks tied to
the receipt, expected UUID and real state. They do not adopt a foreign lock or
fabricate a completed state. If applying the source or pair fails, run
`node /data/operations-releases/archive-upgrade/upgrade.cjs rollback`, restore the separately
preserved GG mirror, and restart the fixed container. Only after verified old
process health run
`node /data/operations-releases/archive-upgrade/upgrade.cjs finish-rollback-healthy`.
The source and old pair are restored; the database is never restored. Because
the old retained engine cannot consume the new checkpoint format, this result
is honestly `external-unconfirmed` with `archiveCompatible:false`, rather than
an ordinary completed deployment. Archive administration stays blocked until
a further reviewed repair; keep the staged format-2 provider and private
recovery receipt. A failed health check retains an unconfirmed state and lock.

Stop on an unexpected UUID, phase, engine/contract/runtime hash, source revision,
server blob, active legacy lock or pending deploy, archive/backup readback error,
or failed running health. Do not remove locks, edit state or contract hashes,
raise archive limits, restore a database backup, or replace the normal deploy
guard to force an upgrade through.

Additional Linux verification uses real temporary Git repositories and private
filesystem state, fabricated databases and both actual engine implementations:

```
git fetch --no-tags --depth=1 origin f5d26daecce85d6a85fde3baa8a4d4c8d81ada52
node --test tests/test_operations_archive_blobs.mjs tests/test_operations_archive_upgrade.mjs
node tests/check_operations_archive_blob_counterexamples.cjs
```

These checks include complete format-2/legacy validation, crash/receipt/pair
recovery and a controlled old-engine size failure. The bounded-heap comparison
sets both the parent CLI flag and inherited `NODE_OPTIONS` so the real legacy
index worker receives the same heap limit. It does not claim a measured total
process RSS. Windows skips of POSIX checks are not a successful Linux validation;
deployment still requires the actual completed Linux CI results and raw logs.
