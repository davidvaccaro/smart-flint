# Health Compass SMART Backend Services sample

A headless service that reviews a chosen patient or up to 20 authorized patients, using SMART Flint to negotiate upstream SMART Backend Services authorization. It shares the patient app's educational assessment logic. There is no user launch, user consent screen or implicit selected-patient context; authorization must already be granted to the backend registration.

## Run it locally

From the repository root with Node 24 or newer:

```sh
npm install
npm run dev
```

The full stack includes this service at `http://127.0.0.1:4102`. In a second terminal:

```sh
npm run demo -w @smart-flint/sample-fhir
npm run demo -w @smart-flint/sample-fhir -- --patient patient-a --route direct
```

The CLI prints only the assessed-patient count and operational issue codes. For the actual assessment response with fictional local records:

```sh
curl http://127.0.0.1:4102/assessments \
  -H 'Authorization: Bearer demo-health-service-client' \
  -H 'Content-Type: application/json' \
  --data '{"installationId":"inst_health_service_northstar","patientId":"patient-a","route":"gateway"}'
```

Omit `patientId` for the bounded Patient search. Change the installation to `inst_health_service_harbor`, `inst_health_service_lakeside` or `inst_health_service_cedar` for the other synthetic tenants. `patient-a` through `patient-d` demonstrate different available measurements and gaps. These are fictional local platforms, separate from real vendor conformance evidence.

To start just the sample against an already running stack:

```sh
npm run dev -w @smart-flint/sample-fhir
```

## Follow the code

[app.ts](src/app.ts) implements this operation:

1. Authenticate the caller with the sample service secret, validate the request, and check the installation allowlist.
2. Send `POST /api/service-activations` to SMART Flint with a server-side application API key. SMART Flint discovers the upstream token endpoint, signs its registered `private_key_jwt` assertion, and obtains authorized system access.
3. Create an SDK session and request a FHIR connection. The gateway returns an activation-specific FHIR URL and credential provider. `route: direct` returns the approved original FHIR server and a fresh upstream credential provider.
4. Use ordinary FHIR HTTP requests with that connection. Any FHIR library can consume the same base URL and authorization header. The sample SDK does not replace a FHIR client.
5. Read each Patient and their observations and call the shared health assessment engine. Report missing or inaccessible records; never substitute fabricated data.
6. Close that operation's activation in `finally`, including after failures. No token or result is stored by this sample. A cleanup failure is reported as an operational issue; configured activation expiry still applies.

Each invocation gets its own activation; simultaneous requests do not share patient state or credentials. Patient paging stops at two pages or 20 patients. Page links are restricted to the exact FHIR base and, for the gateway, the same activation's opaque continuation paths. Observation reads are also bounded. HTTP redirects are rejected. Read-only system access is sufficient.

The JSON response includes `schemaVersion`, `generatedAt`, `installationId`, `route`, `assessments` and `issues`. Assessments contain patient information for the authorized caller. They contain no OAuth token, SMART Flint session credential, refresh token or application API key. This service disables request logging; deployments should preserve that separation when adding tracing.

## Configure a real backend registration

Register a confidential asymmetric SMART backend client with the EHR and communicate the registration's public keys. Associate that registration, the correct tenant connection and a backend application in SMART Flint. Pre-authorize `system/Patient.rs system/Observation.rs` or the read/search scopes actually supported by that EHR. Configure the application API key in the SMART Flint secret store and on this service; it never belongs in a browser or mobile bundle.

The authorization model and registration requirements come from [SMART Backend Services](https://hl7.org/fhir/smart-app-launch/backend-services.html). This sample uses synchronous read/search FHIR; Bulk Data `$export` is a separate workflow.

| Variable | Local default | Deployment use |
| --- | --- | --- |
| `FHIR_SAMPLE_HOST` / `FHIR_SAMPLE_PORT` | `127.0.0.1` / `4102` | Listener settings, behind the deployment's TLS ingress. |
| `SAMPLE_SERVICE_TOKEN` | `demo-health-service-client` | Authenticates callers of this service. Production requires at least 32 characters. |
| `SMART_FLINT_APPLICATION_KEY` | `demo-health-service-key` | Backend application credential, matching SMART Flint's vault. Production requires at least 32 characters. |
| `SMART_FLINT_URL` | `http://127.0.0.1:3001` | Approved SMART Flint base URL; HTTPS in production. |
| `SAMPLE_INSTALLATION_IDS` | Four synthetic backend installations | Comma-separated installation allowlist. Required explicitly in production. |
| `FHIR_BASE_URLS` | Four synthetic FHIR bases | Exact comma-separated approved original bases for direct access; HTTPS in production. |
| `NODE_ENV` | Development | `production` disables demo secrets and HTTP upstreams. |

The local defaults require a loopback listener and loopback callers. Use independent secrets for caller authentication and the SMART Flint application. A deployment must secure access to the assessment response because it contains authorized patient data.

The sample's `start` command executes TypeScript source with its runtime `tsx` dependency; it does not use a compiled service distribution. Install dependencies from the repository root, retain the shared workspace source, set deployment configuration, and use `npm run start -w @smart-flint/sample-fhir`. These samples support development and integration validation; production operations and deployment validation remain the operator's responsibility.

For the CLI, `SAMPLE_SERVICE_URL` selects the deployed sample endpoint and `SAMPLE_SERVICE_TOKEN` supplies its caller secret. Options are `--installation`, `--patient` and `--route gateway|direct`. The CLI does not display patient data or scores, even when reviewing real records.

The health score is a transparent educational example, not a validated risk model or diagnosis. See [the assessment package](../../packages/health-assessment) for supported units, recency rules, data coverage and clinical limitations. Real Epic, Oracle Health/Cerner, MEDITECH and SMART Health IT compatibility requires separate registered-EHR tests.

## Verify

```sh
npx vitest run tests/sample-services.test.ts
npm run test:sample-stack
```

Unit tests cover authenticated caller boundaries, installation allowlists, gateway/direct reads, bounded pagination, independent concurrent credentials, and cleanup on success and failure. With the local stack running, `test:sample-stack` checks 48 signed-CDS and backend gateway/direct operations across all four patients and EHR configurations using real local protocol exchanges. Its cleanup verification reads the local demo admin dashboard and confirms that all recent backend sample activations are closed. To omit the admin check, run `node --import tsx tests/sample-stack.smoke.ts`. Console output contains only synthetic fixture labels and summary measurements.
