# Synthetic EHR protocol simulator

Run from the repository root with `npm run dev -w @smart-flint/mock-ehr`.

The simulator serves three isolated fictional installations:

| Adapter label | Organization | FHIR base |
| --- | --- | --- |
| Epic | Northstar Health | `http://127.0.0.1:4010/epic/northstar/r4` |
| Epic | Harbor Medical | `http://127.0.0.1:4010/epic/harbor/r4` |
| Oracle | Lakeside Care | `http://127.0.0.1:4010/oracle/lakeside/r4` |

These labels exercise vendor-profile selection. This local fixture is **not** an Epic, Oracle, or MEDITECH sandbox and does not establish compatibility with their products. Every record is synthetic. Do not submit actual clinical data or credentials.

The fixture implements discovery, an interactive consent page, S256 authorization codes, signed OIDC identity tokens, rotating refresh tokens, backend client assertions, FHIR reads/searches, and opaque pagination links. Codes and tokens are kept in memory and disappear on restart. Interactive client ID: `smart-flint-demo`. Backend client ID: `smart-flint-service`; private-key assertions are verified against the bridge's pinned `/.well-known/jwks.json` endpoint. A fixed synthetic backend secret is also accepted for testing symmetric client authentication.

Start an EHR launch at `/epic/northstar/ehr-launch`, `/epic/harbor/ehr-launch`, or `/oracle/lakeside/ehr-launch`. Each defaults to the corresponding seeded bridge installation. `?patient=patient-b` selects the second synthetic patient. The `launch_url` option accepts only trusted bridge launch routes.

Supported search parameters are `patient`, `subject`, `_id`, `_count`, `_offset`, `code`, and `category`. Unsupported parameters produce an `OperationOutcome`. `_count=1` demonstrates pagination. Tokens are tenant-bound, and patient scopes restrict resources to the selected context. `Patient/patient-a` intentionally exists in multiple tenants to exercise namespace isolation.

Environment options: `MOCK_EHR_PORT`, `MOCK_EHR_HOST`, `MOCK_EHR_URL`, `BASE_URL`, `CONSOLE_URL`, and `SMART_FLINT_JWKS_URL`. Default listening address is loopback. CORS permits only the configured console and bridge origins.
