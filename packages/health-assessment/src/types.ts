export interface FhirResource {
  resourceType: string;
  id?: string;
  [key: string]: unknown;
}

export interface FhirCoding {
  system?: string;
  code?: string;
  display?: string;
}

export interface FhirCodeableConcept {
  coding?: FhirCoding[];
  text?: string;
}

export interface FhirQuantity {
  value?: number;
  comparator?: string;
  system?: string;
  code?: string;
  unit?: string;
}

export interface FhirPatient extends FhirResource {
  resourceType: 'Patient';
  name?: { use?: string; text?: string; given?: string[]; family?: string }[];
  birthDate?: string;
}

export interface FhirObservation extends FhirResource {
  resourceType: 'Observation';
  status?: string;
  subject?: { reference?: string };
  category?: FhirCodeableConcept[];
  code?: FhirCodeableConcept;
  effectiveDateTime?: string;
  effectivePeriod?: { start?: string; end?: string };
  valueQuantity?: FhirQuantity;
  valueCodeableConcept?: FhirCodeableConcept;
  component?: { code?: FhirCodeableConcept; valueQuantity?: FhirQuantity }[];
}

export interface PatientSnapshot {
  patient: FhirPatient;
  observations: FhirObservation[];
  issues: { code: string; message: string }[];
  loadedAt: string;
  fhirBaseUrl?: string;
}

export type DomainId = 'blood-pressure' | 'a1c' | 'bmi' | 'tobacco';
export type DomainStatus = 'optimal' | 'review' | 'priority' | 'unknown' | 'stale' | 'unsupported';

export interface AssessmentDomain {
  id: DomainId;
  title: string;
  status: DomainStatus;
  score: number | null;
  value: string;
  measuredAt?: string;
  reference?: string;
  explanation: string;
  sourceUrl: string;
}

export interface HealthAction {
  id: string;
  title: string;
  description: string;
  priority: 'urgent' | 'high' | 'medium' | 'routine' | 'data';
  domainId: DomainId;
  reason: string;
  sourceUrl: string;
  observationRef?: string;
}

export interface HealthAssessment {
  version: string;
  mode: 'current' | 'historical';
  assessedAt: string;
  patient: { id: string; displayName: string; age?: number };
  score: {
    value: number | null;
    label: string;
    coveragePercent: number;
    availableDomains: number;
    totalDomains: number;
    explanation: string;
  };
  domains: AssessmentDomain[];
  actions: HealthAction[];
  notices: string[];
  evidence: { title: string; url: string }[];
}

export interface ReadPatientSnapshotOptions {
  baseUrl: string;
  /** Approved resource namespace, when a gateway serves upstream absolute references. Never used for HTTP requests. */
  subjectBaseUrl?: string;
  getAuthorizationHeader: () => Promise<string>;
  patientReference: string;
  fetch?: typeof fetch;
  /** Maximum pages per Observation category search; defaults to 5, capped at 20. */
  maxPages?: number;
}
