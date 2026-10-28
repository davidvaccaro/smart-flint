# Administrative identity validation

Validation performed October 27, 2026 for named administrative identity, scoped permissions, and actor-attributed audit records. Setup and support boundaries are in [administration](administration.md).

## Automated evidence

- TypeScript checks and production builds passed.
- **226 automated tests passed with no skips** using a temporary, isolated PostgreSQL 17 database bound only to loopback. The temporary container was removed after verification.
- `tests/admin-auth.test.ts` covers authorization code/S256 PKCE, signed ID tokens, issuer/audience/authorized-party/nonce/time checks, both confidential client authentication methods, replay and expiry, browser binding, disabled identities, no email/group elevation, and controlled bootstrap retirement.
- `tests/admin-access.test.ts` covers disjoint organization/application assignments, both scope axes, metadata projections, shared-resource mutation protection, read-only roles, fresh session authorization after account changes, concurrent audit actor binding, user-management restrictions, and last-owner protection.
- Permission regressions specifically prevent hidden integration identifiers appearing through organization-level audit visibility and prevent read-only shared client credentials being rebound to an operator-controlled upstream connection.
- `tests/admin-postgres.test.ts` uses independent application instances and pools to verify permission changes on existing sessions and concurrent final-owner protection.

The existing PostgreSQL checks for atomic handoff consumption, refresh locking, rollback, and committed reauthorization failure state also passed. CI supplies its own isolated PostgreSQL database and runs these checks with `SMART_FLINT_TEST_DATABASE_URL`.

## Browser evidence

`npm run test:admin-oidc` passed a real browser round trip between a loopback application and a synthetic provider on a different site. The provider verifies S256 PKCE and issues a signed ID token. The check verifies named-user sign-in, browser cookie behavior, scoped dashboard access, denied mutations, audit actor identity, and logout. It does not use an external enterprise identity provider or disable certificate validation.

`npm run test:admin-ui` passed isolated UI checks for SSO/bootstrap visibility, user provisioning, assignment selection, role-specific controls, shared-resource restrictions, last-owner errors, and responsive layouts. Desktop and mobile screenshots were inspected.

The existing workspace, console, patient app, and historical-assessment browser suites passed. The trusted local HTTPS SMART launch passed, along with **48 synthetic CDS/backend sample operations** across gateway and direct access. Test activations were closed by their suites.

## Saved deployment and remaining setup

A private pre-change SQLite backup was created. Before the live regression suites, a comparison verified unchanged records for seven organizations, four EHR platforms, four applications, six connections, five OAuth client profiles, ten portal registrations, fourteen installations, and five CDS services. Static signing/application credentials were unchanged. Startup adds the administrative-user table without replacing the existing registry or encryption key.

The local development stack retains **Open local workspace**. No real administrative accounts or external identity provider were provisioned in the saved workspace. Production deployments must select local password or OIDC sign-in and perform the first-owner bootstrap handoff. OIDC deployments additionally configure their own client, verify the exact issuer/subject for the first owner, and validate the provider in their environment. Existing Epic and SMART Health IT registrations do not need changes for this administrative feature.

## Local password administration — October 28, 2026

TypeScript checks and all production builds passed. **246 automated tests passed with no skips**, including the existing authorization and permission checks and the new local password, recovery, and PostgreSQL cases. The disposable PostgreSQL 17 database was bound only to loopback and removed after verification.

- `tests/admin-local-auth.test.ts` verifies scrypt password records, password validation and Unicode handling, case-insensitive ASCII usernames, safe user projections, selected authentication modes, bootstrap retirement, last-owner protection, current-password changes, and session invalidation.
- `tests/admin-recovery.test.ts` verifies offline operator recovery, the real CLI against a temporary SQLite database, hidden-input/file safeguards, fixed error output, audit records, attempt-counter clearing, preserved permissions and disabled state, and revoked sessions. The compiled production recovery command also passed its help check without a TypeScript loader.
- `tests/admin-local-postgres.test.ts` verifies credential changes and revoked sessions across independent application instances and pools, plus committed failed-password counters, normalized aliases, shared throttling across source IPs, expiry, and current-password verification limits.

`npm run test:admin-local` passed a real browser flow using an isolated in-memory deployment: bootstrap setup, first local owner, retired bootstrap access, disabled passwordless bypass, username/password sign-in, password change, revocation in two browser contexts, new-password sign-in, and logout. No external identity provider was contacted.

`npm run test:admin-local-ui`, `test:admin-ui`, `test:admin-oidc`, and `test:workspace` passed. The local sign-in, account creation, viewer password change, confirmation/reauthentication, and mobile layouts were checked alongside the existing SSO and scoped permission interfaces. Desktop and mobile screenshot evidence was generated.

The restored development stack passed `test:https`, `test:browser`, `test:samples`, `test:sample-history`, and `test:sample-stack`. The latter completed **48 synthetic CDS/backend operations with zero failures** and verified closed sample activations. These checks use synthetic EHRs; no new Epic or SMART Health IT vendor-side launch was performed during this change.

Before restarting the saved deployment, comparison with its private pre-change SQLite backup verified identical configuration records for seven organizations, four EHR platforms, four applications, six connections, five OAuth client profiles, ten portal registrations, fourteen installations, and five CDS services. All 164 encrypted vault records were identical. No native account, password, or external identity provider was added to the saved workspace. Its existing local demo remains available at port 3010; explicit `ADMIN_AUTH_MODE=local` enables the new password mode and suppresses demo bypass.
