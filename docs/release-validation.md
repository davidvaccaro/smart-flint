# Production and distribution validation — October 28, 2026

This records implementation/qualification of production operations, release security gates, developer artifacts and source-available distribution. Additional vendor/pathway testing remains deliberately deferred. Version remains `0.1.0`; candidates are private and unpublished.

## Service, storage and security

`npm run check` passed TypeScript checks, all production builds and **274 tests with no skips** on Node 24.22.1, using a dedicated disposable PostgreSQL 17 database in addition to isolated SQLite fixtures. The tests include named local/OIDC identity, scoped authorization, replay/refresh ownership, storage/migration compatibility, authenticated backups, empty-target restore, key rotation, safe failure rollback, diagnostics and release artifact boundaries.

The focused `security:check` passed with zero known npm dependency advisories at execution time. A separate read-only engineering review checked the new diagnostics and offline recovery/rotation boundaries. Review findings about scanner-output privacy and acceptance-fixture cleanup were corrected. This is not an independent penetration test.

The actual final runtime image `smart-flint:0.1.0-candidate` passed the strict pinned Trivy scan: **zero detected vulnerabilities at any severity and zero embedded secrets**. The image uses pinned Node 24.22.1 on Alpine, omits npm/npx/corepack/yarn, runs as an unprivileged user and is exercised with a read-only root filesystem, no added capabilities and no-new-privileges. An earlier Debian image had findings; those findings were resolved by minimizing the runtime rather than ignored. Private scanner evidence is in `.data/security-final/`, including the CycloneDX image inventory. Results describe the executed scan and must be refreshed for future releases.

## Actual production deployment and recovery

`npm run test:production` passed against the final compiled image with disposable PostgreSQL, HTTPS edge and Keycloak 26.8.1 containers. It verified:

- Production Compose configuration and loopback host exposure; bundled console and compiled maintenance entry points.
- First local owner, Secure/HttpOnly cookie, bootstrap retirement, and identity/session persistence after application restart.
- Database shutdown returning HTTP 503 readiness while process liveness remains HTTP 200, followed by recovery after database restart. This test found and fixed an unhandled PostgreSQL idle-client error.
- An actual encrypted backup from the compiled container, authenticated verification, restore into a fresh database, rejection of the old session and successful sign-in with the retained account.
- Real Keycloak confidential-client sign-in with `client_secret_basic`, S256 PKCE, signed ID token, configured issuer/subject, disabled local fallback, Secure/HttpOnly session and logout.

TLS used an isolated certificate pinned only for the test. No system certificate trust changed. Containers, test database/network, backup volume and temporary identity secrets were removed. The Keycloak test does not qualify another organization's identity policies or other provider products.

## Developer and browser evidence

The standalone npm SDK/contracts archives installed offline in a clean consumer outside the repository, imported as JavaScript, typechecked their declarations and exercised PKCE/redemption, gateway/direct credentials, lazy renewal, original-token access and safe serialization.

Python wheel and source distribution were built with pinned packaging tools. The source distribution was rebuilt; both resulting wheels installed into independent clean virtual environments and passed all nine transport/credential tests each.

The Apple package passed three synthetic transaction tests, macOS compilation, iOS Simulator module compilation and UIKit/system-browser sample typechecking. Android adapter and browser Activity sources compiled against an installed Android SDK. These are protocol/compilation checks; real-device browser, app-link ownership, lifecycle and vendor acceptance remain separate work.

Administrative UI, native-password browser flow, SSO browser flow and workspace acceptance passed. The restored trusted HTTPS stack passed the console, Health Compass and historical-view browser suites, plus **48 synthetic CDS/backend operations with zero failures** and closed test activations. These existing synthetic regressions do not extend the real EHR compatibility claims.

## Preservation and candidate boundaries

Comparison with a private pre-change SQLite backup verified identical saved organizations, platforms, applications, connections, OAuth profiles, vendor registrations, installations, CDS services, administrative users and encrypted vault records. The storage ledger is additive. No saved EHR registration, password, upstream credential or master encryption key was changed.

The local stack runs on the project-scoped, checksum-verified Node 24.22.1 runtime under `.data/tools/`; the machine's global Node installation was not changed. The existing local CA remains in place. Console: `http://127.0.0.1:3010`; trusted API: `https://127.0.0.1:3443`.

The prepared local candidate contains source, two npm archives, Python wheel/sdist, the container archive, dependency notices, SPDX npm inventory, image CycloneDX inventory, manifest and SHA-256 checksums. The local image is **linux/arm64**; the Ubuntu release workflow builds its runner's Linux architecture. Source rebuild and target-platform verification are required for other architectures. Candidate preparation excludes `.data`, environment secrets, private keys/databases, development caches and symlinks; outputs are immutable and remain private. No package, image or public repository release was published, and no new vendor/pathway qualification was performed.
