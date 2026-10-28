# Health Compass patient app

A separate React SMART application that turns real FHIR reads into an explainable patient health snapshot. It demonstrates a patient-facing standalone launch and an EHR-initiated launch through SMART Flint. It runs on its own origin; it does not rely on the management console's cookies or proxy configuration.

The score is a **custom, illustrative, unvalidated educational index**, not a diagnosis, a disease-risk estimate, or a clinical decision tool. Its four areas do not represent overall health. Missing, stale, and unsupported observations reduce coverage rather than count as healthy. Use synthetic records for sample validation.

## Current and Historical views

A successful SMART launch does not guarantee that the selected patient has recent observations the sample can interpret. The **Current** and **Historical** tabs let a patient inspect the connected record at two different points in time. Both use the same original observations, and both scores are illustrative and unvalidated. Historical is available for any connection with a safely interpretable dated record; it is disabled with an explanation when none is available.

On the first received snapshot, the app selects Historical automatically only when the Current score is unavailable and Historical has a numeric score. Any current urgent action keeps the initial view on Current. When the Current score is available, Current remains selected. A user's tab choice is preserved through record refreshes and gateway/direct route changes, until they disconnect or start a new activation. Current urgent guidance stays visible above the tabs even if the user manually inspects Historical.

Current coverage uses the present assessment date and never treats an old observation as current. When no current score can be calculated, the app shows how many observation records were read and a compact explanation for each health area: an older measurement with its original date, no usable record, or an unsupported format. Partial-read issues remain visible. Receiving many observations can still leave the four supported areas unavailable, because other observation types do not contribute to this sample's score.

Historical uses the latest safe, supported historical measurement date. Its banner shows the assessment date and patient age at that date, retains original measurement dates, and makes clear that it does not establish current health. Old results cannot generate present-day emergency instructions. Missing and unsupported areas remain unavailable; a single interpretable area still cannot produce a composite score, although the user can inspect that limited Historical view.

Switching tabs reuses the snapshot held in memory and makes no additional FHIR requests. The footer separates when the record was fetched from the date used for interpretation; displayed dates use UTC consistently with the engine's reference date. When a current score is unavailable, the app suggests discussing a health review and any appropriate measurements or tests with the care team. Missing records do not automatically mean that a patient needs more testing. The guidance links to [MedlinePlus: Health Checkup](https://medlineplus.gov/healthcheckup.html).

During authorization callbacks and EHR-launch bootstrap redirects, the app shows a branded loading screen until activation or navigation completes. It does not briefly show the connection form between redirects.

## Run locally

From the repository root:

```sh
npm install
npm run dev
```

Open **http://127.0.0.1:4100**. Use `127.0.0.1` consistently for this local setup. Select a connection, leave the SMART Flint gateway selected, and click **Connect my health record**. The synthetic EHR lets you select a fictional patient and approve read access.

The seeded app is `app_health_compass`, with the exact callback `http://127.0.0.1:4100/callback`. Its installations are `inst_health_northstar`, `inst_health_harbor`, `inst_health_lakeside`, and `inst_health_cedar`. These simulate two Epic tenants, an Oracle Health tenant, and a MEDITECH tenant. They are local protocol fixtures, not evidence of compatibility with those vendors.

The synthetic patients exercise different results:

| Patient | Scenario |
| --- | --- |
| `patient-a` | Results that merit review and current tobacco use |
| `patient-b` | Results within the sample reference ranges |
| `patient-c` | Missing and old observations, with limited coverage |
| `patient-d` | A recent very high blood-pressure observation and conditional urgent guidance |

FHIR reads need `patient/Patient.r` and `patient/Observation.rs`, plus a patient launch context. The sample requests no clinical write scopes. Your vendor's equivalent SMART v1 scopes may require a separate installation configuration.

To run just this frontend after the bridge and mock EHR are already running:

```sh
npm run dev --workspace @smart-flint/sample-patient
```

## EHR launch

For a synthetic Northstar EHR launch, open:

```text
http://127.0.0.1:4010/epic/northstar/ehr-launch?launch_url=http%3A%2F%2F127.0.0.1%3A3001%2Flaunch%2Finst_health_northstar&patient=patient-a
```

The EHR sends `iss` and its opaque `launch` value to the bridge's `/launch/inst_health_northstar` route. SMART Flint routes a short-lived bootstrap ticket to this app's callback. `resumeEHRLaunch()` binds that launch to this app's own PKCE and state transaction; `completeRedirect()` consumes the one-use activation code after authorization. The app never tries to interpret the EHR's launch handle.

## Code tour

| File | Responsibility |
| --- | --- |
| `src/smart-flint.ts` | Launch, resume EHR launch, redeem callback, obtain a FHIR connection, read a patient snapshot |
| `src/App.tsx` | Render score, coverage, prioritized suggestions, observation details, evidence, connection controls |
| `src/styles.css` | Responsive patient UI, with no external fonts or tracking resources |
| `../../packages/health-assessment` | Shared FHIR reader and assessment rules used by all three sample pathways |

The bridge SDK is an activation client, not a required FHIR client. The reader uses standard `fetch` against the supplied FHIR base URL and authorization provider:

```ts
const fhir = await session.getFHIRConnection({ route: 'gateway' });
const snapshot = await readPatientSnapshot({
  baseUrl: fhir.baseUrl,
  subjectBaseUrl: activation.upstream.baseUrl,
  getAuthorizationHeader: () => fhir.credentials.getAuthorizationHeader(),
  patientReference: activation.context.patient!.reference,
});
const assessment = assessHealth(snapshot);
```

Use the same base URL and credential provider with your preferred FHIR client instead. Obtain the authorization header when making a request so the bridge can manage upstream expiration. The sample bounds observation paging, rejects pagination outside the original FHIR endpoint, and shows partial-data notices when observation access fails.

The shared reader searches `vital-signs`, `laboratory`, and `social-history` separately, supplying the category required by Epic Observation searches while covering the sample's four assessment areas. It combines successful searches and removes duplicate observation IDs. If a category fails or paging is incomplete, the dashboard explains the incomplete read and offers a retry, including when the received records support a partial score. A failed read does not trigger the prompt about a health review or updated measurements; that prompt applies to successfully retrieved records without enough recent interpretable data.

## Gateway and direct access

Gateway mode keeps the original EHR token on SMART Flint. Direct mode uses the original FHIR endpoint with an authorization provider supplied by the SDK; SMART Flint continues to manage refresh. Switch modes from **Developer connection** after activation to compare them. Direct access needs token-export permission and CORS support from the EHR; a failed direct read is shown as an error, never replaced with fabricated sample results.

The SDK also exposes `session.credentials.original()` and explicit `session.credentials.handoff()`. This patient UI deliberately uses bridge-managed refresh in both its modes. A handoff transfers responsibility for refresh to the app and requires a different credential lifecycle; see the SDK documentation before adding it. No credentials are displayed in the developer inspector.

Session credentials and patient data are held only in memory. The SDK stores only its short-lived launch PKCE/state transaction in per-tab `sessionStorage`. Refreshing the page requires reconnecting. **Disconnect health record** closes the activation and clears the app's in-memory snapshot; it does not promise vendor-side OAuth revocation.

## Connect an external sandbox

1. Register and administer the app in the vendor's developer portal. Configure the bridge's OAuth callback and EHR launch URL as required by that vendor.
2. Add the real FHIR issuer, registration, tenant, and Health Compass installation to your own SMART Flint. Enable the necessary patient context and observation scopes. Do not reuse a synthetic registration.
3. Register this app's exact callback URI with SMART Flint, and allow its origin for bridge API access.
4. Start the sample with `VITE_SMART_FLINT_URL` pointing to your bridge and `VITE_INSTALLATION_ID` set to that installation, or select **Custom installation** in the launch form.
5. For EHR launch, configure the launcher to send `iss` and `launch` to the bridge installation's launch URL. For standalone launch, start from this app.

Outside loopback, use HTTPS for the bridge and app. Keep the issuer exactly aligned with the registered connection; simulator configuration may change the issuer URL. SMART Health IT and real Epic, Oracle Health, and MEDITECH sandboxes each need their own configuration and separately recorded validation. This sample does not claim those live environments have been tested.

## Verify

```sh
npm run build --workspace @smart-flint/sample-patient
node --import tsx tests/patient-sample.e2e.ts
npm run test:sample-history
```

The browser script uses only the local synthetic environment and requires all development services to be running. It checks actual authorization, FHIR reads, record coverage, connection modes, session cleanup, and responsive layout; it is not a clinical validation study.
