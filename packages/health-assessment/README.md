# Shared health snapshot

`@smart-flint/health-assessment` is the shared, framework-independent logic behind the patient SMART app, CDS Hooks sample, and backend FHIR service sample. Each pathway evaluates the same ordinary FHIR Patient and Observation resources. The four included patients are synthetic and explicitly tagged; they are never returned as a fallback for failed real requests.

The score is an **unvalidated educational demonstration**, not a diagnosis, clinical risk prediction, or comprehensive assessment of overall health. A clinician has not validated the points, equal weights, coverage rule, or freshness windows. A high sample score does not establish good health. Production use needs a clinically governed model, validation, appropriate regulatory review, and a fuller picture of the patient.

## Use with any FHIR connection

```ts
import { assessHealth, readPatientSnapshot } from '@smart-flint/health-assessment';

const connection = await session.getFHIRConnection({ route: 'gateway' });
const activation = await session.descriptor();
const snapshot = await readPatientSnapshot({
  baseUrl: connection.baseUrl,
  // The trusted activation supplies this namespace, never arbitrary user input.
  subjectBaseUrl: activation.upstream.baseUrl,
  patientReference: 'Patient/123',
  getAuthorizationHeader: () => connection.credentials.getAuthorizationHeader(),
});
const assessment = assessHealth(snapshot);
```

The reader uses standard HTTP FHIR reads and searches and does not require a particular FHIR client or SMART Flint SDK. An app can instead populate `PatientSnapshot` using its preferred client and pass it to `assessHealth`. For absolute observation subjects, set `snapshot.fhirBaseUrl` to the trusted resource namespace.

The optional `subjectBaseUrl` handles a gateway returning original upstream absolute Patient references. It affects namespace matching only; **all HTTP requests stay inside `baseUrl`**. A Patient response must match the requested logical id, and every observation must have a matching relative or approved absolute Patient subject. Same-id subjects from another host or FHIR base are excluded.

Observation searches use three separate standard categories: `vital-signs` for blood pressure and BMI, `laboratory` for A1C, and `social-history` for smoking status. This supplies the filter required by Epic and avoids an unfiltered request for the patient's entire observation history. These are ordinary [FHIR R4 search parameters](https://hl7.org/fhir/R4/observation.html#search), used with both gateway and direct access. The reader combines successful results, deduplicates observations with the same logical ID, and retains distinct resources without IDs. A failed category does not discard records received from the others.

When all three category searches finish without issues and return no LOINC `72166-2` observation, the reader makes one additional patient-filtered search with `code=http://loinc.org|72166-2`. This finds older smoking-status records categorized as `survey`. It uses the same paging, patient matching, credential renewal, response bounds, and deduplication as the category searches. A denied, incomplete, unsafe, or otherwise problematic category read suppresses this extra search. Any received `72166-2` observation also suppresses it, including one whose value is unknown or unsupported; the reader does not seek an older favorable replacement.

The reader obtains a bearer header immediately before each request. It rejects HTTP except explicit loopback development addresses, disallows redirects and cookies, requests no cache storage, limits each response to 5 MiB and 15 seconds, and follows at most five pages **per search** by default (`maxPages`, capped at 20 per search). Separate page budgets keep a large laboratory history from exhausting vital-sign or smoking searches. Supplied fetch implementations must honor the passed AbortSignal. Next links must remain in the exact approved origin and path subtree; gateway opaque page links work within that boundary. It reports page limits, denied observations, and partial results as `issues`; a failed Patient read throws a body-free `FHIRReadError`. It never logs response bodies or tokens. Apps should present the issues and avoid persisting patient payloads unnecessarily. A failed read is distinct from a successfully read record with missing or older measurements.

## Interpretation and score

All adult interpretation requires a complete, valid birth date confirming age 20 or older. Incomplete dates do not establish age. The newest final, amended, or corrected observation for each domain is used. Preliminary, cancelled, error, other-patient, future, undated, and partially dated observations are excluded. An unsupported newest observation is not replaced by an older favorable value. Missing, stale, unsupported, and unknown data get no points and do not count toward coverage.

| Domain | Accepted data | Sample freshness | Illustrative points |
| --- | --- | --- | --- |
| Blood pressure | LOINC `85354-9` or legacy `55284-4` with one `8480-6` and one `8462-4` component, `mm[Hg]` | 180 days | Normal 100; elevated 85; stage 1 or low reading 70; stage 2 45; severe 10 |
| A1C | LOINC `4548-4`, `17856-6`, or `59261-8`, `%` | 365 days | Below 5.7: 100; 5.7–under 6.5: 75; 6.5 or above: 45 |
| BMI | LOINC `39156-5`, `kg/m2` | 365 days | Under 18.5: 65; 18.5–under 25: 100; 25–under 30: 80; 30 or above: 60 |
| Smoking | LOINC `72166-2`, recognized SNOMED CT smoking status | 365 days | Current: 30; former or never: 100; unknown: no score |

The score is the rounded average of available domain points, with a minimum of two domains. Coverage is the percentage of the four domains that have recent interpretable data. For example, two normal domains produce 100 points with only 50% coverage; the display must keep both visible. Freshness windows represent this demonstration’s data-handling policy, not recommendations about which tests patients need or when they should be repeated. Combining a different set of available domains changes the meaning of comparisons between scores.

Quantities with comparison operators are excluded. Explicit UCUM codes are used without conversion; a wrong system or code cannot be rescued by a friendly unit label. Exact conventional unit strings are accepted when neither a unit system nor code is supplied. A1C in `mmol/mol` is deliberately unsupported. Separate systolic/diastolic observations, height/weight-derived BMI, narrative-only smoking history, and vendor-specific terminology mappings are extension points rather than guessed inputs.

Displayed numeric measurements use at most one decimal place without changing the source quantities. Category comparisons always use their original precision, including values close to a category boundary.

Actions are ordered urgent, high, medium, routine, then data follow-up. A severe BP record can produce urgent advice only when its timestamp establishes it was taken within 24 hours. Older or date-only readings prompt review without claiming a current emergency. Missing records prompt discussion about relevance, rather than automatic testing. Underweight BMI never produces a weight-loss recommendation. A1C interpretation does not infer a new diagnosis or a personal target for someone with known diabetes. Pregnancy, diagnoses, medications, and symptoms can materially change interpretation and are not modeled here.

## Historical educational view

Connected records can contain measurements from years before the current date; this is particularly common among public SMART Health IT synthetic patients. A successful launch and FHIR read can therefore correctly return an unscored current snapshot. The domain status and explanation distinguish old measurements, absent supported codes, unsupported values, and records excluded for their subject, status, or date. Receiving records is separate from having enough current interpretable measurements.

An app can provide a clearly dated historical educational view alongside its current view, for records from either a sandbox or a registered EHR:

```ts
import { assessHistoricalHealth } from '@smart-flint/health-assessment';

const historical = assessHistoricalHealth(snapshot); // Reuse the in-memory snapshot.
if (historical) {
  // Show a prominent historical mode/date label; this is not current health.
  console.log(historical.mode, historical.assessedAt, historical.score.value);
}
```

`assessHistoricalHealth(snapshot, { now? })` returns `HealthAssessment | null`. It chooses the latest valid, interpretable supported measurement within the received records, never a future, unrelated, other-patient, non-final, invalidly dated, or unsupported-unit record. An interval must have finished before the selected date. No record dates are changed and no fixture data is inserted. `now` is an optional bounded reference clock for deterministic tests; an invalid clock throws. Without a safe anchor the result is `null`, and fewer than two available domains still yields a null score.

Both assessment functions return `mode: 'current' | 'historical'`. `assessedAt` is the reference date; historical patient age and freshness are calculated at that date. Historical descriptions and titles are labeled as examples, without assuming the source is synthetic. Historical BP can never generate urgent priority, repeat-now instructions, or present-day emergency advice, even if its value is severe at the selected historical date. Current scoring and freshness limits remain in force. Apps should keep both views available and label the selected mode and date visibly. If a current score is unavailable, an app may initially select an available numeric historical view only when that would not hide a current urgent action. A null composite score does not rule out an urgent individual result. Old records must never be presented as current health. A bounded or incomplete source remains incomplete in the historical view.

An unavailable current score can prompt a conversation about appropriate care without prescribing more testing: “Ask your care team whether a health review, physical exam, updated measurements, or tests would be helpful for you.” Missing records alone do not establish that any examination or test is needed. [MedlinePlus from the US National Library of Medicine](https://www.medlineplus.gov/healthcheckup.html) describes checkups and preventive screening as depending on age, health, family history, and risks.

Legacy BP recognition follows [LOINC `55284-4`](https://loinc.org/55284-4/) and the [HL7 legacy BP example](https://www.hl7.org/fhir/2016Jan/observation-example-bloodpressure.xml.html). The code is a discouraged grouping term; the sample accepts it only when the separately coded systolic and diastolic numeric components and units are valid. It never parses a combined text value such as `120/80`. New data should use the current BP profile’s terminology.

## Sources and limits

Blood pressure categories and the repeat-reading/symptom-dependent escalation advice come from the [American Heart Association](https://www.heart.org/en/health-topics/high-blood-pressure/understanding-blood-pressure-readings). Lower readings require context, as discussed in its [low blood pressure guidance](https://www.heart.org/en/health-topics/high-blood-pressure/the-facts-about-high-blood-pressure/low-blood-pressure-when-blood-pressure-is-too-low).

A1C screening thresholds follow the [CDC](https://www.cdc.gov/diabetes/diabetes-testing/prediabetes-a1c-test.html). Diagnostic confirmation is explained by [NIDDK](https://www.niddk.nih.gov/health-information/diagnostic-tests/a1c-test). Existing diabetes and factors affecting A1C accuracy require clinician interpretation.

The [CDC adult BMI categories](https://www.cdc.gov/bmi/adult-calculator/bmi-categories.html) apply from age 20 and describe a screening measure, not a complete assessment. The sample does not model pregnancy, body composition, or clinical exceptions.

Smoking support links to the [CDC quitting guidance](https://www.cdc.gov/tobacco/about/how-to-quit.html). Recognized SNOMED codes are drawn from the [HL7 smoking status value set](https://www.hl7.org/fhir/us/core/STU3.1.1/ValueSet-us-core-observation-smokingstatus.html). `77176002` (smoker, current status unknown) and `266927001` (unknown if ever smoked) remain unknown. This domain describes recorded smoking, not every tobacco or nicotine exposure.

These organizations support the linked interpretation guidance; they do not endorse the sample score or its points. The sample makes no medication decisions or individualized activity prescriptions. Clinical codes, supported units, thresholds, freshness, scoring, and actions live together in `src/assessment.ts` for review.

## Synthetic scenarios and checks

`createHealthFixture(id, { asOf })` returns deterministic relative dates around a supplied assessment time:

| Patient id | Scenario |
| --- | --- |
| `patient-a` | Improving but elevated BP and A1C, current smoking, BMI review |
| `patient-b` | Four recent measurements in the sample’s favorable ranges |
| `patient-c` | Stale measurements, absent A1C, unknown smoking status |
| `patient-d` | Recent severe BP, A1C review, BMI review, former smoking |

Run `npx vitest run tests/health-assessment.test.ts` from the repository root. The tests exercise thresholds, age and date precision, incomplete data, unit and status rejection, urgency ordering, patient isolation, gateway paging, bearer destination boundaries, denied access, response-size bounds, and timeout behavior.
