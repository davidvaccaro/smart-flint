# Production operations and recovery

SMART Flint supports a single-process SQLite deployment and PostgreSQL deployments with shared locking. The service, its database and its master encryption key form one deployment. The runtime identity and the recovery operator are separate trust boundaries: offline operations require direct database/key access and are never exposed through the administrative API.

## Establish an operational baseline

Use the versioned production image/build and an explicit HTTPS origin. Complete first-owner setup, remove the bootstrap token, and verify the selected local or organization sign-in. Confirm that ordinary configuration persists after replacing the application container. Keep PostgreSQL private, arrange certificate renewal, and define backup retention and recovery objectives appropriate to the deployment.

The service's storage migration ledger records each applied storage version. Startup adopts the existing unversioned collection layout without changing record IDs or values, applies supported storage initialization in a transaction, and refuses newer or altered migration histories. PostgreSQL serializes initialization across instances. Application-level registry migrations remain additive and repeatable. The ledger is separate from integration configuration and cannot be edited through the console.

Before any upgrade, create and verify a backup and retain the matching encryption key. Rehearse the upgrade on a restored copy, including sign-in, installation worksheets and synthetic launch tests. Upgrade all replicas together when the release changes the storage contract. For rollback, restore the verified backup into a fresh database and run its matching image; do not run an older binary against a newer schema or edit the ledger to bypass refusal.

## Portable encrypted backups

The compiled operations command ships with the production server and needs no TypeScript loader:

```sh
npm run build
npm run ops -- --help
```

The commands use the deployment's `DATABASE_URL` or `SQLITE_PATH` and `ENCRYPTION_KEY`. Existing local development deployments can use their already-created `.data/encryption.key`; maintenance never generates a substitute key. `--key-file` explicitly selects a private key file, which is useful when verifying an older backup after a rotation. Keys are base64-encoded 32-byte random values and are never accepted as command-line values or printed.

Stop **every** service instance sharing the database before backup, restore or rotation. `--offline` is an operator attestation, not a probe or distributed shutdown mechanism. PostgreSQL itself must remain available.

```sh
umask 077
mkdir -p private-backups
npm run ops -- backup --offline --output private-backups/deployment.flint-backup
npm run ops -- verify --input private-backups/deployment.flint-backup
```

Backup takes a consistent database snapshot, validates all encrypted vault records with the current key, and encrypts the entire logical payload with AES-256-GCM and a fresh nonce. This protects configuration, audit metadata and clinical protocol records as well as the vault. Verification authenticates the backup and every nested vault record without opening a destination database. Its output contains only schema, source engine and record counts, never decrypted content.

Files must be owned by the operator, nonsymlink regular files with permission `0600` or stricter. Output directories must be owned by the operator and not writable by group/others. Publication uses a fully written, synced temporary file and an atomic exclusive link; an existing output, including a symlink, is never overwritten. Create a new filename for each backup. Store backup files off the application host according to your retention policy, and keep the corresponding key separately in the deployment's recovery secret store.

These portable JSON snapshots are bounded to 128 MiB of plaintext and a 256 MiB input file, with at most one million records. Operations use memory proportional to the snapshot. Larger deployments need a separately verified native PostgreSQL or SQLite backup process; do not remove limits to work around capacity planning. Native backups also require the matching master key and appropriate session invalidation on recovery.

## Compose backup

Stop application replicas, keep PostgreSQL running, and use the same Compose environment. This POSIX example runs the maintenance container with the host operator's numeric identity so private bind-mounted files remain owned by that operator:

```sh
umask 077
mkdir -p private-backups
docker compose stop flint
docker compose run --rm --no-deps --user "$(id -u):$(id -g)" \
  --volume "$PWD/private-backups:/backups" flint \
  node apps/server/dist/scripts/operations.js backup --offline --output /backups/deployment.flint-backup
docker compose run --rm --no-deps --user "$(id -u):$(id -g)" \
  --volume "$PWD/private-backups:/backups" flint \
  node apps/server/dist/scripts/operations.js verify --input /backups/deployment.flint-backup
docker compose up -d flint
```

For orchestrated deployments, stop all replicas first and run one controlled maintenance job with the same database and secret configuration. A stopped container in one project is not evidence that other replicas have stopped.

## Restore and rehearse recovery

Restore accepts only an **empty** compatible database. It never merges with or overwrites an existing deployment. Authenticate the backup before opening the target, then import all selected records in one transaction; an occupied target or failed import leaves existing records unchanged. SQLite and PostgreSQL backups can be restored across engines within the supported schema version.

```sh
# DATABASE_URL or SQLITE_PATH must point to a NEW empty recovery database.
# ENCRYPTION_KEY must be the key that encrypted this backup.
npm run ops -- verify --input private-backups/deployment.flint-backup
npm run ops -- restore --offline --input private-backups/deployment.flint-backup
```

The restore preserves organizations, applications, connections, registrations, installations, administrative users and their password generations, static signing/client/application credentials, and audit history. It deliberately discards saved browser sessions, authorization transactions, handoff codes, continuations, clinical activations and upstream refresh grants, along with their encrypted clinical/transaction envelopes. A fixed operator recovery event is added. Users sign in again and applications perform fresh launches; old sessions and launch codes are not resurrected. Restoring does not revoke tokens already exported to other applications. Review upstream token revocation and short-lived signed-caller replay windows as part of incident recovery.

A recovery drill must use a separate database/Compose project and an isolated hostname/port. Keep the original deployment and its volume intact. In the restored instance, verify readiness, sign-in, user roles, configuration counts, installation worksheet bindings and a synthetic launch. Record the elapsed restore time and backup age against your recovery objectives. Do not point two restored instances at the same upstream confidential-client grant lifecycle or treat a successful file verification as a completed restore drill.

## Rotate the master encryption key

Rotation keeps secret identifiers, values, local-password generations and integration configuration. It authenticates every existing envelope before preparing replacement ciphertext, then atomically replaces the unchanged vault generation and adds a fixed offline-operator audit event in the same commit. A wrong current key, corrupted record, failed audit insert or detected concurrent vault change fails without partial re-encryption. PostgreSQL uses a transaction and table lock; SQLite uses `BEGIN IMMEDIATE`. All service instances must remain stopped throughout.

Create a new private random key file without displaying its value:

```sh
node --input-type=module -e "import {randomBytes} from 'node:crypto'; import {writeFileSync} from 'node:fs'; writeFileSync('private-backups/new.key', randomBytes(32).toString('base64')+'\n', {mode:0o600, flag:'wx'});"
npm run ops -- rotate-key --offline \
  --new-key-file private-backups/new.key \
  --output private-backups/before-rotation.flint-backup
```

The CLI first creates and verifies a no-overwrite backup encrypted with the **old** key. Only then does it rotate the database vault. Update `ENCRYPTION_KEY` in the deployment secret store to the new file's value **before restarting any instance**. For the default local profile, securely replace `.data/encryption.key` as part of this operator step. The command does not rewrite `.env`, deployment secrets or key files automatically. Keep the new key durably stored before running the rotation, and retain the old key for old backups. Losing the new key after rotation requires restoring the pre-rotation backup with the old key.

Verify the new configuration and readiness, sign in, and perform a fresh synthetic launch before reopening traffic. If a deployment update fails, keep the service stopped while correcting its key; repeatedly replacing `ENCRYPTION_KEY` does not repair mismatched ciphertext. Rotation does not change upstream OAuth credentials or revoke existing exported tokens. [Local password recovery](administration.md#change-or-recover-a-local-password) is a separate operation.

## Failure response

`GET /health` reports process liveness. `GET /ready` checks the database and authenticates the stored signing envelope with the configured encryption key, returning only `ready` or HTTP 503 `not_ready`. Configure load balancers and the container healthcheck against readiness; liveness remains available during a dependency outage. The probe has a 2.5-second response bound; PostgreSQL connections and queries also have finite timeouts.

`GET /api/admin/operations` requires a platform administrator and returns process-local request/error/readiness/maintenance counters. Aggregate across replicas in your monitoring system; these counters reset when a process restarts. `OPERATIONS_LOGGING=true` enables fixed JSON operational events (the production default). They contain generated correlation IDs, route templates, status and duration, never concrete resource IDs, URLs, query strings, headers, bodies or error objects. Responses expose the same generated `X-Request-Id`. Maintenance failures generate a fixed event and are retried on a later pass. The existing administrative audit history remains separate and persistent.

Track database availability, storage capacity, certificate expiry, repeated authorization failures, maintenance failures and backup age. Keep clinical payloads, launch query strings, keys and token responses out of reverse-proxy and application logs. A starting TLS proxy configuration is supplied in `deploy/nginx.conf.example`. Restrict operational access to your operations network in addition to application authentication.

Maintenance command errors use fixed operator guidance and omit driver messages, paths containing connection credentials, key values and decrypted records. A successful backup must be followed by a restore rehearsal before relying on it for recovery. The runtime cannot recover encrypted records when all copies of the matching key have been lost.
