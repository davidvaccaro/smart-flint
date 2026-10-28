# Health Compass developer samples

Three independent applications exercise SMART Flint with the same explainable health-review logic:

| Sample | Pathway | Start here |
| --- | --- | --- |
| [Patient app](patient-app/README.md) | Patient-facing EHR/portal and standalone SMART launch | `patient-app/src/smart-flint.ts` |
| [CDS handler](cds-service/README.md) | Synchronous `patient-view`, prefetch, optional request-bound FHIR access | `cds-service/src/app.ts` |
| [FHIR service](fhir-service/README.md) | Headless SMART Backend Services with system scopes | `fhir-service/src/app.ts` |

The shared [assessment package](../packages/health-assessment/README.md) reads standard FHIR Patient and Observation resources. It provides an **unvalidated educational composite**, record coverage, dated source measurements and explained actions. The custom points, weighting, minimum data requirements and freshness windows demonstrate application logic; they are not a clinical risk model or recommended testing schedule. Clinical categories are linked to primary guidance. Missing records never count as healthy results.

## Start the full local environment

```sh
npm install
npm run dev
```

| Component | URL |
| --- | --- |
| SMART Flint console → Sample library | http://127.0.0.1:3010/#samples |
| Health Compass patient app | http://127.0.0.1:4100 |
| Private CDS handler metadata | http://127.0.0.1:4101 |
| Backend FHIR service metadata | http://127.0.0.1:4102 |

`npm run dev:core` starts only SMART Flint, the console and the synthetic EHR. Each sample has its own workspace `dev` command; the two backend samples also provide `start`. Build the patient frontend with its workspace `build` command for static hosting. Use `127.0.0.1` consistently because callbacks and browser origins match exactly. Ports fail clearly when occupied; no unrelated development servers are stopped.

In local demo mode SMART Flint provisions sample applications, a patient-facing public registration, backend installations and CDS caller trust. These records are ordinary registry configuration visible in the console. Production mode does not provision them. Local development credentials are fixed synthetic fixtures; set unique server-held credentials when adapting a sample to a real deployment.

## Patient SMART application

Open the patient app and choose an installation and gateway/direct route. The app launches from its own origin, establishes its PKCE transaction, obtains the normalized activation, and then configures an ordinary FHIR HTTP reader. It keeps credentials and clinical data in memory.

The app has **Current** and **Historical** assessment tabs. If current information cannot produce a score, a usable historical assessment opens automatically with its reference date, age at that date and an explanation about updating the record with the care team. Current urgent guidance always remains visible. A manual tab choice survives refreshes and route changes, and switching tabs makes no extra FHIR requests. These views work with any configured EHR connection; source dates and current freshness rules remain intact. See the [patient sample guide](patient-app/README.md).

For an EHR-initiated test, open:

```text
http://127.0.0.1:4010/epic/northstar/ehr-launch?patient=patient-a&launch_url=http%3A%2F%2F127.0.0.1%3A3001%2Flaunch%2Finst_health_northstar
```

The fixture opens the registered SMART Flint launch destination. SMART Flint sends a bootstrap ticket to the separate app, the SDK establishes the app's transaction, authorization completes, and the app receives its activation. The patient-facing fixture uses `fhirUser=Patient/...`; the earlier clinician reference client continues to use a Practitioner principal. Patient context alone must not be used to infer the logged-in person's identity in real integrations.

## Synthetic scenarios

| Patient | Scenario | Intended checks |
| --- | --- | --- |
| `patient-a` · Maya Morgan | Follow-up opportunities with current smoking, BP, A1C and BMI records | Explained prioritization, latest readings, source links |
| `patient-b` · Noah River | Healthy-range available records | Maintenance actions without a guarantee of health |
| `patient-c` · Jamie Chen | Old and missing records | Coverage gaps and no invented score |
| `patient-d` · Sam Taylor | Very high recent BP | Prominent repeat-reading/symptom guidance before routine actions |

Each synthetic organization has its own resource namespace. Identical patient IDs across connections do not establish a shared identity. Fixtures are labeled with vendor names only to exercise routing and configuration; they are not actual vendor products or evidence of compatibility.

## CDS Hooks exchange

```sh
curl http://127.0.0.1:4010/epic/northstar/cds-hooks/health-review \
  -H 'Content-Type: application/json' \
  --data '{"patientId":"patient-a"}'
```

This invokes a full synthetic EHR → SMART Flint → private handler exchange. The EHR signs a short-lived caller JWT and provides Patient/Observation prefetch. SMART Flint verifies the configured caller, audience and replay binding, then forwards the request using the handler's separate credential. The handler returns prioritized cards. It never turns an invocation's FHIR token into a later browser session.

Discovery is published by SMART Flint at `/cds-services`, including the health-review prefetch templates. The private handler is not the EHR-facing URL. Optional SMART card links require a registered launch target and support in the CDS client; they start a separate authorization flow.

## Headless FHIR service

```sh
curl http://127.0.0.1:4102/assessments \
  -H 'Authorization: Bearer demo-health-service-client' \
  -H 'Content-Type: application/json' \
  --data '{"installationId":"inst_health_service_northstar","route":"gateway"}'
```

Use `"route":"direct"` to bypass the gateway, or add `"patientId":"patient-b"` for one explicit patient. The backend's application key stays on that server. SMART Flint signs the upstream asymmetric authentication assertion and grants system access. The sample bounds patient/observation reads, returns assessment JSON and closes its isolated activation even when a read fails. There is no implied end-user or launch patient in a system grant.

## Verify the samples

Install the browser once with `npx playwright install chromium` before running browser acceptance checks.

```sh
npm run check
# With npm run dev running in another terminal:
npm run test:samples
npm run test:sample-history
npm run test:sample-stack
```

The browser test uses normal networking and exercises the separate app across all four local connections, EHR bootstrap, direct/gateway access, clinical-data gaps and responsive layout. The stack smoke test uses signed CDS calls and backend gateway/direct requests across four patients and four connections. It rejects a non-synthetic EHR and can confirm that backend activations were closed. It prints synthetic summary results rather than raw records or credentials. See [validation evidence](../docs/sample-validation.md).

## Use a different EHR environment

1. Add the application's exact callback URL, required context and scopes to SMART Flint.
2. Add the organization and approved FHIR connection. Record the upstream registration obtained through the vendor's process.
3. Create an installation and export its registration worksheet. Configure the EHR/portal to open the worksheet's SMART Flint launch URL; its upstream OAuth callback also belongs to SMART Flint.
4. Point the sample app at the installation using its connection input or `VITE_INSTALLATION_ID`. Configure `VITE_SMART_FLINT_URL` when using a different bridge.
5. Verify patient identity/context, actual granted scopes, dates/units, access denial, refresh and both access routes with authorized sandbox records.

The [environment templates](profiles/README.md) cover the public SMART Health IT launcher and vendor configuration. Exact issuer matching, approved origins and HTTPS protections remain enabled. The public launcher can encode its settings in the FHIR base URL; copy the actual generated issuer. Start in a top-level/new window. Local HTTP launch URLs may require HTTPS alignment for the public launcher's generated issuer; do not disable the bridge's external HTTPS check.

Actual vendor launch testing needs accounts, registration, customer enablement and test data. No vendor certification or public-launcher end-to-end compatibility is claimed by the local matrix.
