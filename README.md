# SMART Flint

A self-hosted SMART on FHIR integration service. SMART Flint manages launch orchestration, tenant connections, OAuth grants, context delivery, and optional FHIR access mediation. Applications can use their preferred FHIR client and choose how much of the connection lifecycle to delegate.

**SMART on FHIR integration, simplified.** See [branding and development upgrade](docs/branding.md) for package names, SDK imports, and migrating an existing local checkout.

**Version 0.1 is a working foundation.** The included EHR environments are synthetic protocol simulators. They demonstrate tenant and pathway behavior; they do not establish compatibility or certification with Epic, Oracle Health, MEDITECH, or any healthcare organization.

## Run locally

For a Docker-only guided setup, run `bash ./install.sh` on macOS/Linux or `./install.ps1` in Windows PowerShell. Choose a local sandbox with all samples or a secured deployment with local accounts/SSO and existing/automatic HTTPS. No host Node installation is needed for these paths. See the [installer guide](docs/installation.md) for prerequisites, image archives and start/status/stop controls. Existing installations and database volumes are preserved.

Use Node.js 24.22.1 or a newer supported security-patched release, and npm. The pinned version is in `.nvmrc`. A database server is optional for local development.

```sh
npm install
npm run dev
```

Open **http://127.0.0.1:3010**, then select **Open local workspace**. No vendor account or production credentials are needed. Use `127.0.0.1` consistently: registered callback URLs and approved browser origins match exactly. Explicit IPv4 loopback avoids reaching another application's IPv6 listener through `localhost`.

The workspace opens on **Applications**. **EHR Platforms**, **Organizations**, **Installations**, and **Activations** provide linked views of the same integration records. Vendor app registrations group environment-specific client profiles; organizations own their actual FHIR connections. See the [workspace guide](docs/workspace.md) for the model, guided setup and upgrade behavior.

| Local component | Address |
| --- | --- |
| Management console and reference app | http://127.0.0.1:3010 |
| SMART Flint API | http://127.0.0.1:3001 |
| Synthetic EHR | http://127.0.0.1:4010 |
| OpenAPI contract | http://127.0.0.1:3001/api/openapi.json |

Local development binds to loopback. The default SQLite database and generated encryption key live under `.data/`, which is ignored by Git. Keep the key with any database backup; encrypted records cannot be recovered without it. No `.env` is needed for the default demo. An existing production `.env` changes the runtime configuration, so use a separate checkout or environment for synthetic development.

Try the **Developer lab** to launch the reference application, change patients, compare gateway/direct access, transfer credential ownership, acquire backend access, and invoke a synthetic CDS hook. The simulator also exposes an EHR-initiated launch at http://127.0.0.1:4010/epic/northstar/ehr-launch.

Open **Sample library** in the console for the [Health Compass samples](samples/README.md): a separate patient-facing app at http://127.0.0.1:4100, a CDS Hooks handler on port 4101 and a headless FHIR assessment service on port 4102. `npm run dev` starts all six processes; `npm run dev:core` starts only the original three. They share an explainable, unvalidated educational model and four synthetic patient scenarios. See [executed sample evidence](docs/sample-validation.md) and [clinical model notes](packages/health-assessment/README.md).

Sandbox registrations that require HTTPS can use `npm run https:setup` and `npm run dev:https`. The bridge then has a loopback TLS endpoint at `https://127.0.0.1:3443`; certificate trust is an explicit one-time operator step. See [local HTTPS setup](docs/development.md#local-https-for-sandbox-registrations).

## Implemented

- EHR and standalone launch orchestration with upstream and downstream S256 PKCE, exact callbacks, browser binding, and single-use activation codes.
- Application-first configuration with managed EHR platform profiles, organizations and owned connections, vendor app registrations with client profiles, and guided installation setup.
- Encrypted upstream tokens, private keys, clinical context, and authorization transactions.
- OIDC identity validation with an approved issuer and pinned endpoint origins.
- An activation-scoped FHIR read/search gateway usable by ordinary HTTP/FHIR clients, including controlled pagination and an explicit display-whitespace normalization profile.
- Direct access to the original FHIR server and unchanged upstream access-token values, with optional bridge-managed renewal.
- Explicit credential handoff and a single owner for refresh-token rotation.
- SMART Backend Services using asymmetric JWT client authentication and application-specific API credentials.
- Authenticated synchronous CDS Hooks forwarding, request-bound prefetch/context, signed caller JWT verification, and replay protection.
- Named administrative users with selectable local password or OIDC sign-in, scoped integration/viewer roles, password changes and offline recovery, permission-aware UI and actor-attributed audit events.
- Operational launch events, redacted administration views, registration worksheets, and bounded retention.
- An optional TypeScript SDK, Python backend SDK, and native Swift/Android integration examples.
- PostgreSQL deployment support, SQLite development support, container packaging, and automated checks.

The generic SMART engine supports vendor labels and Epic client-specific discovery headers. Real vendor onboarding, additional vendor compatibility rules, customer enablement, and end-to-end verification remain necessary for each installation. Discovery status **Verified** means metadata was checked; it does not mean every requested interaction has been demonstrated.

## Choose an access mode

| Mode | Clinical traffic | Credential lifecycle |
| --- | --- | --- |
| `gateway` | Application → SMART Flint → EHR | SMART Flint holds upstream credentials and renews access |
| `direct` | Application → EHR | SMART Flint supplies current upstream access tokens and manages renewal |
| `handoff` | Application → EHR | Application explicitly takes ownership through the handoff API |

SDK use and gateway use are independently optional. The gateway uses standard FHIR HTTP responses and ordinary bearer authentication. Gateway tokens are SMART Flint session credentials; direct access uses upstream credentials. A connection is resolved at runtime, so application code does not need hardcoded tenant URLs.

Token export is an installation policy. Disabling it prevents subsequent credential retrieval, including from existing direct sessions. Exported credentials remain subject to upstream expiry and revocation. Gateway-specific auditing, normalization, and restrictions apply to traffic that uses the gateway.

`GET /api/activations/:id/credentials/original` returns an `OriginalCredentialResponse` envelope containing the original access token and response metadata. Refresh tokens are withheld while the bridge owns renewal; `POST .../credentials/handoff` returns current refresh credentials and transfers ownership once. A confidential registration can still require its client secret or private key for independent refresh; that private authentication material is not exported. Native applications must keep confidential authentication on a trusted backend. Sender-constrained grants need a compatible proof adapter and are explicitly rejected by this release.

## Connect an application

Start with an application and define its exact callback URLs, required context, required scopes, and permitted access modes. From that application, add an EHR integration by choosing an EHR platform, vendor registration and client profile, then an organization and FHIR connection. The installation binds those selections and their access policy. Its worksheet supplies the launch URL, OAuth callback, public keys where applicable, and remaining vendor/customer tasks. Existing resources can be reused across installations.

The reference app demonstrates the optional TypeScript SDK:

```ts
import { SMARTFlintClient } from '@smart-flint/sdk';

const flint = new SMARTFlintClient({ baseUrl: 'https://flint.example.com' });
const launch = await flint.start({
  installationId: 'your-installation-id',
  redirectUri: 'https://your-app.example.com/callback',
  mode: 'direct',
});
window.location.assign(launch.launchUrl);
```

At the callback:

```ts
const { activation, sessionToken } = await flint.completeRedirect();
const session = flint.session(activation.id, sessionToken);
const connection = await session.getFHIRConnection({ route: 'direct' });
// Configure any FHIR client with connection.baseUrl and
// connection.credentials.getAuthorizationHeader().
```

Keep the activation session in memory or in an application backend. The browser SDK stores only short-lived PKCE transaction material in session storage. See [developer onboarding](docs/developer-onboarding.md), [TypeScript SDK](packages/sdk/README.md), [Python SDK](sdks/python/README.md), and [native examples](examples/native/README.md). `npm run sdk:pack` creates independently installable npm archives; the Python packaging command builds a wheel and source distribution. Public registry publication is a separate release action.

## Deploy with PostgreSQL

```sh
npm run configure -- --base-url=https://flint.example.com
docker compose up --build -d
```

The configuration command creates a mode-600 `.env` with generated credentials and refuses to overwrite an existing file. Supply a real externally reachable HTTPS origin. Compose binds the service to `127.0.0.1:3001`, keeps PostgreSQL internal, and disables synthetic demo access. Terminate HTTPS in your reverse proxy. The production console is bundled into the service; use the explicitly enabled bootstrap token for first-owner setup and provision a named platform administrator. The configuration command defaults to standalone local username/password authentication; choose `--auth-mode=oidc` for organization sign-in. Production bootstrap access ends automatically when that owner exists. See [administrative sign-in and permissions](docs/administration.md).

For an existing PostgreSQL instance, supply `DATABASE_URL`. Explicitly enable `ALLOW_PRIVATE_NETWORKS=true` only when approved on-premises endpoints require private addresses; connection origin allowlists still apply. See [security and operational boundaries](docs/security.md), [architecture](docs/architecture.md), and [development](docs/development.md).

Protocol records expire automatically. Local activation sessions last at most eight hours, retained clinical activation context defaults to 24 hours (`RETENTION_HOURS`), and operational events expire after 30 days. Refreshing upstream access does not extend a local activation beyond its maximum lifetime.

The [operations runbook](docs/operations.md) covers encrypted backup/verification, restore into a fresh database, key rotation, upgrades, readiness and redacted diagnostics. The runtime image omits package managers: start and maintenance commands invoke compiled Node entry points directly. `npm run test:production` verifies a disposable PostgreSQL/TLS deployment, encrypted recovery and real Keycloak SSO. `npm run security:image` scans a local runtime image and generates its software bill of materials. See [security review and gates](docs/security-review.md) and [candidate preparation](docs/releasing.md).

## Check the build

```sh
npm run check
PYTHONPATH=sdks/python/src python3 -m unittest discover -s sdks/python/tests
```

Run the browser acceptance script against the local demo:

```sh
npx playwright install chromium
npm run dev
# In another terminal:
npm run test:browser
```

PostgreSQL integration checks run when `SMART_FLINT_TEST_DATABASE_URL` points to an isolated test database. The tests create SMART Flint tables; use a dedicated database. The CI workflow provides one. Swift example source has a separate typecheck path; Android source remains an illustrative adapter.

## Release boundaries

The gateway currently implements metadata, resource reads, version reads, and searches over JSON. Clinical writes, arbitrary FHIR operations, bulk export, multi-server grants, full FHIR-version conversion, FHIRcast synchronization, SMART Web Messaging, and an independently conformant downstream SMART authorization server remain future work. Native URL dispatch and secure storage require platform integration. Administrative sign-in selects standalone local username/password accounts or one configured OIDC provider, sharing explicit organization/application assignments. Local accounts support password changes and offline operator recovery; OIDC mode disables local password sign-in. Automatic identity-provider group synchronization, SCIM provisioning, SAML federation, and external secret-manager adapters remain future work.

This foundation needs deployment-specific security review and real vendor/customer validation before handling live clinical data. Contributions should include protocol fixtures and compatibility evidence for supported behavior.

## License

SMART Flint Community License v1.0, using the same community/commercial distribution model as EASI JS. This is source-available software. The community license covers eligible individual, research, nonprofit and qualifying business use; other use requires a separate commercial agreement. See [LICENSE](LICENSE) for the controlling terms and [licensing](docs/licensing/README.md) for scope and distribution notes. Third-party components retain their own licenses.
