import { afterEach, describe, expect, it, vi } from 'vitest';
import { assessHealth, assessHistoricalHealth, createHealthFixture, FHIRReadError, readPatientSnapshot, type DomainId, type FhirObservation, type PatientSnapshot } from '../packages/health-assessment/src/index.js';

const asOf = '2026-10-24T16:00:00.000Z';
const DAY = 86_400_000;
const baseUrl = 'https://ehr.example/fhir';
const healthy = () => createHealthFixture('patient-b', { asOf });
const result = (snapshot: PatientSnapshot, id: DomainId) => assessHealth(snapshot, { asOf }).domains.find(domain => domain.id === id)!;
const observation = (snapshot: PatientSnapshot, code: string) => snapshot.observations.find(item => item.code?.coding?.some(coding => coding.code === code))!;
const bp = (systolic: number, diastolic: number, daysAgo = 0.01) => {
  const snapshot = healthy();
  const record = observation(snapshot, '85354-9');
  record.component![0]!.valueQuantity!.value = systolic;
  record.component![1]!.valueQuantity!.value = diastolic;
  record.effectiveDateTime = new Date(Date.parse(asOf) - daysAgo * DAY).toISOString();
  return snapshot;
};
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/fhir+json' } });
const bundle = (records: FhirObservation[] = [], next?: string) => ({ resourceType: 'Bundle', type: 'searchset', entry: records.map(resource => ({ resource })), ...(next ? { link: [{ relation: 'next', url: next }] } : {}) });

afterEach(() => { vi.useRealTimers(); });

describe('educational health assessment', () => {
  it('explains the custom score, separate coverage, source observations, and synthetic data', () => {
    const assessment = assessHealth(createHealthFixture('patient-a', { asOf }), { asOf });
    expect(assessment.score).toMatchObject({ value: 64, coveragePercent: 100, availableDomains: 4, totalDomains: 4 });
    expect(assessment.score.explanation).toMatch(/Unvalidated educational/);
    expect(assessment.notices.join(' ')).toMatch(/synthetic/i);
    expect(assessment.notices.join(' ')).toMatch(/Pregnancy, existing diagnoses/);
    expect(assessment.domains.every(domain => domain.reference && domain.measuredAt && domain.sourceUrl.startsWith('https://'))).toBe(true);
    expect(assessment.actions.every(action => action.observationRef && action.reason && action.sourceUrl)).toBe(true);
  });

  it.each([
    [119, 79, 100, 'optimal'], [120, 79, 85, 'review'], [129, 79, 85, 'review'],
    [119, 80, 70, 'review'], [139, 89, 70, 'review'], [140, 70, 45, 'priority'],
    [120, 90, 45, 'priority'], [181, 70, 10, 'priority'], [120, 121, null, 'unsupported'],
    [160, 121, 10, 'priority'], [180, 120, 45, 'priority'],
  ] as const)('interprets both BP components at %s/%s', (systolic, diastolic, score, status) => {
    expect(result(bp(systolic, diastolic), 'blood-pressure')).toMatchObject({ score, status });
  });

  it('puts a recent severe reading first, with repeat measurement and symptom-dependent emergency advice', () => {
    const assessment = assessHealth(createHealthFixture('patient-d', { asOf }), { asOf });
    expect(assessment.score.value).toBeGreaterThan(50);
    expect(assessment.actions[0]).toMatchObject({ domainId: 'blood-pressure', priority: 'urgent' });
    expect(assessment.actions[0]!.description).toMatch(/one minute/);
    expect(assessment.actions[0]!.description).toMatch(/If it remains very high with/);
    expect(assessment.actions[0]!.description).toMatch(/Without concerning symptoms/);
  });

  it('preserves a current urgent action when the current score is null and a historical score is available', () => {
    const snapshot = createHealthFixture('patient-d', { asOf });
    snapshot.observations = [observation(snapshot, '85354-9'), observation(snapshot, '4548-4')];
    // The lab is just outside current freshness, but falls inside freshness two hours earlier.
    observation(snapshot, '85354-9').effectiveDateTime = new Date(Date.parse(asOf) - 2 * 3_600_000).toISOString();
    observation(snapshot, '4548-4').effectiveDateTime = new Date(Date.parse(asOf) - 365 * DAY - 3_600_000).toISOString();
    const current = assessHealth(snapshot, { asOf });
    const historical = assessHistoricalHealth(snapshot, { now: asOf })!;
    expect(current.score).toMatchObject({ value: null, availableDomains: 1 });
    expect(current.actions[0]).toMatchObject({ domainId: 'blood-pressure', priority: 'urgent' });
    expect(current.actions[0]!.description).toMatch(/If it remains very high with/);
    expect(historical.score.value).not.toBeNull();
    expect(historical.actions.every(action => action.priority !== 'urgent')).toBe(true);
  });

  it('does not represent an old or date-only severe result as a current emergency', () => {
    const old = assessHealth(bp(190, 122, 30), { asOf });
    expect(old.actions[0]).toMatchObject({ domainId: 'blood-pressure', priority: 'high' });
    expect(old.actions[0]!.description).toMatch(/past result does not establish your current/);
    const dateOnly = bp(190, 122);
    observation(dateOnly, '85354-9').effectiveDateTime = '2026-10-24';
    expect(assessHealth(dateOnly, { asOf }).actions.some(action => action.priority === 'urgent')).toBe(false);
    expect(assessHealth(bp(190, 122, 181), { asOf }).actions.some(action => action.priority === 'urgent')).toBe(false);
  });

  it('does not treat missing, stale or unknown data as healthy', () => {
    const assessment = assessHealth(createHealthFixture('patient-c', { asOf }), { asOf });
    expect(assessment.score).toMatchObject({ value: null, coveragePercent: 0, availableDomains: 0 });
    expect(assessment.domains.map(domain => domain.status)).toEqual(['stale', 'unknown', 'stale', 'unknown']);
    expect(assessment.actions.every(action => action.priority === 'data')).toBe(true);
  });

  it('requires at least two interpretable domains and changes coverage independently of score', () => {
    const snapshot = healthy();
    snapshot.observations = [observation(snapshot, '4548-4')];
    expect(assessHealth(snapshot, { asOf }).score).toMatchObject({ value: null, coveragePercent: 25, availableDomains: 1 });
    snapshot.observations.push(observation(healthy(), '39156-5'));
    expect(assessHealth(snapshot, { asOf }).score).toMatchObject({ value: 100, coveragePercent: 50, availableDomains: 2 });
  });

  it.each([['5.6', 100], ['5.7', 75], ['6.4', 75], ['6.5', 45], ['8.0', 45]])('uses cautious A1C screening interpretation at %s%%', (value, score) => {
    const snapshot = healthy();
    observation(snapshot, '4548-4').valueQuantity!.value = Number(value);
    expect(result(snapshot, 'a1c').score).toBe(score);
    if (score === 45) {
      const assessment = assessHealth(snapshot, { asOf });
      expect(result(snapshot, 'a1c').explanation).toMatch(/does not establish a new diagnosis/);
      expect(assessment.actions.find(action => action.domainId === 'a1c')!.description).toMatch(/individual target/);
    }
  });

  it.each(['2010-01-01', '2006-10-25', '1980', '1980-01', '1980-02-30', '2030-01-01', undefined])('does not calculate adult scores for missing, imprecise, invalid or under-20 DOB %s', birthDate => {
    const snapshot = healthy();
    snapshot.patient.birthDate = birthDate;
    const assessment = assessHealth(snapshot, { asOf });
    expect(assessment.score.value).toBeNull();
    expect(assessment.domains.every(domain => domain.status === 'unsupported' && domain.score === null)).toBe(true);
  });

  it('uses complete date age at the twentieth birthday', () => {
    const snapshot = healthy();
    snapshot.patient.birthDate = '2006-10-24';
    expect(assessHealth(snapshot, { asOf }).patient.age).toBe(20);
    expect(assessHealth(snapshot, { asOf }).score.value).toBe(100);
  });

  it('supports nutrition review rather than weight loss for an underweight BMI', () => {
    const snapshot = healthy();
    observation(snapshot, '39156-5').valueQuantity!.value = 17;
    const action = assessHealth(snapshot, { asOf }).actions.find(action => action.domainId === 'bmi')!;
    expect(action.title).toMatch(/nourishment/);
    expect(action.description).not.toMatch(/lose weight|weight loss/);
  });

  it.each(['preliminary', 'entered-in-error', 'cancelled', 'registered', 'unknown'])('excludes %s observations', status => {
    const snapshot = healthy();
    snapshot.observations.forEach(item => { item.status = status; });
    expect(assessHealth(snapshot, { asOf }).score.value).toBeNull();
    expect(assessHealth(snapshot, { asOf }).score.coveragePercent).toBe(0);
  });

  it.each(['final', 'amended', 'corrected'])('accepts %s observations', status => {
    const snapshot = healthy();
    snapshot.observations.forEach(item => { item.status = status; });
    expect(assessHealth(snapshot, { asOf }).score.value).toBe(100);
  });

  it('rejects future, partial and impossible measurement dates', () => {
    for (const date of ['2026-10-25T00:00:00Z', '2026-10', '2026-02-30', 'not-a-date', '2026-10-01T12:00:00']) {
      const snapshot = healthy();
      snapshot.observations.forEach(item => { item.effectiveDateTime = date; });
      expect(assessHealth(snapshot, { asOf }).score.value).toBeNull();
    }
  });

  it('requires exact unit semantics and ignores quantities with comparators', () => {
    const snapshot = healthy();
    const a1c = observation(snapshot, '4548-4');
    a1c.valueQuantity = { value: 5.3, system: 'http://unitsofmeasure.org', code: 'mmol/mol', unit: '%' };
    expect(result(snapshot, 'a1c').status).toBe('unsupported');
    a1c.valueQuantity = { value: 5.3, code: '%', comparator: '<' };
    expect(result(snapshot, 'a1c').score).toBeNull();
    a1c.valueQuantity = { value: 5.3, system: 'https://unrecognized.example/units', code: '%', unit: '%' };
    expect(result(snapshot, 'a1c').score).toBeNull();
    a1c.valueQuantity = { value: 5.3, unit: '%' };
    expect(result(snapshot, 'a1c').score).toBe(100);
    const pressure = observation(snapshot, '85354-9');
    pressure.component![0]!.valueQuantity!.code = 'kPa';
    expect(result(snapshot, 'blood-pressure').status).toBe('unsupported');
  });

  it('does not hide a newer unsupported measurement behind a healthy older one', () => {
    const snapshot = healthy();
    const newer = structuredClone(observation(snapshot, '4548-4'));
    newer.id = 'newer-a1c'; newer.effectiveDateTime = asOf; newer.valueQuantity!.code = 'mmol/mol';
    snapshot.observations.push(newer);
    expect(result(snapshot, 'a1c')).toMatchObject({ score: null, status: 'unsupported', reference: 'Observation/newer-a1c' });
  });

  it('does not guess unknown or contradictory smoking codes', () => {
    const snapshot = healthy();
    const record = observation(snapshot, '72166-2');
    record.valueCodeableConcept = { text: 'Never smoker', coding: [{ system: 'https://other.example', code: '266919005' }] };
    expect(result(snapshot, 'tobacco').score).toBeNull();
    record.valueCodeableConcept = { coding: [{ system: 'http://snomed.info/sct', code: '266919005' }, { system: 'http://snomed.info/sct', code: '449868002' }] };
    expect(result(snapshot, 'tobacco').status).toBe('unknown');
    record.valueCodeableConcept = { coding: [{ system: 'http://snomed.info/sct', code: '77176002' }] };
    expect(result(snapshot, 'tobacco').score).toBeNull();
  });

  it('isolates observation subjects by both patient and approved FHIR namespace', () => {
    const snapshot = healthy();
    snapshot.fhirBaseUrl = baseUrl;
    snapshot.observations.forEach(item => { item.subject = { reference: `${baseUrl}/Patient/patient-b` }; });
    expect(assessHealth(snapshot, { asOf }).score.value).toBe(100);
    for (const reference of ['Patient/patient-a', 'https://evil.example/fhir/Patient/patient-b', `${baseUrl}-other/Patient/patient-b`, `${baseUrl}/Patient/patient-b/_history/1`, 'patient-b']) {
      snapshot.observations.forEach(item => { item.subject = { reference }; });
      expect(assessHealth(snapshot, { asOf }).score.value).toBeNull();
    }
  });
});

describe('ordinary FHIR snapshot reader', () => {
  it('reads all four domains from an EHR that rejects Observation searches without a category', async () => {
    const fixture = healthy();
    const categories: string[] = [];
    const request: typeof fetch = async input => {
      const url = new URL(input.toString());
      if (url.pathname.endsWith('/Patient/patient-b')) return json(fixture.patient);
      const category = url.searchParams.get('category');
      if (!category) return json({ resourceType: 'OperationOutcome', issue: [{ severity: 'fatal', code: 'required', diagnostics: 'Must have either code or category.' }] }, 400);
      categories.push(category);
      expect(url.searchParams.get('patient')).toBe('patient-b');
      return json(bundle(fixture.observations.filter(item => item.category?.some(value => value.coding?.some(coding => coding.code === category)))));
    };
    const snapshot = await readPatientSnapshot({ baseUrl, patientReference: 'Patient/patient-b', getAuthorizationHeader: async () => 'Bearer token', fetch: request });
    expect(categories).toEqual(['vital-signs', 'laboratory', 'social-history']);
    expect(snapshot.issues).toEqual([]);
    expect(snapshot.observations).toHaveLength(4);
    expect(assessHealth(snapshot, { asOf }).score).toMatchObject({ value: 100, availableDomains: 4, coveragePercent: 100 });
  });

  it('recovers legacy survey smoking observations with a bounded patient-and-LOINC search', async () => {
    const fixture = healthy();
    const smoking = fixture.observations.find(item => item.code?.coding?.some(coding => coding.code === '72166-2'))!;
    smoking.category = [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'survey' }] }];
    smoking.valueCodeableConcept = { coding: [{ system: 'http://snomed.info/sct', code: '449868002' }] };
    const calls: { url: URL; header: string | null }[] = [];
    const next = new URL(`${baseUrl}/Observation?patient=patient-b&code=http%3A%2F%2Floinc.org%7C72166-2&_page=2`);
    const request: typeof fetch = async (input, init) => {
      const url = new URL(input.toString());
      calls.push({ url, header: new Headers(init?.headers).get('Authorization') });
      if (url.pathname.endsWith('/Patient/patient-b')) return json(fixture.patient);
      expect(url.searchParams.get('patient')).toBe('patient-b');
      if (url.searchParams.has('code')) {
        expect(url.searchParams.get('code')).toBe('http://loinc.org|72166-2');
        expect(url.searchParams.has('category')).toBe(false);
        return json(url.searchParams.has('_page') ? bundle([structuredClone(smoking)]) : bundle([smoking, fixture.observations[0]!], next.toString()));
      }
      const category = url.searchParams.get('category');
      return json(bundle(fixture.observations.filter(item => item.category?.some(value => value.coding?.some(coding => coding.code === category)))));
    };
    let credential = 0;
    const snapshot = await readPatientSnapshot({ baseUrl, patientReference: 'patient-b', getAuthorizationHeader: async () => `Bearer refreshed-${++credential}`, fetch: request });
    expect(calls.slice(1, 4).map(call => call.url.searchParams.get('category'))).toEqual(['vital-signs', 'laboratory', 'social-history']);
    expect(calls[4]!.url.searchParams.get('_count')).toBe('100');
    expect(calls.map(call => call.header)).toEqual(Array.from({ length: 6 }, (_, index) => `Bearer refreshed-${index + 1}`));
    expect(snapshot.issues).toEqual([]);
    expect(snapshot.observations).toHaveLength(4);
    expect(snapshot.observations.filter(item => item.id === smoking.id)).toHaveLength(1);
    expect(assessHealth(snapshot, { asOf }).score).toMatchObject({ value: 83, availableDomains: 4, coveragePercent: 100 });
    expect(assessHealth(snapshot, { asOf }).domains.find(item => item.id === 'tobacco')).toMatchObject({ status: 'priority', score: 30 });
  });

  it.each(['266927001', 'unsupported-status'])('does not search for older smoking records when the received newest status is %s', async statusCode => {
    const fixture = healthy();
    const smoking = fixture.observations.find(item => item.code?.coding?.some(coding => coding.code === '72166-2'))!;
    smoking.valueCodeableConcept = { coding: [{ system: 'http://snomed.info/sct', code: statusCode }] };
    const request = vi.fn<typeof fetch>().mockImplementation(async input => {
      const url = new URL(input.toString());
      if (url.pathname.endsWith('/Patient/patient-b')) return json(fixture.patient);
      expect(url.searchParams.has('code')).toBe(false);
      const category = url.searchParams.get('category');
      return json(bundle(fixture.observations.filter(item => item.category?.some(value => value.coding?.some(coding => coding.code === category)))));
    });
    const snapshot = await readPatientSnapshot({ baseUrl, patientReference: 'patient-b', getAuthorizationHeader: async () => 'Bearer token', fetch: request });
    expect(request).toHaveBeenCalledTimes(4);
    expect(snapshot.issues).toEqual([]);
    expect(assessHealth(snapshot, { asOf }).domains.find(item => item.id === 'tobacco')).toMatchObject({ status: 'unknown', score: null, reference: `Observation/${smoking.id}` });
  });

  it('keeps received category data and reports a failed targeted smoking search without retry or fabricated results', async () => {
    const fixture = healthy();
    const request = vi.fn<typeof fetch>().mockImplementation(async input => {
      const url = new URL(input.toString());
      if (url.pathname.endsWith('/Patient/patient-b')) return json(fixture.patient);
      if (url.searchParams.has('code')) return json({ secret: 'private smoking denial' }, 403);
      const category = url.searchParams.get('category');
      return json(bundle(category === 'social-history' ? [] : fixture.observations.filter(item => item.category?.some(value => value.coding?.some(coding => coding.code === category)))));
    });
    const snapshot = await readPatientSnapshot({ baseUrl, patientReference: 'patient-b', getAuthorizationHeader: async () => 'Bearer token', fetch: request });
    expect(request).toHaveBeenCalledTimes(5);
    expect(snapshot.issues.map(issue => issue.code)).toEqual(['observations_access_denied']);
    expect(snapshot.observations).toHaveLength(3);
    expect(assessHealth(snapshot, { asOf }).score).toMatchObject({ value: 100, availableDomains: 3, coveragePercent: 75 });
    expect(JSON.stringify(snapshot)).not.toContain('private smoking denial');
  });

  it.each(['vital-signs', 'laboratory', 'social-history'])('keeps successful categories when %s access is denied', async deniedCategory => {
    const fixture = healthy();
    const calls: URL[] = [];
    const request: typeof fetch = async input => {
      const url = new URL(input.toString());
      calls.push(url);
      if (url.pathname.endsWith('/Patient/patient-b')) return json(fixture.patient);
      const category = url.searchParams.get('category');
      if (category === deniedCategory) return json({ secret: 'private denial body' }, 403);
      return json(bundle(fixture.observations.filter(item => item.category?.some(value => value.coding?.some(coding => coding.code === category)))));
    };
    const snapshot = await readPatientSnapshot({ baseUrl, patientReference: 'patient-b', getAuthorizationHeader: async () => 'Bearer token', fetch: request });
    expect(snapshot.issues).toEqual([{ code: 'observations_access_denied', message: expect.any(String) }]);
    expect(snapshot.observations).toHaveLength(deniedCategory === 'vital-signs' ? 2 : 3);
    expect(assessHealth(snapshot, { asOf }).score.value).toBe(100);
    expect(JSON.stringify(snapshot)).not.toContain('private denial body');
    expect(calls).toHaveLength(4);
    expect(calls.some(url => url.searchParams.has('code'))).toBe(false);
  });

  it('deduplicates observations across pages and categories while retaining resources without IDs', async () => {
    const fixture = healthy();
    const shared = fixture.observations[0]!;
    const withoutId = { ...fixture.observations[1]! };
    delete withoutId.id;
    const request: typeof fetch = async input => input.toString().endsWith('/Patient/patient-b')
      ? json(fixture.patient) : json(bundle(new URL(input.toString()).searchParams.has('code') ? [] : [shared, structuredClone(shared), withoutId]));
    const snapshot = await readPatientSnapshot({ baseUrl, patientReference: 'patient-b', getAuthorizationHeader: async () => 'Bearer token', fetch: request });
    expect(snapshot.observations).toHaveLength(4);
    expect(snapshot.observations.filter(item => item.id === shared.id)).toHaveLength(1);
    expect(snapshot.observations.filter(item => !item.id)).toHaveLength(3);
    expect(snapshot.issues).toEqual([]);
  });

  it('uses a renewable bearer provider and follows gateway pages only inside the authorized subtree', async () => {
    const fixture = healthy();
    const gatewayBase = 'https://bridge.example/fhir/activation-123';
    fixture.observations.forEach(item => { item.subject = { reference: `${baseUrl}/Patient/patient-b` }; });
    const vitalSigns = fixture.observations.filter(item => item.category?.some(category => category.coding?.some(coding => coding.code === 'vital-signs')));
    const calls: { url: string; init?: RequestInit }[] = [];
    const request: typeof fetch = async (input, init) => {
      const url = input.toString(); calls.push({ url, init });
      if (url.endsWith('/Patient/patient-b')) return json(fixture.patient);
      if (url.includes('/Observation?')) {
        const category = new URL(url).searchParams.get('category');
        if (category === 'vital-signs') return json(bundle(vitalSigns.slice(0, 1), `${gatewayBase}/_page/page-opaque`));
        return json(bundle(fixture.observations.filter(item => item.category?.some(value => value.coding?.some(coding => coding.code === category)))));
      }
      if (url.endsWith('/_page/page-opaque')) return json(bundle(vitalSigns.slice(1)));
      throw new Error('Unexpected request');
    };
    let token = 0;
    const snapshot = await readPatientSnapshot({ baseUrl: gatewayBase, subjectBaseUrl: baseUrl, patientReference: `${baseUrl}/Patient/patient-b`, getAuthorizationHeader: async () => `Bearer short-lived-${++token}`, fetch: request });
    expect(snapshot.observations).toHaveLength(4);
    expect(snapshot.fhirBaseUrl).toBe(baseUrl);
    expect(assessHealth(snapshot, { asOf }).score.value).toBe(100);
    expect(calls.map(call => new Headers(call.init?.headers).get('Authorization'))).toEqual(Array.from({ length: 5 }, (_, index) => `Bearer short-lived-${index + 1}`));
    expect(calls.every(call => call.url.startsWith(`${gatewayBase}/`))).toBe(true);
    expect(calls.every(call => call.init?.redirect === 'error' && call.init.cache === 'no-store' && call.init.credentials === 'omit')).toBe(true);
  });

  it.each(['https://evil.example/fhir/Observation', 'https://ehr.example/fhir-other/Observation', 'https://ehr.example/fhir/../admin', 'https://ehr.example/fhir/%2fadmin', 'https://user:secret@ehr.example/fhir/Observation'])('never sends a bearer token to an unsafe next link %s', async next => {
    const fixture = healthy();
    const request = vi.fn<typeof fetch>().mockImplementation(async () => json(bundle())).mockResolvedValueOnce(json(fixture.patient)).mockResolvedValueOnce(json(bundle([fixture.observations[0]!], next)));
    const snapshot = await readPatientSnapshot({ baseUrl, patientReference: 'Patient/patient-b', getAuthorizationHeader: async () => 'Bearer secret', fetch: request });
    expect(request).toHaveBeenCalledTimes(4);
    expect(request.mock.calls.some(([url]) => url.toString() === next)).toBe(false);
    expect(snapshot.issues.map(issue => issue.code)).toContain('unsafe_paging_link');
  });

  it('discards foreign same-id observation subjects even when they arrive through a trusted gateway', async () => {
    const fixture = healthy();
    fixture.observations[0]!.subject = { reference: 'https://foreign.example/fhir/Patient/patient-b' };
    fixture.observations[1]!.subject = { reference: `${baseUrl}/Patient/patient-b` };
    const request = vi.fn<typeof fetch>().mockImplementation(async () => json(bundle())).mockResolvedValueOnce(json(fixture.patient)).mockResolvedValueOnce(json(bundle(fixture.observations.slice(0, 2))));
    const snapshot = await readPatientSnapshot({ baseUrl: 'https://bridge.example/fhir/activation-a', subjectBaseUrl: baseUrl, patientReference: 'patient-b', getAuthorizationHeader: async () => 'Bearer token', fetch: request });
    expect(snapshot.observations).toHaveLength(1);
    expect(snapshot.issues.map(issue => issue.code)).toContain('observation_patient_mismatch');
  });

  it.each([401, 403, 500])('reports observation HTTP %s as incomplete data without fabricated fallback', async status => {
    const request = vi.fn<typeof fetch>().mockImplementation(async () => json({ secret: 'not displayed' }, status)).mockResolvedValueOnce(json(healthy().patient));
    const snapshot = await readPatientSnapshot({ baseUrl, patientReference: 'patient-b', getAuthorizationHeader: async () => 'Bearer token', fetch: request });
    expect(snapshot.observations).toEqual([]);
    expect(snapshot.issues[0]!.code).toBe(status === 500 ? 'observations_unavailable' : 'observations_access_denied');
    expect(JSON.stringify(snapshot)).not.toContain('not displayed');
    expect(assessHealth(snapshot, { asOf }).score.value).toBeNull();
    expect(request).toHaveBeenCalledTimes(4);
  });

  it('fails the patient read with a structured body-free error and rejects mismatched patients', async () => {
    const options = { baseUrl, patientReference: 'patient-b', getAuthorizationHeader: async () => 'Bearer token' };
    const denied = readPatientSnapshot({ ...options, fetch: vi.fn<typeof fetch>().mockResolvedValue(json({ message: 'sensitive upstream body' }, 403)) });
    await expect(denied).rejects.toMatchObject({ name: 'FHIRReadError', code: 'http_error', status: 403 });
    const mismatch = readPatientSnapshot({ ...options, fetch: vi.fn<typeof fetch>().mockResolvedValue(json(createHealthFixture('patient-a', { asOf }).patient)) });
    await expect(mismatch).rejects.toMatchObject({ code: 'patient_mismatch' });
  });

  it('bounds paging and detects cycles', async () => {
    const next = `${baseUrl}/Observation?cursor=next`;
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(json(healthy().patient)).mockImplementation(async () => json(bundle([], next)));
    const snapshot = await readPatientSnapshot({ baseUrl, patientReference: 'patient-b', maxPages: 1, getAuthorizationHeader: async () => 'Bearer token', fetch: request });
    expect(request).toHaveBeenCalledTimes(4);
    expect(snapshot.issues.map(issue => issue.code)).toContain('page_limit');
    const cycleRequest = vi.fn<typeof fetch>().mockResolvedValueOnce(json(healthy().patient)).mockImplementation(async () => json(bundle([], next)));
    const cycle = await readPatientSnapshot({ baseUrl, patientReference: 'patient-b', getAuthorizationHeader: async () => 'Bearer token', fetch: cycleRequest });
    expect(cycleRequest).toHaveBeenCalledTimes(7);
    expect(cycle.issues.map(issue => issue.code)).toContain('paging_cycle');
  });

  it('rejects foreign patient references and cleartext non-loopback transport before issuing requests', async () => {
    const request = vi.fn<typeof fetch>();
    await expect(readPatientSnapshot({ baseUrl, patientReference: 'https://foreign.example/fhir/Patient/patient-b', getAuthorizationHeader: async () => 'Bearer token', fetch: request })).rejects.toBeInstanceOf(FHIRReadError);
    await expect(readPatientSnapshot({ baseUrl: 'http://ehr.example/fhir', patientReference: 'patient-b', getAuthorizationHeader: async () => 'Bearer token', fetch: request })).rejects.toMatchObject({ code: 'insecure_base' });
    expect(request).not.toHaveBeenCalled();
  });

  it('bounds streamed and declared response bodies', async () => {
    const options = { baseUrl, patientReference: 'patient-b', getAuthorizationHeader: async () => 'Bearer token' };
    const declared = new Response('sensitive', { headers: { 'content-length': String(6 * 1024 * 1024) } });
    await expect(readPatientSnapshot({ ...options, fetch: vi.fn<typeof fetch>().mockResolvedValue(declared) })).rejects.toMatchObject({ code: 'response_too_large' });
    const streamed = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(5 * 1024 * 1024 + 1)); controller.close(); } }));
    await expect(readPatientSnapshot({ ...options, fetch: vi.fn<typeof fetch>().mockResolvedValue(streamed) })).rejects.toMatchObject({ code: 'response_too_large' });
  });

  it('aborts a slow patient request and reports a structured timeout', async () => {
    vi.useFakeTimers();
    const request: typeof fetch = async (_input, init) => new Promise((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); });
    const pending = readPatientSnapshot({ baseUrl, patientReference: 'patient-b', getAuthorizationHeader: async () => 'Bearer token', fetch: request });
    const expected = expect(pending).rejects.toMatchObject({ code: 'request_timeout' });
    await vi.advanceTimersByTimeAsync(15_001);
    await expected;
  });
});

describe('historical educational assessment', () => {
  const recordDate = '2021-02-24T12:00:00.000Z';
  const historical = () => {
    const snapshot = healthy();
    snapshot.patient.birthDate = '1947-03-01';
    snapshot.observations = snapshot.observations.filter(item => !item.code?.coding?.some(coding => coding.code === '4548-4'));
    snapshot.observations.forEach(item => { item.effectiveDateTime = recordDate; });
    observation(snapshot, '85354-9').code!.coding![0]!.code = '55284-4';
    return snapshot;
  };

  it('supports a real legacy BP panel code only with coded, exact component quantities', () => {
    const snapshot = healthy();
    const record = observation(snapshot, '85354-9');
    record.code!.coding![0]!.code = '55284-4';
    expect(result(snapshot, 'blood-pressure')).toMatchObject({ status: 'optimal', value: '112/72 mmHg', score: 100 });
    record.component = [];
    record.valueString = '112/72';
    expect(result(snapshot, 'blood-pressure')).toMatchObject({ status: 'unsupported', score: null });
  });

  it('replays actual old measurements with age at that date while current assessment remains unscored', () => {
    const snapshot = historical();
    expect(assessHealth(snapshot, { asOf }).score).toMatchObject({ value: null, availableDomains: 0 });
    const assessment = assessHistoricalHealth(snapshot, { now: asOf })!;
    expect(assessment).toMatchObject({ mode: 'historical', assessedAt: recordDate, patient: { age: 73 } });
    expect(assessment.score).toMatchObject({ value: 100, coveragePercent: 75, availableDomains: 3 });
    expect(assessment.score.label).toMatch(/Historical/);
    expect(assessment.score.explanation).toMatch(/not current health/);
    expect(assessment.notices[0]).toMatch(/Historical educational assessment/);
    expect(assessment.domains.find(domain => domain.id === 'a1c')!.score).toBeNull();
    expect(assessHealth(snapshot, { asOf }).patient.age).toBe(79);
    expect(assessHealth(snapshot, { asOf }).mode).toBe('current');
  });

  it('does not label an untagged EHR record as synthetic or a sandbox', () => {
    const snapshot = historical();
    delete snapshot.patient.meta;
    const assessment = assessHistoricalHealth(snapshot, { now: asOf })!;
    expect(assessment.mode).toBe('historical');
    expect(assessment.notices.join(' ')).not.toMatch(/synthetic|sandbox/i);
    expect(assessment.score.label).toBe('Historical educational snapshot');
  });

  it('never emits current emergency instructions in replay, even for a severe value at the anchor timestamp', () => {
    const snapshot = historical();
    const pressure = observation(snapshot, '55284-4');
    pressure.component![0]!.valueQuantity!.value = 190;
    pressure.component![1]!.valueQuantity!.value = 122;
    const assessment = assessHistoricalHealth(snapshot, { now: asOf })!;
    expect(assessment.actions[0]).toMatchObject({ domainId: 'blood-pressure', priority: 'high' });
    expect(assessment.actions.every(action => action.priority !== 'urgent')).toBe(true);
    expect(assessment.actions.map(action => `${action.title} ${action.description}`).join(' ')).not.toMatch(/911|emergency help|one minute|recheck.*now/i);
    expect(assessment.actions[0]!.description).toMatch(/does not establish your current blood pressure/);
    expect(assessment.actions.every(action => action.title.startsWith('Historical example:'))).toBe(true);
  });

  it('does not rewrite any patient or observation date or otherwise mutate the snapshot', () => {
    const snapshot = historical();
    const original = structuredClone(snapshot);
    assessHistoricalHealth(snapshot, { now: asOf });
    expect(snapshot).toEqual(original);
    expect(assessHealth(snapshot, { asOf }).score.value).toBeNull();
  });

  it('does not use today’s adult age to interpret childhood observations', () => {
    const snapshot = historical();
    snapshot.patient.birthDate = '2010-01-01';
    const assessment = assessHistoricalHealth(snapshot, { now: asOf })!;
    expect(assessment.patient.age).toBe(11);
    expect(assessment.score.value).toBeNull();
    expect(assessment.domains.every(domain => domain.status === 'unsupported')).toBe(true);
    snapshot.patient.birthDate = '2000-01-01';
    expect(assessHistoricalHealth(snapshot, { now: asOf })!.patient.age).toBe(21);
    expect(assessHistoricalHealth(snapshot, { now: asOf })!.score.value).toBe(100);
  });

  it('chooses no anchor from unrelated, invalid, non-final, foreign, unsupported, or future records', () => {
    const snapshot = historical();
    const valid = observation(snapshot, '39156-5');
    const added = Array.from({ length: 7 }, () => structuredClone(valid));
    added.forEach((item, index) => { item.id = `excluded-anchor-${index}`; item.effectiveDateTime = asOf; });
    added[0]!.code = { coding: [{ system: 'http://loinc.org', code: '29463-7' }] };
    added[1]!.effectiveDateTime = '2026-02-30';
    added[2]!.status = 'preliminary';
    added[3]!.subject = { reference: 'Patient/patient-a' };
    added[4]!.valueQuantity!.code = 'wrong-unit';
    added[5]!.effectiveDateTime = '2030-01-01T00:00:00Z';
    added[6]!.subject = { reference: 'https://other.example/fhir/Patient/patient-b' };
    snapshot.observations.push(...added);
    expect(assessHistoricalHealth(snapshot, { now: asOf })!.assessedAt).toBe(recordDate);
    snapshot.observations = added;
    expect(assessHistoricalHealth(snapshot, { now: asOf })).toBeNull();
  });

  it('cannot anchor on missing, partial or comparator quantities and still needs two scored domains', () => {
    const snapshot = historical();
    snapshot.observations = [observation(snapshot, '39156-5')];
    expect(assessHistoricalHealth(snapshot, { now: asOf })!.score).toMatchObject({ value: null, availableDomains: 1 });
    snapshot.observations[0]!.valueQuantity!.comparator = '<';
    expect(assessHistoricalHealth(snapshot, { now: asOf })).toBeNull();
    delete snapshot.observations[0]!.valueQuantity!.comparator;
    snapshot.observations[0]!.effectiveDateTime = '2021-02';
    expect(assessHistoricalHealth(snapshot, { now: asOf })).toBeNull();
  });

  it('requires interval measurements to have finished at the historical anchor', () => {
    const snapshot = historical();
    snapshot.observations.forEach(item => {
      delete item.effectiveDateTime;
      item.effectivePeriod = { start: '2021-02-23T12:00:00Z', end: recordDate };
    });
    const assessment = assessHistoricalHealth(snapshot, { now: asOf })!;
    expect(assessment.assessedAt).toBe(recordDate);
    expect(assessment.score.value).toBe(100);
  });

  it('returns null for an empty record set and rejects an invalid reference clock', () => {
    const snapshot = historical(); snapshot.observations = [];
    expect(assessHistoricalHealth(snapshot, { now: asOf })).toBeNull();
    expect(() => assessHistoricalHealth(snapshot, { now: 'invalid' })).toThrow('valid assessment date');
    expect(() => assessHistoricalHealth(snapshot, { now: new Date(NaN) })).toThrow('valid assessment date');
  });

  it('keeps current freshness boundaries unchanged after adding replay', () => {
    const snapshot = healthy();
    snapshot.observations.forEach(item => { item.effectiveDateTime = new Date(Date.parse(asOf) - 365 * DAY).toISOString(); });
    expect(result(snapshot, 'a1c').status).toBe('optimal');
    expect(result(snapshot, 'blood-pressure').status).toBe('stale');
    observation(snapshot, '4548-4').effectiveDateTime = new Date(Date.parse(asOf) - 366 * DAY).toISOString();
    expect(result(snapshot, 'a1c').status).toBe('stale');
  });

  it('distinguishes missing codes from excluded records and unsupported values', () => {
    const missing = healthy(); missing.observations = [];
    expect(result(missing, 'a1c').explanation).toMatch(/No observations.*supported LOINC codes/);
    const excluded = healthy();
    const a1c = observation(excluded, '4548-4');
    a1c.effectiveDateTime = '2030-01-01T00:00:00Z';
    const another = structuredClone(a1c); another.status = 'preliminary'; excluded.observations.push(another);
    expect(result(excluded, 'a1c').explanation).toMatch(/future measurement date \(1\)/);
    expect(result(excluded, 'a1c').explanation).toMatch(/non-final status \(1\)/);
    const unsupported = historical();
    observation(unsupported, '39156-5').valueQuantity!.code = 'wrong-unit';
    expect(result(unsupported, 'bmi')).toMatchObject({ status: 'unsupported', score: null });
  });

  it('limits display precision without changing source values or classification at a boundary', () => {
    const snapshot = bp(129.999, 79.999);
    observation(snapshot, '4548-4').valueQuantity!.value = 5.6999;
    observation(snapshot, '39156-5').valueQuantity!.value = 24.9999;
    const original = structuredClone(snapshot);
    expect(result(snapshot, 'blood-pressure')).toMatchObject({ value: '130/80 mmHg', score: 85 });
    expect(result(snapshot, 'a1c')).toMatchObject({ value: '5.7%', score: 100 });
    expect(result(snapshot, 'bmi')).toMatchObject({ value: '25 kg/m²', score: 100 });
    expect(snapshot).toEqual(original);
    const longDecimals = bp(117.45079288057642, 86.81222071748446);
    expect(result(longDecimals, 'blood-pressure').value).toBe('117.5/86.8 mmHg');
  });
});
