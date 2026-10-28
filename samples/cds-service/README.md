# Health Compass CDS Hooks sample

A working `patient-view` handler that turns a patient's real prefetched FHIR measurements into up to four health review cards. It uses the same [assessment package](../../packages/health-assessment) as the patient app and the backend sample. The health score is an educational, unvalidated illustration. Missing records never count as healthy measurements.

## Run the complete local flow

From the repository root, using Node 24 or newer:

```sh
npm install
npm run dev
```

This starts SMART Flint, the console, synthetic EHR, patient app, this handler on `http://127.0.0.1:4101`, and the backend sample. Keep that terminal open. In a second terminal:

```sh
curl http://127.0.0.1:4010/epic/northstar/cds-hooks/health-review \
  -H 'Content-Type: application/json' \
  --data '{"patientId":"patient-a"}'
```

That request makes the synthetic EHR sign a short-lived caller JWT and send matching Patient/Observation prefetch to SMART Flint. SMART Flint verifies the caller, invokes this authenticated handler, and returns its actual cards. The transport is real; all local EHR identities and records are fictional.

Change the path to `epic/harbor`, `oracle/lakeside`, or `meditech/cedar` to exercise the other configured tenants. Use `patient-a`, `patient-b`, `patient-c` or `patient-d` to explore different records. Those profiles simulate separate tenants and issuers; they do not certify compatibility with the named vendors.

```sh
curl http://127.0.0.1:3001/cds-services
curl http://127.0.0.1:4101/health
```

To run only this sample while the other services are already running:

```sh
npm run dev -w @smart-flint/sample-cds
```

## Follow the code

1. [app.ts](src/app.ts) authenticates the request from SMART Flint before processing hook input.
2. It checks `context.patientId`, requires the prefetched Patient to match, and excludes observations with another or missing patient reference. Absolute patient references require an explicit approved `fhirServer`; it never guesses a tenant namespace.
3. It uses the `patient` and `observations` prefetch keys; missing records produce an informational card. It does not invent a Patient, measurements or a reassuring score.
4. If prefetch is unavailable, it can read the matching Patient and observations with that invocation's `fhirAuthorization` token. The server must exactly match `FHIR_BASE_URLS`; pagination stays within that FHIR base. Redirects are rejected. The token is neither stored nor reused for a SMART launch.
5. The shared engine calculates supported domains and actions. Urgent actions become `critical` cards, high priority becomes `warning`, and the rest become `info`. Card details include retrieval and interpretation notices, so 100% measurement-domain coverage does not hide a truncated or incomplete record set.

This handler has no database and disables request logging. It neither changes the EHR record nor writes clinical orders.

## Configure an actual EHR

Register and enable the hook with the EHR, then configure a SMART Flint CDS service with the correct installation, caller issuer, caller JWKS URL and handler secret. EHR-facing discovery and invocation use SMART Flint `/cds-services` and `/cds-services/{serviceId}`. The private handler is `POST /hooks/health-review`.

Configure these discovery prefetch templates in SMART Flint:

```json
{
  "patient": "Patient/{{context.patientId}}",
  "observations": "Observation?patient={{context.patientId}}&_count=100"
}
```

Set configuration on the handler process:

| Variable | Local default | Deployment use |
| --- | --- | --- |
| `CDS_SAMPLE_HOST` / `CDS_SAMPLE_PORT` | `127.0.0.1` / `4101` | Listener settings; put behind the deployment's TLS ingress. |
| `CDS_HANDLER_TOKEN` | `demo-health-cds-handler` | Match the secret in SMART Flint's CDS handler configuration. Production requires a unique secret of at least 32 characters. |
| `FHIR_BASE_URLS` | Four pinned synthetic FHIR bases | Comma-separated exact approved FHIR bases. HTTPS required in production. Needed for any FHIR-token fallback. |
| `SMART_APP_LAUNCH_URL` | Unset | Optional registered SMART launch URL. Used exactly as configured in a `type: smart` card link. |
| `NODE_ENV` | Development | Set to `production` to disable demo credentials and loopback HTTP upstreams. |

Default credentials work only on a loopback listener and for loopback callers. In production, give SMART Flint an HTTPS handler URL and explicitly allow that origin in its CDS service configuration. Configure `FHIR_BASE_URLS` even when prefetch normally supplies records, so any supplied `fhirServer` can be checked against the intended EHR.

The handler secret authenticates SMART Flint to this service. SMART Flint separately verifies the EHR's signed caller JWT. They are different trust relationships.

This sample process accepts one `CDS_HANDLER_TOKEN`. The admin API creates a separate handler secret for each CDS binding; run a separately configured handler instance for each such binding and set its token to the returned secret. The synthetic seed deliberately uses one shared local demonstration token across its four bindings.

The sample's `start` command runs TypeScript source with its runtime `tsx` dependency; it does not run a compiled service distribution. Install dependencies from the repository root (including the shared workspace source), configure the deployment environment, then run `npm run start -w @smart-flint/sample-cds`. These examples provide development and integration validation; production deployment still requires the operator's infrastructure, access controls and validation.

An optional SMART link sends only `{"intent":"review-health"}` as `appContext`. EHR support and propagation into launch context require deployment-specific configuration and validation; displaying the link does not establish a user session. The patient app performs a separate normal SMART launch.

The relevant wire format and SMART links are specified in [CDS Hooks 2.0](https://cds-hooks.hl7.org/2.0/). Real Epic, Oracle Health/Cerner, MEDITECH and SMART Health IT deployments still need actual registration and end-to-end validation; local simulation is separate evidence.

## Verify

```sh
npx vitest run tests/sample-services.test.ts
npm run test:sample-stack
```

The unit tests cover handler authentication, patient matching, gaps, transient token protection and unapproved FHIR URLs. With the local stack running, `test:sample-stack` checks all four synthetic patients across all four EHR configurations through signed CDS and backend gateway/direct access: 48 operations. The script's cleanup check reads the local demo admin dashboard and confirms no sample backend activation remains open. To run without that admin check, use `node --import tsx tests/sample-stack.smoke.ts`.
