import type { FhirObservation, PatientSnapshot } from './types.js';

const LOINC = 'http://loinc.org';
const UCUM = 'http://unitsofmeasure.org';
const synthetic = { tag: [{ system: 'https://smart-flint.dev/tags', code: 'synthetic', display: 'Synthetic demonstration data' }] };

/** Synthetic records only; never used as a fallback when a real FHIR request fails. */
export function createHealthFixture(patientId: 'patient-a' | 'patient-b' | 'patient-c' | 'patient-d', options: { asOf?: string | Date } = {}): PatientSnapshot {
  const asOf = options.asOf instanceof Date ? options.asOf : new Date(options.asOf ?? Date.now());
  if (!Number.isFinite(asOf.getTime())) throw new Error('A valid fixture date is required.');
  const ago = (days: number) => new Date(asOf.getTime() - days * 86_400_000).toISOString();
  const categoryForCode = (code: string) => code === '72166-2' ? 'social-history'
    : ['4548-4', '17856-6', '59261-8'].includes(code) ? 'laboratory' : 'vital-signs';
  const base = (suffix: string, code: string, days: number): FhirObservation => ({
    resourceType: 'Observation', id: `health-${patientId}-${suffix}`, meta: synthetic,
    status: 'final', subject: { reference: `Patient/${patientId}` },
    category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: categoryForCode(code) }] }],
    code: { coding: [{ system: LOINC, code }] }, effectiveDateTime: ago(days),
  });
  const quantity = (suffix: string, code: string, value: number, unit: string, days: number): FhirObservation => ({
    ...base(suffix, code, days), valueQuantity: { value, system: UCUM, code: unit, unit },
  });
  const bp = (systolic: number, diastolic: number, days: number, suffix = 'bp'): FhirObservation => ({
    ...base(suffix, '85354-9', days), component: [
      { code: { coding: [{ system: LOINC, code: '8480-6' }] }, valueQuantity: { value: systolic, system: UCUM, code: 'mm[Hg]', unit: 'mmHg' } },
      { code: { coding: [{ system: LOINC, code: '8462-4' }] }, valueQuantity: { value: diastolic, system: UCUM, code: 'mm[Hg]', unit: 'mmHg' } },
    ],
  });
  const tobacco = (code: string, days: number): FhirObservation => ({
    ...base('tobacco', '72166-2', days), valueCodeableConcept: { coding: [{ system: 'http://snomed.info/sct', code }] },
  });
  const profiles = {
    'patient-a': { given: 'Maya', family: 'Morgan', birthDate: '1978-06-15', observations: [
      bp(146, 92, 95, 'bp-previous'), bp(138, 86, 6),
      quantity('a1c-previous', '4548-4', 6.4, '%', 150), quantity('a1c', '4548-4', 6.1, '%', 20),
      quantity('bmi', '39156-5', 28.1, 'kg/m2', 20), tobacco('449868002', 20),
    ] },
    'patient-b': { given: 'Noah', family: 'River', birthDate: '1988-02-03', observations: [
      bp(112, 72, 4), quantity('a1c', '4548-4', 5.3, '%', 35), quantity('bmi', '39156-5', 23.4, 'kg/m2', 35), tobacco('266919005', 35),
    ] },
    'patient-c': { given: 'Jamie', family: 'Chen', birthDate: '1965-11-09', observations: [
      bp(142, 92, 410), quantity('bmi', '39156-5', 26.2, 'kg/m2', 410), tobacco('266927001', 10),
    ] },
    'patient-d': { given: 'Sam', family: 'Taylor', birthDate: '1970-03-21', observations: [
      bp(190, 122, 1 / 12), quantity('a1c', '4548-4', 6.6, '%', 10), quantity('bmi', '39156-5', 31.2, 'kg/m2', 10), tobacco('8517006', 10),
    ] },
  };
  const profile = profiles[patientId];
  if (!profile) throw new Error('Unknown synthetic patient.');
  return {
    patient: { resourceType: 'Patient', id: patientId, meta: synthetic,
      name: [{ given: [profile.given], family: profile.family }], birthDate: profile.birthDate },
    observations: profile.observations, issues: [], loadedAt: asOf.toISOString(),
  };
}
