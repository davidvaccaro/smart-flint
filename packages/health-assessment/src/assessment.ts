import { normalizedBase, observationMatchesPatient } from './fhir.js';
import type { AssessmentDomain, DomainId, FhirCodeableConcept, FhirObservation, FhirQuantity, HealthAction, HealthAssessment, PatientSnapshot } from './types.js';

const DAY = 86_400_000;
const LOINC = 'http://loinc.org';
const UCUM = 'http://unitsofmeasure.org';
const measurementNumber = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1, useGrouping: false });
const SOURCES = {
  bp: 'https://www.heart.org/en/health-topics/high-blood-pressure/understanding-blood-pressure-readings',
  lowBp: 'https://www.heart.org/en/health-topics/high-blood-pressure/the-facts-about-high-blood-pressure/low-blood-pressure-when-blood-pressure-is-too-low',
  a1c: 'https://www.cdc.gov/diabetes/diabetes-testing/prediabetes-a1c-test.html',
  confirmation: 'https://www.niddk.nih.gov/health-information/diagnostic-tests/a1c-test',
  bmi: 'https://www.cdc.gov/bmi/adult-calculator/bmi-categories.html',
  tobacco: 'https://www.cdc.gov/tobacco/about/how-to-quit.html',
};
const DOMAIN_CONFIG: Record<DomainId, { title: string; codes: string[]; days: number; sourceUrl: string }> = {
  // Older Synthea/SMART data uses this legacy grouping code. Both numeric components remain mandatory.
  'blood-pressure': { title: 'Blood pressure', codes: ['85354-9', '55284-4'], days: 180, sourceUrl: SOURCES.bp },
  a1c: { title: 'Blood sugar (A1C)', codes: ['4548-4', '17856-6', '59261-8'], days: 365, sourceUrl: SOURCES.a1c },
  bmi: { title: 'Body mass index', codes: ['39156-5'], days: 365, sourceUrl: SOURCES.bmi },
  tobacco: { title: 'Smoking status', codes: ['72166-2'], days: 365, sourceUrl: SOURCES.tobacco },
};

interface DatedObservation { observation: FhirObservation; measuredAt: string; time: number; precise: boolean }
type ExclusionReason = 'patient subject mismatch' | 'non-final status' | 'missing or invalid measurement date' | 'future measurement date';

/** This custom educational composite is deliberately not a disease-risk model. */
export function assessHealth(snapshot: PatientSnapshot, options: { asOf?: string | Date } = {}): HealthAssessment {
  return assessSnapshot(snapshot, assessmentDate(options.asOf), 'current');
}

/** An educational view of dated records. It never rewrites records or represents historical readings as current emergencies. */
export function assessHistoricalHealth(snapshot: PatientSnapshot, options: { now?: string | Date } = {}): HealthAssessment | null {
  const now = assessmentDate(options.now);
  const { eligible } = collectObservations(snapshot, now);
  const anchors = eligible.filter(record => (Object.keys(DOMAIN_CONFIG) as DomainId[]).some(id => {
    if (!hasCode(record.observation.code, DOMAIN_CONFIG[id].codes)) return false;
    const domain = emptyDomain(id);
    scoreDomain(domain, record, new Date(record.time), [], false);
    return domain.score !== null;
  })).map(record => {
    // An interval must have finished before a replay can use it; the source dates stay unchanged.
    const end = parseMeasurementDate(record.observation.effectivePeriod?.end);
    return end ? Math.max(record.time, end.time) : record.time;
  });
  if (!anchors.length) return null;
  return assessSnapshot(snapshot, new Date(anchors.reduce((latest, anchor) => Math.max(latest, anchor), -Infinity)), 'historical');
}

function assessSnapshot(snapshot: PatientSnapshot, now: Date, mode: HealthAssessment['mode']): HealthAssessment {
  const age = fullDateAge(snapshot.patient.birthDate, now);
  const adult = age !== undefined && age >= 20;
  const notices = [
    'Educational sample only: this is an unvalidated, custom score, not a diagnosis or a prediction of disease risk.',
    'Pregnancy, existing diagnoses, medicines, symptoms, and other clinical factors can change interpretation. This sample does not evaluate them; discuss results and personal targets with your care team.',
    'Data freshness limits are sample design choices, not recommended testing schedules. Missing records do not mean a test is clinically required.',
    ...snapshot.issues.map(issue => issue.message),
  ];
  if (mode === 'historical') notices.unshift(`Historical educational assessment as of ${now.toISOString()}: age, freshness, and interpretation use this record date. This is not an assessment of current health.`);
  if (!adult) notices.push('Adult interpretation requires a complete birth date confirming age 20 or older. No adult score is calculated for this record.');
  const tag = snapshot.patient.meta as { tag?: { code?: string }[] } | undefined;
  if (tag?.tag?.some(item => item.code === 'synthetic')) notices.push('This patient and all fixture observations are synthetic demonstration data.');
  const { eligible, exclusions, invalidNamespace } = collectObservations(snapshot, now);
  if (invalidNamespace) notices.push('The FHIR namespace was invalid; absolute patient references were excluded.');
  if (exclusions.size) notices.push(`${exclusions.size} observation record(s) were excluded because their subject, final status, or measurement date could not be safely used.`);
  const actions: HealthAction[] = [];
  const domains = (Object.keys(DOMAIN_CONFIG) as DomainId[]).map(id => {
    const config = DOMAIN_CONFIG[id];
    const record = eligible.find(item => hasCode(item.observation.code, config.codes));
    const domain = emptyDomain(id);
    if (record) {
      domain.measuredAt = record.measuredAt;
      domain.reference = record.observation.id ? `Observation/${record.observation.id}` : undefined;
    }
    if (!adult) {
      domain.status = 'unsupported';
      domain.value = 'Adult interpretation unavailable';
      domain.explanation = 'This sample supports adults age 20 or older with a complete birth date.';
      return domain;
    }
    if (!record) {
      const matching = snapshot.observations.filter(observation => hasCode(observation.code, config.codes));
      if (!matching.length) domain.explanation = `No observations with this domain’s supported LOINC codes (${config.codes.join(', ')}) were received.`;
      else {
        const reasons = new Map<ExclusionReason, number>();
        for (const observation of matching) {
          const reason = exclusions.get(observation);
          if (reason) reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
        }
        domain.explanation = `${matching.length} matching observation record(s) were excluded: ${[...reasons].map(([reason, count]) => `${reason} (${count})`).join('; ')}.`;
      }
      addDataAction(domain, actions, 'Ask which records matter for your health review');
      return domain;
    }
    const domainActions: HealthAction[] = [];
    scoreDomain(domain, record, now, domainActions, mode === 'current');
    if (domain.score === null) {
      actions.push(...domainActions);
      return domain;
    }
    if (now.getTime() - record.time > config.days * DAY) {
      domain.status = 'stale';
      domain.score = null;
      domain.value = 'Older record';
      domain.explanation = `The latest usable record is older than this sample’s ${config.days}-day freshness limit; it is excluded from the score.`;
      addDataAction(domain, actions, 'Review whether this record needs updating');
      return domain;
    }
    actions.push(...domainActions);
    return domain;
  });
  const available = domains.filter(domain => domain.score !== null);
  const value = adult && available.length >= 2 ? Math.round(available.reduce((sum, domain) => sum + domain.score!, 0) / available.length) : null;
  const priority = { urgent: 0, high: 1, medium: 2, routine: 3, data: 4 };
  actions.sort((a, b) => priority[a.priority] - priority[b.priority]);
  const presentedActions = mode === 'historical' ? actions.map(action => ({
    ...action,
    title: `Historical example: ${action.title}`,
    description: action.domainId === 'blood-pressure' && domains.find(domain => domain.id === 'blood-pressure')?.score === 10
      ? `Historical discussion for the record dated ${now.toISOString().slice(0, 10)}: this very high recorded value would have called for clinical review at that time. It does not establish your current blood pressure.`
      : `At the record date (${now.toISOString().slice(0, 10)}), the sample discussion topic was: “${action.description}” This is a historical example, not current-care advice.`,
  })) : actions;
  return {
    version: 'smart-flint-health-snapshot/1.1.0', mode, assessedAt: now.toISOString(),
    patient: { id: snapshot.patient.id ?? '', displayName: displayName(snapshot), ...(age === undefined ? {} : { age }) },
    score: {
      value, label: value === null ? 'Insufficient data' : mode === 'historical' ? 'Historical educational snapshot' : 'Illustrative health snapshot',
      coveragePercent: Math.round(available.length / domains.length * 100), availableDomains: available.length, totalDomains: domains.length,
      explanation: `${mode === 'historical' ? `Historical educational view at ${now.toISOString().slice(0, 10)}, not current health. ` : ''}Unvalidated educational score: an equal-weight average of available domain points, calculated only with at least two recent interpretable adult domains. Missing, stale, and unsupported data are excluded, never treated as healthy. Points and weights are sample design choices, not a clinical risk scale.`,
    },
    domains, actions: presentedActions, notices: [...new Set(notices)],
    evidence: [
      { title: 'American Heart Association: blood pressure categories', url: SOURCES.bp },
      { title: 'American Heart Association: low blood pressure', url: SOURCES.lowBp },
      { title: 'CDC: understanding A1C', url: SOURCES.a1c },
      { title: 'NIDDK: confirming an A1C diagnosis', url: SOURCES.confirmation },
      { title: 'CDC: adult BMI as a screening measure', url: SOURCES.bmi },
      { title: 'CDC: support for quitting smoking', url: SOURCES.tobacco },
      { title: 'LOINC: legacy systolic and diastolic BP grouping code', url: 'https://loinc.org/55284-4/' },
    ],
  };
}

function scoreBloodPressure(domain: AssessmentDomain, record: DatedObservation, now: Date, actions: HealthAction[], allowUrgency: boolean) {
  const systolicComponents = record.observation.component?.filter(component => hasCode(component.code, ['8480-6'])) ?? [];
  const diastolicComponents = record.observation.component?.filter(component => hasCode(component.code, ['8462-4'])) ?? [];
  const systolic = systolicComponents.length === 1 ? quantity(systolicComponents[0]!.valueQuantity, 'mm[Hg]') : undefined;
  const diastolic = diastolicComponents.length === 1 ? quantity(diastolicComponents[0]!.valueQuantity, 'mm[Hg]') : undefined;
  if (systolic === undefined || diastolic === undefined || systolic <= 0 || diastolic <= 0 || systolic <= diastolic) {
    unsupported(domain, actions, 'A paired systolic/diastolic panel with exact positive mm[Hg] quantities is required.');
    return;
  }
  domain.value = `${measurementNumber.format(systolic)}/${measurementNumber.format(diastolic)} mmHg`;
  if (systolic > 180 || diastolic > 120) {
    domain.status = 'priority'; domain.score = 10;
    domain.explanation = 'The recorded value is in the severe high blood pressure range.';
    const recent = allowUrgency && record.precise && now.getTime() - record.time <= DAY;
    addAction(domain, actions, recent ? 'urgent' : 'high', recent ? 'Recheck this very high blood pressure now' : 'Review this past very high blood pressure', recent
      ? 'Wait one minute and repeat the reading. If it remains very high with chest pain, breathlessness, back pain, numbness, weakness, vision change, or trouble speaking, seek emergency help (911 in the US). Without concerning symptoms, contact your clinician promptly.'
      : 'This past result does not establish your current blood pressure. Contact your care team to review it and arrange a repeat measurement.');
  } else if (systolic >= 140 || diastolic >= 90) {
    domain.status = 'priority'; domain.score = 45; domain.explanation = 'The recorded value is in the stage 2 range; a clinician must confirm a diagnosis.';
    addAction(domain, actions, 'high', 'Review your blood pressure with your care team', 'Ask about repeat measurements and a personal follow-up plan.');
  } else if (systolic >= 130 || diastolic >= 80) {
    domain.status = 'review'; domain.score = 70; domain.explanation = 'The recorded value is in the stage 1 range.';
    addAction(domain, actions, 'medium', 'Plan a blood pressure follow-up', 'Discuss this result and repeat measurements with your care team.');
  } else if (systolic < 90 || diastolic < 60) {
    domain.status = 'review'; domain.score = 70; domain.sourceUrl = SOURCES.lowBp;
    domain.explanation = 'This is a low reading; symptoms and your usual blood pressure matter.';
    addAction(domain, actions, 'medium', 'Discuss a low blood pressure reading', 'If you feel dizzy, faint, or unwell, contact your care team. A single low reading may be normal for some people.');
  } else if (systolic >= 120) {
    domain.status = 'review'; domain.score = 85; domain.explanation = 'The recorded value is in the elevated range.';
    addAction(domain, actions, 'medium', 'Keep track of your blood pressure', 'Review heart-healthy habits and a suitable measurement schedule with your care team.');
  } else {
    domain.status = 'optimal'; domain.score = 100; domain.explanation = 'This recorded reading is in the usual normal adult range.';
    addAction(domain, actions, 'routine', 'Keep your blood pressure review up to date', 'Continue the habits and follow-up plan agreed with your care team.');
  }
}

function emptyDomain(id: DomainId): AssessmentDomain {
  const config = DOMAIN_CONFIG[id];
  return { id, title: config.title, status: 'unknown', score: null, value: 'No interpretable record', explanation: 'No usable recent record was found.', sourceUrl: config.sourceUrl };
}

function scoreDomain(domain: AssessmentDomain, record: DatedObservation, now: Date, actions: HealthAction[], allowUrgency: boolean) {
  if (domain.id === 'blood-pressure') scoreBloodPressure(domain, record, now, actions, allowUrgency);
  else if (domain.id === 'a1c') scoreA1c(domain, record, actions);
  else if (domain.id === 'bmi') scoreBmi(domain, record, actions);
  else scoreTobacco(domain, record, actions);
}

function assessmentDate(value?: string | Date): Date {
  const date = value instanceof Date ? new Date(value) : new Date(value ?? Date.now());
  if (!Number.isFinite(date.getTime())) throw new Error('A valid assessment date is required.');
  return date;
}

function collectObservations(snapshot: PatientSnapshot, now: Date): { eligible: DatedObservation[]; exclusions: Map<FhirObservation, ExclusionReason>; invalidNamespace: boolean } {
  let base: URL | undefined;
  let invalidNamespace = false;
  if (snapshot.fhirBaseUrl) {
    try { base = normalizedBase(snapshot.fhirBaseUrl); }
    catch { invalidNamespace = true; }
  }
  const eligible: DatedObservation[] = [];
  const exclusions = new Map<FhirObservation, ExclusionReason>();
  for (const observation of snapshot.observations) {
    let reason: ExclusionReason | undefined;
    if (!snapshot.patient.id || !observationMatchesPatient(observation, snapshot.patient.id, base)) reason = 'patient subject mismatch';
    else if (!['final', 'amended', 'corrected'].includes(observation.status ?? '')) reason = 'non-final status';
    const measuredAt = observation.effectiveDateTime ?? observation.effectivePeriod?.start;
    const parsed = parseMeasurementDate(measuredAt);
    if (!reason && !parsed) reason = 'missing or invalid measurement date';
    if (!reason && parsed!.time > now.getTime()) reason = 'future measurement date';
    if (!reason && observation.effectivePeriod?.end) {
      const end = parseMeasurementDate(observation.effectivePeriod.end);
      if (!end || end.time < parsed!.time) reason = 'missing or invalid measurement date';
      else if (end.time > now.getTime()) reason = 'future measurement date';
    }
    if (reason) exclusions.set(observation, reason);
    else eligible.push({ observation, measuredAt: measuredAt!, ...parsed! });
  }
  eligible.sort((a, b) => b.time - a.time);
  return { eligible, exclusions, invalidNamespace };
}

function scoreA1c(domain: AssessmentDomain, record: DatedObservation, actions: HealthAction[]) {
  const value = quantity(record.observation.valueQuantity, '%');
  if (value === undefined || value <= 0 || value > 100) { unsupported(domain, actions, 'An exact A1C percentage is required; other units and comparator values are not converted.'); return; }
  domain.value = `${measurementNumber.format(value)}%`;
  if (value >= 6.5) {
    domain.status = 'priority'; domain.score = 45;
    domain.explanation = 'This is in a range that warrants clinical review. It does not establish a new diagnosis or determine control in known diabetes.';
    addAction(domain, actions, 'high', 'Review your A1C and personal target', 'Ask your clinician whether confirmation is needed. If you already live with diabetes, discuss your individual target rather than using this sample’s points.');
  } else if (value >= 5.7) {
    domain.status = 'review'; domain.score = 75; domain.explanation = 'This is in the increased-risk A1C range used for screening.';
    addAction(domain, actions, 'medium', 'Discuss a sustainable blood sugar plan', 'Ask your care team about practical food and activity changes and whether follow-up testing is appropriate.');
  } else {
    domain.status = 'optimal'; domain.score = 100; domain.explanation = 'This is below the usual increased-risk screening threshold; A1C alone does not describe all blood sugar health.';
    addAction(domain, actions, 'routine', 'Ask when your next blood sugar review is due', 'Your care team can set a schedule based on your history and risk factors.');
  }
}

function scoreBmi(domain: AssessmentDomain, record: DatedObservation, actions: HealthAction[]) {
  const value = quantity(record.observation.valueQuantity, 'kg/m2');
  if (value === undefined || value <= 0) { unsupported(domain, actions, 'An exact BMI quantity in kg/m2 is required.'); return; }
  domain.value = `${measurementNumber.format(value)} kg/m²`;
  if (value < 18.5) {
    domain.status = 'review'; domain.score = 65; domain.explanation = 'This is in the underweight adult screening category. BMI needs clinical context.';
    addAction(domain, actions, 'medium', 'Discuss nourishment and your weight history', 'Ask your care team whether nutrition support or a review of recent weight changes would help.');
  } else if (value < 25) {
    domain.status = 'optimal'; domain.score = 100; domain.explanation = 'This is in the usual healthy-weight adult screening category.';
    addAction(domain, actions, 'routine', 'Support habits that work for you', 'Review nutrition, activity, and other health indicators with your care team; BMI is only one measure.');
  } else {
    domain.status = 'review'; domain.score = value < 30 ? 80 : 60;
    domain.explanation = `This is in the adult ${value < 30 ? 'overweight' : 'obesity'} screening category. BMI alone is not a health assessment.`;
    addAction(domain, actions, 'medium', 'Put BMI in the context of your health', 'Discuss your goals, nutrition, activity, and other health measures with your care team.');
  }
}

function scoreTobacco(domain: AssessmentDomain, record: DatedObservation, actions: HealthAction[]) {
  const statuses = new Set(record.observation.valueCodeableConcept?.coding
    ?.filter(coding => coding.system === 'http://snomed.info/sct')
    .map(coding => {
      if (['449868002', '428041000124106', '428071000124103', '428061000124105'].includes(coding.code ?? '')) return 'current';
      if (coding.code === '8517006') return 'former';
      if (coding.code === '266919005') return 'never';
      return 'unknown';
    }) ?? []);
  if (statuses.size !== 1 || statuses.has('unknown')) {
    domain.status = 'unknown'; domain.explanation = 'The coded smoking status is unknown, unsupported, or contradictory.';
    addDataAction(domain, actions, 'Confirm your smoking status'); return;
  }
  if (statuses.has('current')) {
    domain.value = 'Current smoker'; domain.status = 'priority'; domain.score = 30;
    domain.explanation = 'The record reports current smoking.';
    addAction(domain, actions, 'high', 'Explore support to stop smoking', 'If you are ready, ask your care team about counseling and treatment options. Support can make quitting easier.');
  } else {
    domain.value = statuses.has('former') ? 'Former smoker' : 'Never smoked'; domain.status = 'optimal'; domain.score = 100;
    domain.explanation = 'The record reports no current smoking. It does not describe every nicotine product or past exposure.';
    addAction(domain, actions, 'routine', statuses.has('former') ? 'Protect the progress you have made' : 'Keep your smoke-free habits', 'Ask for support if avoiding or staying away from smoking becomes difficult.');
  }
}

function hasCode(concept: FhirCodeableConcept | undefined, codes: string[]): boolean {
  return concept?.coding?.some(coding => coding.system === LOINC && codes.includes(coding.code ?? '')) ?? false;
}

function quantity(value: FhirQuantity | undefined, code: string): number | undefined {
  if (!value || value.comparator !== undefined || typeof value.value !== 'number' || !Number.isFinite(value.value)) return undefined;
  // Explicit UCUM codes are authoritative. A contradictory system or code never falls back to display text.
  if (value.system !== undefined && value.system !== UCUM) return undefined;
  if (value.code !== undefined) return value.code === code ? value.value : undefined;
  const allowedDisplay = code === 'mm[Hg]' ? ['mm[Hg]', 'mmHg'] : code === 'kg/m2' ? ['kg/m2', 'kg/m²'] : ['%'];
  return value.system === undefined && allowedDisplay.includes(value.unit ?? '') ? value.value : undefined;
}

function unsupported(domain: AssessmentDomain, actions: HealthAction[], explanation: string) {
  domain.status = 'unsupported'; domain.explanation = explanation;
  addDataAction(domain, actions, 'Review an unsupported record format');
}

function addDataAction(domain: AssessmentDomain, actions: HealthAction[], title: string) {
  addAction(domain, actions, 'data', title, 'Ask your care team which records are relevant and whether the source data should be updated.');
}

function addAction(domain: AssessmentDomain, actions: HealthAction[], priority: HealthAction['priority'], title: string, description: string) {
  actions.push({ id: `${domain.id}-${priority}`, title, description, priority, domainId: domain.id,
    reason: `${domain.value}. ${domain.explanation}`, sourceUrl: domain.sourceUrl, ...(domain.reference ? { observationRef: domain.reference } : {}) });
}

function fullDateAge(birthDate: string | undefined, now: Date): number | undefined {
  if (!birthDate || !validCalendarDate(birthDate)) return undefined;
  const [year, month, day] = birthDate.split('-').map(Number) as [number, number, number];
  let age = now.getUTCFullYear() - year;
  if (now.getUTCMonth() + 1 < month || (now.getUTCMonth() + 1 === month && now.getUTCDate() < day)) age--;
  return age >= 0 ? age : undefined;
}

function validCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function parseMeasurementDate(value: string | undefined): { time: number; precise: boolean } | undefined {
  if (!value || !validCalendarDate(value.slice(0, 10))) return undefined;
  if (value.length === 10) return { time: Date.parse(`${value}T00:00:00Z`), precise: false };
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? { time, precise: true } : undefined;
}

function displayName(snapshot: PatientSnapshot): string {
  const name = snapshot.patient.name?.find(item => item.use === 'official') ?? snapshot.patient.name?.[0];
  return name?.text || [...(name?.given ?? []), name?.family].filter(Boolean).join(' ') || 'Patient';
}
