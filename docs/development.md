# Development and deployment

## Local setup

Use Node.js 24 or newer. The root workspace owns dependency installation. Run `npm install`, then follow the root README and bootstrap script for local configuration. `npm run dev` starts the service, console, and synthetic EHR server together.

SQLite removes the need for a local database daemon. Its runtime state belongs in the ignored `.data` directory. The development encryption key must remain available across restarts to decrypt saved credentials. Use only synthetic data with the mock EHR environments.

Run `npm run check` for TypeScript checks, automated tests and workspace builds. The storage tests verify atomic handoff consumption, refresh locking, ciphertext authentication and the standard PKCE challenge fixture. PostgreSQL-specific behavior also needs an actual PostgreSQL integration run; SQLite tests do not substitute for that check.

Point `SMART_FLINT_TEST_DATABASE_URL` at an isolated PostgreSQL development database and run `npx vitest run tests/postgres.test.ts` to exercise cross-pool handoff consumption, advisory-lock serialization and transaction rollback. These integration tests are skipped when that variable is absent.

## Local HTTPS for sandbox registrations

The Epic registration form tested on October 25, 2026 rejected HTTP redirect URIs, despite older documentation describing an HTTP development exception. Use the form's actual validation as the requirement for that registration. A scheme dropdown alone does not prove HTTP URLs can be saved.

The local HTTPS profile provides `https://127.0.0.1:3443` in front of the loopback bridge listener on port 3001. It does not publish a tunnel. The console stays at `http://127.0.0.1:3010` and the patient app at `http://127.0.0.1:4100`; Epic registers the bridge's HTTPS callback, while the app's separate callback remains registered inside SMART Flint. This profile is for local development only.

```sh
npm run https:setup
# Complete the explicit certificate-trust step described by the setup command.
# Stop the previous SMART Flint dev stack before starting this profile:
npm run dev:https
```

Certificates and private keys are generated in ignored `.data/https`. The setup command does not change macOS or browser trust. Trusting the development CA is a separate operator action that affects the Mac's certificate trust settings. Keep its private key local and do not commit or share it. Do not disable browser or Node certificate verification to work around a trust error.

`dev:https` supplies the HTTPS public origin consistently to the bridge, browser sample and backend sample, and passes the development CA to child Node processes through `NODE_EXTRA_CA_CERTS`. It reuses the local development registry, so existing Epic connection IDs are retained. Configuration pointing at production or external database storage is rejected rather than being seeded with demo records. The profile changes process environment only and does not rewrite `.env` or existing registrations.

Use the installation worksheet's exact HTTPS `redirectUri` and `launchUrl`. The registered callback uses the Epic connection's actual ID:

```text
https://127.0.0.1:3443/oauth/callback/CONNECTION_ID_FROM_WORKSHEET
```

Run `npm run test:https` with this stack active for a synthetic EHR launch using real TLS and an explicitly trusted CA. The check verifies both PKCE exchanges, the Secure OAuth binding cookie, patient context and a gateway read. Node trust in this check is scoped to the test process; passing it does not install browser trust or establish live Epic compatibility.

### Diagnosing launch failures

The console overview's **Recent activity** shows launch stages. `launch.rejected` records a rejected issuer or missing/oversized launch handle before app bootstrap. `launch.authorizing` means the browser was directed to the configured EHR. `launch.denied` means an authorization error returned through the bound callback; its detail includes an allowlisted OAuth error code such as `access_denied`, `invalid_request`, `invalid_grant`, or Epic's documented `invalid_launch_token`. During an EHR launch, `invalid_grant` identifies failure to redeem the launch token for an authorization code. These two grant/launch-token errors also reach the app as their specific `error` code; the TypeScript SDK uses fixed explanatory messages. Other denials retain `authorization_denied`. Unknown upstream values become `unrecognized_error`. Upstream descriptions, error URLs and launch handles are never copied into these diagnostics. Older generic denial events cannot retrospectively recover the discarded code. `launch.failed` records failures during token exchange or activation requirements, while `activation.ready` confirms that OAuth and the required launch context succeeded. Start a fresh test in the vendor launcher when reproducing a failure instead of reusing a copied launch-token URL.

For an Epic patient app, open [SMART on FHIR (OAuth 2.0)](https://fhir.epic.com/Documentation?docId=launching) → **Try It**, select your own patient registration in the first application dropdown, and confirm the next field is **Select a MyChart user**. Choose a listed user and supply the worksheet's base `launchUrl`; let Epic append fresh `iss` and `launch` values. Epic's default **SMART on FHIR test** selection uses a clinician context and shows **Select a patient**. A successful default test with a Practitioner identity and `user/...` scopes is evidence for that clinician workflow; compare the same audience when validating your patient registration. If a fresh patient launch still returns `invalid_grant`, test standalone from Health Compass using that Epic installation and the test patient's published MyChart credentials to isolate account authorization from LaunchPad token redemption. The error alone does not prove expiry, reuse, or a broken patient account.

## PostgreSQL container setup

The Compose file builds the application and starts PostgreSQL without publishing its port. The service itself binds to localhost by default so an operator can place a TLS reverse proxy in front of it.

Set the following environment values in an ignored local environment file or through the deployment secret system:

| Variable | Value |
| --- | --- |
| `BASE_URL` | Externally reachable HTTPS service URL |
| `CONSOLE_URL` | Console HTTPS origin; often the same as `BASE_URL` |
| `ENCRYPTION_KEY` | Base64 encoding of 32 random bytes |
| `ADMIN_AUTH_MODE` | `local` for standalone passwords or `oidc` for organization sign-in; generated configurations default to local |
| `ADMIN_TOKEN` | Random bootstrap token of at least 32 characters; used only with explicit first-owner bootstrap |
| `ADMIN_BOOTSTRAP_ENABLED` | `true` only for initial owner setup; automatically cut off once an active platform administrator exists |
| `ADMIN_OIDC_ISSUER`, `ADMIN_OIDC_CLIENT_ID` | Dedicated organization identity provider; see [administrative setup](administration.md) |
| `POSTGRES_PASSWORD` | A random URL-safe password, since it is interpolated into `DATABASE_URL` |
| `ALLOW_PRIVATE_NETWORKS` | `true` only when approved upstream EHR endpoints need private-network access |

Generate a value locally without copying it into a chat or source file:

```sh
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64') + '\n')"
```

Use `base64url` instead of `base64` for the administrative token and database password. Retain the encryption key separately from the database backup.

```sh
docker compose up --build -d
docker compose logs --tail=100 flint
```

Configure your TLS proxy to send service and console traffic to the loopback service port. Register the exact HTTPS launch/callback URLs produced by SMART Flint with the corresponding EHR vendor and organization. Demo mode is disabled in this configuration. Verify a synthetic or vendor-sandbox launch before working with a real environment.

The container healthcheck and dependency readiness support deployment monitoring. The compiled `npm run ops` command supplies offline encrypted backup, verification, empty-target restore and atomic vault-key rotation for SQLite and PostgreSQL. Follow [production operations and recovery](operations.md), including a restore rehearsal and separately protected encryption keys. Certificate renewal, network egress policy, off-host backup retention and deployment log retention remain operator responsibilities. See [security.md](security.md) for the current trust boundaries.

## SDK and FHIR client development

The HTTP contract is the interoperability boundary. Applications can use the TypeScript SDK or call the API directly. FHIR clients only need a configurable base URL and supported authentication mechanism. Keep their endpoint and credentials tied to one activation and connection.

Native source examples demonstrate the integration shape; their verification status is recorded with the examples. Platform compilation, return-link entitlement configuration and secure-storage integration need the relevant native toolchain and an application project.
