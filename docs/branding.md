# SMART Flint branding and development upgrade

SMART Flint is the product name. Use both words, with SMART capitalized, in the console, sample attribution, documentation, and vendor portal app descriptions. The short description is **SMART on FHIR integration, simplified.** Health Compass remains the name of the patient sample application.

| Surface | Name |
| --- | --- |
| Product | SMART Flint |
| Checkout directory | `SMARTFlint` |
| Root npm workspace | `smart-flint` |
| TypeScript packages | `@smart-flint/sdk`, `@smart-flint/contracts`, `@smart-flint/health-assessment` |
| SDK client and error | `SMARTFlintClient`, `SMARTFlintError` |
| Python distribution / import | `smart-flint` / `smart_flint` |
| Native example target | `SMARTFlintNativeExample` |
| App launch ticket parameter | `smart_flint_launch` |
| Browser transaction prefix | `smart-flint:launch:` |
| App environment variables | `SMART_FLINT_URL`, `VITE_SMART_FLINT_URL` |
| Gateway extension headers | `X-SMART-Flint-Capabilities`, `X-SMART-Flint-Normalization` |
| SQLite development database | `.data/smart-flint.sqlite` |
| Database tables | `smart_flint_*` |
| Compose project / service | `smart-flint` / `flint` |
| Local certificate authority | SMART Flint Local Development CA |

These are coordinated prerelease API and packaging changes. Update SDK imports, custom callback handlers, environment variables, and test configuration together. Use a fresh browser launch after upgrading; in-progress browser transactions use the earlier parameter and storage names. Refresh ownership values such as `bridge` remain protocol roles.

## Existing local development data

Stop the entire development stack before upgrading an existing local database. Keep the original `.data/encryption.key`; replacing it would prevent decryption of existing credentials.

```sh
node scripts/rebrand-storage.mjs --offline
npm install
npm run check
```

The explicit migration recognizes the previous database filename, table prefix, and authenticated encryption context. It creates a private, consistent SQLite backup, converts tables and re-encrypts secrets in a staging database, verifies every secret and record, and publishes the new database without overwriting an existing target. It preserves record IDs, registration client IDs, callback URLs, and secret contents. A safe rerun validates the migrated database. The script currently migrates local SQLite storage only; it does not migrate an existing PostgreSQL deployment.

Historical backups and the migration's source identifiers intentionally retain their original contents. Do not replace text inside encrypted envelopes, tokens, private keys, or backup databases.

Built-in synthetic registrations must use the client IDs expected by the rebranded mock EHR: `smart-flint-demo`, `smart-flint-health-patient`, and `smart-flint-service`. Update these three existing fixture client profiles when retaining an earlier registry. Vendor-assigned client IDs remain unchanged. If a sandbox lets you choose your own client ID, update its registration and the matching SMART Flint client profile together.

## Local HTTPS and sandbox registrations

New development certificates use the SMART Flint CA name. To replace an existing project CA, stop the local HTTPS stack, privately archive the entire `.data/https` directory, and run `npm run https:setup`. Trust the new CA using the command printed by the setup script, then run `npm run dev:https`. The setup and development scripts never alter operating-system trust automatically.

The rebrand does not require different listener ports: console **3010**, API **3001**, trusted local HTTPS **3443**, and Health Compass **4100**. Launch and OAuth callback URLs use opaque installation and connection IDs. If their origins and IDs are unchanged, their exact URL values remain valid in Epic and SMART Health IT. Vendor portal display names can be changed to **Health Compass — SMART Flint Sandbox**. Always copy exact current launch and callback values from the installation worksheet.
