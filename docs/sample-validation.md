# Sample validation evidence

Local verification performed on October 24, 2026. These results describe the repository's synthetic protocol fixtures, not real Epic, Oracle Health or MEDITECH environments.

## Executed local matrix

| Configuration | Patient SMART app | Signed CDS → Bridge → handler | Backend gateway | Backend direct |
| --- | --- | --- | --- | --- |
| Northstar / Epic label | Browser-verified | 4 scenarios passed | 4 scenarios passed | 4 scenarios passed |
| Harbor / Epic label | Browser-verified | 4 scenarios passed | 4 scenarios passed | 4 scenarios passed |
| Lakeside / Oracle Health label | Browser-verified | 4 scenarios passed | 4 scenarios passed | 4 scenarios passed |
| Cedar / MEDITECH label | Browser-verified | 4 scenarios passed | 4 scenarios passed | 4 scenarios passed |

The service matrix comprises 48 operations: four configurations × four patients × three execution routes. The browser suite also checks standalone and EHR bootstrap, independent app origin, gateway/direct reads, record-access denial, missing/stale records, urgent guidance, mobile layout and disconnect. Backend cleanup checks confirmed that assessment operations closed their own bridge activations.

Clinical parser tests check age/date eligibility, status and patient matching, unit/comparator handling, source namespaces, missing/stale/future values, priority ordering, old versus recent very-high BP, and smoking codes. Reader tests check bounded paging, response size, timeouts and credential isolation. Scores are sample behavior, not clinical validation.

## Reproduce

Install dependencies with `npm install` and the browser with `npx playwright install chromium` first.

```sh
npm run dev
# In a second terminal:
npm run check
npm run test:samples
npm run test:sample-history
npm run test:sample-stack
```

Tests require only synthetic local configuration. The smoke script refuses a non-synthetic EHR. Credentials and raw health records are not part of its output. Configuration templates and source examples are in [samples](../samples/README.md).

## External evidence

| Environment | Status |
| --- | --- |
| Public SMART Health IT launcher | Patient Portal / R4 EHR launch browser-verified again on October 27, 2026 after workspace migration: authorization, patient context, gateway reads, historical assessment and disconnect. |
| Epic public sandbox | Operator-reported patient EHR launches; published MyChart test-account standalone authorization and all three category-filtered Observation searches browser-verified on October 27, 2026 after workspace migration. Olivia Roberts remains a separate authorization exception below. |
| Oracle Health/Cerner sandbox | Requires authorized registration, environment access and execution evidence |
| MEDITECH sandbox | Requires authorized registration, environment access and execution evidence |

Record the actual server/version, launch mode, registration type, scope grant, required context, response behavior and test date when adding external evidence. Do not infer one customer's capabilities from another customer's result or from its vendor label.

## Historical public sandbox records

Read-only inspection of the screenshot's synthetic patient found 297 final observations over three pages, with measurements from 2011 through February 24, 2021. The reader received all pages without errors. The record includes the legacy LOINC `55284-4` blood-pressure panel with standard systolic/diastolic components, BMI and smoking observations; no supported A1C observation was present. Staleness and the previously unsupported BP panel account for the initial unscored result.

The historical view evaluates actual records at their latest supported measurement date and labels that date and the patient's age then. Data dates, proxy responses and clinical freshness limits are unchanged. Historical interpretation never turns an old blood-pressure observation into a present-day emergency instruction.

An actual public-launcher browser check then used the existing operator-configured public PKCE registration and Health Compass installation. It selected the screenshot's synthetic patient (`6b223f89-e726-44da-81ad-03d30fc61254`), Patient Portal / R4, top-level launch, and the launcher's **Skip login screen** and **Skip authorization screen** test options. With normal browser networking, the full flow returned the patient through SMART Flint's gateway. The current view reported three older domains and one unavailable domain. Explicit historical preview returned **83/100 with 75% coverage as of February 24, 2021**, with age at that date and missing A1C retained. Desktop/mobile screenshots were inspected; returning to current view and closing that test activation succeeded. This validates the tested public sandbox path, not interactive identity authentication, every launch mode, or a vendor/customer EHR implementation. The user separately reported an interactive launch success earlier that day. Public network availability is not a CI prerequisite.

## October 25 patient presentation update

Current and Historical tabs replace the preview/return controls. The first received snapshot selects Historical automatically only if Current has no composite score, Historical has a numeric score and Current has no urgent action. A care-team review prompt explains the lack of recent information without asserting that absent records require a physical exam or new tests. Manual selection persists across refreshes and gateway/direct route changes. Historical interpretation is available for any connection with usable records, rather than being restricted by a sandbox hostname. Current urgent guidance remains visible in either tab.

`test:sample-history` verifies automatic selection, manual selection and refresh persistence, keyboard/mobile controls, empty records, generic EHR records, UTC date boundaries and urgent guidance despite an unavailable current composite. It also observes both EHR callback documents to ensure the patient welcome screen or management console never appears during bootstrap or activation. Those visits show a neutral patient loading state while preserving the existing PKCE and browser binding.

Verification completed on October 25: 149 automated tests passed (three PostgreSQL checks skipped in this local run), production builds passed, and both patient browser suites passed. The public SMART Health IT Patient Portal / R4 flow was repeated with the same synthetic patient and existing registration: Historical opened automatically at 83/100 and 75% coverage, Current remained selectable, the care-review prompt appeared, and both callback documents showed neutral loading without the welcome or management page. The test activation was closed. Mobile DOM checks confirmed a single header and dashboard with no horizontal overflow; separate viewport captures were used because full-page Chrome captures could repeat viewport tiles.

## Local HTTPS preparation for Epic

The operator reported that Epic's registration save validation requires HTTPS, even though its scheme selector offers HTTP. The local development profile now terminates TLS on loopback `https://127.0.0.1:3443` and keeps its canonical launch/callback origin aligned with the bridge and samples. No public tunnel or vendor registration change was performed.

On October 25, the full verification run passed 159 automated tests, with the same three PostgreSQL checks skipped, and production builds passed. A live synthetic SMART launch over HTTPS passed with explicit CA and hostname verification, both PKCE exchanges, a Secure OAuth binding cookie, patient context and a FHIR gateway read. The test grant was closed. The HTTPS proxy checks include forwarded headers, bounded bodies, timeouts, failures, certificate validation and local-only guards. These checks do not disable TLS verification or change macOS trust.

After the operator explicitly approved certificate trust, the verified project development CA was added to the user's macOS login keychain with SSL trust only. macOS server-certificate verification succeeded for `127.0.0.1`. A fresh Chrome process accepted `https://127.0.0.1:3443/health` without certificate exceptions or verification bypass, then completed a synthetic patient-app launch, displayed the expected current assessment, read FHIR through the HTTPS gateway and closed its test session. An authenticated Epic sandbox launch remains pending registration completion and execution evidence.

## October 27 Epic Observation search correction

The operator reported a successful patient SMART launch from Epic into Health Compass. The supplied screenshot showed a connected patient and an Observation `OperationOutcome` with diagnostic `Must have either code or category.` This establishes operator-reported launch success; it does not establish successful observation retrieval or a complete assessment.

The shared reader now searches three standard categories separately: `vital-signs`, `laboratory`, and `social-history`. Each category has its own bounded paging budget. Successful results survive another category's failure, duplicate Observation logical IDs are removed, and patient-subject, namespace, credential and transport checks remain in effect. Local health fixtures now include the categories so their searches exercise the same filtering behavior.

The patient UI distinguishes incomplete reads from successfully received records with missing or stale measurements. It offers retry/access-support guidance, preserves a valid partial assessment, and suppresses the health-review prompt when retrieval is incomplete.

Verification: type checks and production builds passed; 166 automated tests passed with three PostgreSQL checks skipped. Reader regressions reproduce a server rejecting unfiltered searches, cover each category's independent denial, deduplication, renewable credentials and safe pagination. The patient browser suite passed all four local synthetic connections, gateway/direct reads, EHR launch, urgent guidance, all-category denial with successful retry, and laboratory-only denial with a retained three-domain score. The historical browser suite passed selection, refresh persistence, keyboard/mobile controls, dates, empty records, urgent guidance and neutral callbacks. Browser TLS validation stayed enabled; Node's intercepted test requests explicitly trusted the existing development CA. The live Epic request after this fix still requires an operator retry; no Epic token or activation was reused for these synthetic checks.

### Epic follow-up and authorization diagnostics

Later on October 27, the operator confirmed the category correction worked well, while reporting one sandbox patient that failed to launch. Local audit evidence showed several successful activations and two recent Epic authorization denials before token exchange. The original generic denial events did not retain the upstream OAuth error code, so they do not establish a patient-specific cause or prove expiry of the original attempt. The pasted launch handle was not replayed.

Authorization denials now record allowlisted OAuth error codes; unknown strings and all upstream error descriptions/URLs remain excluded. Initial issuer/launch-handle rejections are also audited without recording their submitted values. Type checks and production builds passed, with 169 automated tests passing and three PostgreSQL checks skipped. Regressions verify standard error diagnostics, unknown-value redaction, unchanged downstream error/state handling, transaction consumption, and no token exchange after an authorization error. A fresh operator launch is needed to identify the specific Epic rejection.

The operator subsequently captured `error=invalid_grant` with the description `Failed to redeem a launch token for an authorization code`. This establishes rejection at Epic's authorization endpoint, before SMART Flint can exchange an authorization code or read FHIR. The earlier narrow authorization-error allowlist incorrectly reduced this code to `unrecognized_error`. It now retains `invalid_grant` and the separately documented `invalid_launch_token`, with specific fixed SDK messages and no upstream-description forwarding. A synthetic regression confirms that the opaque EHR launch handle, including encoded punctuation, reaches the authorization request unchanged and exactly once; the configured client ID, audience, launch scope and callback state remain correct.

The operator also supplied a successful run of Epic's default SMART on FHIR test app. Its Practitioner identity and `user/...` scopes demonstrate clinician authorization. Epic's LaunchPad implementation selects clinician context for its default test app and MyChart context for a patient registration; the operator subsequently noticed that changing apps also changes the available patient/user selection. That screenshot is not a controlled comparison of the same patient-facing workflow. The current grant error is not evidence that record age, PKCE, or Observation searches caused this failure.

Type checks and production builds passed, with 176 automated tests passing and three PostgreSQL checks skipped after the grant-error handling and opaque-forwarding regressions.

The complete patient browser suite also passed against the restarted HTTPS stack. Its new regression changes only a synthetic consent redirect to return `invalid_grant`, then exercises the real bridge callback, cookies, state validation and SDK error handling. It confirms that the specific fixed error message is displayed, an arbitrary upstream description is withheld, no patient results appear, callback parameters are cleared and the launch transaction is consumed. Normal browser TLS validation remains enabled. No operator Epic token was replayed.

### Olivia Roberts sandbox exception

On October 27, the operator confirmed that the patient-facing launch succeeds for the other listed MyChart users and consistently fails for Olivia Roberts. Local events for the same installation at 11:03:01 America/New_York show Epic rejecting launch-token redemption with `invalid_grant`, before token exchange or FHIR reads; another launch reached `activation.ready` at 11:03:24. The patient's displayed age and measurement dates are not evaluated at the failed stage.

[Epic's published sandbox test data](https://fhir.epic.com/Documentation?docId=testpatients), checked that day, lists MyChart credentials for Camila Lopez, Derrick Lin and Desiree Powell, but none for Olivia Roberts. The LaunchPad still offers Olivia in its MyChart-user selector. This discrepancy supports tracking an Olivia-specific sandbox authorization case; it does not prove that her account is inactive or establish the underlying Epic rejection. An Olivia-specific standalone test requires credentials supplied by Epic; do not infer or guess them.

Continue patient-facing validation with the documented MyChart accounts. If escalating to Epic, include the patient name, patient-facing launch mode, `invalid_grant` / `Failed to redeem a launch token for an authorization code`, and that the other MyChart users succeed with the same registration. Keep launch tokens, callback state, access tokens and full authorization URLs out of the report. Account/context diagnosis remains open pending Epic confirmation.

## Application-first workspace migration — October 27, 2026

The workspace now provides Applications, EHR Platforms, Organizations, Installations and Activations as linked administrative views. Vendor app registrations group OAuth client profiles; organization connections retain their approved FHIR bases and issuer checks. A database backup was taken before the additive migration. Migration of a copy and a second migration verified preservation and repeatability before the live registry was accepted.

After runtime verification, a comparison with the backup confirmed that all original configuration fields were retained for seven organizations, four applications, six connections, five OAuth clients, fourteen installations and five CDS services. Connection discovery metadata was allowed to refresh. All 56 pre-existing encrypted credential records remained byte-for-byte unchanged. Registered launch/callback URLs, client IDs, scopes and access policies were preserved; vendor portal edits were not needed.

Validation passed:

- Type checks, production builds and **187 automated tests**; three PostgreSQL tests were skipped because no test database was configured. The Python SDK's nine tests also passed.
- The isolated workspace browser suite: application-first navigation, inline application/registration/client/organization/connection onboarding, persisted bindings and worksheet URLs, shared registration editing, launch failures without activations, and mobile navigation. It uses an in-memory registry and does not modify the saved sandbox configurations. This suite is included in CI.
- The reference-app console browser suite: standalone/EHR bootstrap, gateway/direct/handoff access, backend and CDS workflows.
- The patient and historical browser suites: four local synthetic connections, gateway/direct access, current/historical assessments, incomplete/denied reads, invalid grants, urgent guidance, mobile controls, disconnect, and callbacks without a console-page flash.
- The **48-operation** CDS/backend sample matrix, with zero failures, and the local HTTPS smoke check with trusted TLS, Secure cookies, PKCE, context and FHIR access. All 44 synthetic activations created by these runtime suites were closed; pre-existing open sessions were preserved.

### Live public sandbox checks after migration

The saved SMART Health IT installation completed a fresh **Patient Portal / R4 EHR launch** through the public launcher, using its published synthetic Lea record and the skip-login/skip-authorization test options. The three category queries succeeded. The historical view automatically selected February 24, 2021 and returned **83/100 with 75% coverage**, preserving the unavailable A1C domain. The test activation was disconnected and closed. Normal browser TLS verification remained enabled.

That check exposed a compatibility gap in the category-only reader: older smoking-status observations can be categorized as `survey`. After all three category searches complete without an issue, the reader now makes a single bounded, patient-scoped search for `http://loinc.org|72166-2` if no such observation was received. Paging, patient matching, credential renewal and deduplication still apply. A received unknown/unsupported smoking result or any retrieval issue suppresses this extra lookup. Regression tests cover recovery and these limits; no unfiltered search or scoring-rule change was introduced. The fresh public-launcher run confirmed the targeted search succeeded and restored the expected historical assessment.

The saved Epic installation completed a fresh **patient standalone launch** with Epic's published synthetic Camila MyChart account, interactive login and consent. It returned to Health Compass through the existing HTTPS callback and gateway. Vital-sign, laboratory and social-history searches all returned HTTP 200, with 256 Observation records received. The sample retained its insufficient-current-data result for that old/unsupported record content. The test activation was disconnected and closed. This directly verifies standalone authorization and data access after migration; the authenticated Open Epic EHR LaunchPad path was not rerun during this check. The operator's earlier successful EHR launches and the unresolved Olivia-specific `invalid_grant` case remain distinct evidence.

Desktop screenshots were inspected for the new workspace and both public-sandbox results; mobile workspace views were also checked for overflow and browser errors. The local stack remains available at console port 3010 and the existing trusted HTTPS bridge port 3443.
