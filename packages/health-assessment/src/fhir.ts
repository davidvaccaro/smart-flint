import type { FhirObservation, FhirPatient, PatientSnapshot, ReadPatientSnapshotOptions } from './types.js';

/** A deliberately body-free error: upstream responses can contain health data or secrets. */
export class FHIRReadError extends Error {
  constructor(public readonly code: string, message: string, public readonly status?: number) {
    super(message);
    this.name = 'FHIRReadError';
  }
}

export function normalizedBase(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new FHIRReadError('invalid_base', 'A valid absolute FHIR base URL is required.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || /%2f|%5c/i.test(url.pathname)) {
    throw new FHIRReadError('invalid_base', 'The FHIR base must be an HTTP(S) URL without credentials, query, or fragment.');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url;
}

export function withinBase(url: URL, base: URL): boolean {
  const prefix = base.pathname.replace(/\/+$/, '');
  return url.origin === base.origin && !url.username && !url.password && !url.hash
    && !/%2f|%5c/i.test(url.pathname)
    && (url.pathname === prefix || url.pathname.startsWith(`${prefix}/`));
}

export function patientIdFromReference(reference: string, base?: URL): string | undefined {
  let relative = reference;
  if (/^https?:\/\//i.test(reference)) {
    if (!base) return undefined;
    let absolute: URL;
    try { absolute = new URL(reference); } catch { return undefined; }
    if (!withinBase(absolute, base) || absolute.search) return undefined;
    relative = absolute.pathname.slice(base.pathname.replace(/\/+$/, '').length + 1);
  }
  const match = /^(?:Patient\/)?([A-Za-z0-9.-]{1,64})$/.exec(relative);
  return match?.[1];
}

export function observationMatchesPatient(observation: FhirObservation, patientId: string, base?: URL): boolean {
  const reference = observation.subject?.reference;
  // Bare logical ids are accepted for the reader input, but are not FHIR patient references.
  if (!reference || (!reference.startsWith('Patient/') && !/^https?:\/\//i.test(reference))) return false;
  return patientIdFromReference(reference, base) === patientId;
}

export async function readPatientSnapshot(options: ReadPatientSnapshotOptions): Promise<PatientSnapshot> {
  const base = normalizedBase(options.baseUrl);
  if (base.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) {
    throw new FHIRReadError('insecure_base', 'FHIR requests require HTTPS except for loopback development servers.');
  }
  const subjectBase = options.subjectBaseUrl ? normalizedBase(options.subjectBaseUrl) : base;
  const baseString = base.toString().replace(/\/$/, '');
  const parsedPatientId = patientIdFromReference(options.patientReference, subjectBase);
  if (!parsedPatientId) throw new FHIRReadError('invalid_patient', 'The patient reference must identify a Patient within this FHIR base.');
  const patientId = parsedPatientId;
  const request = options.fetch ?? globalThis.fetch;
  const maxPages = Math.max(1, Math.min(20, Math.floor(options.maxPages ?? 5) || 1));
  const issues: PatientSnapshot['issues'] = [];

  async function read(url: URL): Promise<unknown> {
    if (!withinBase(url, base)) throw new FHIRReadError('unsafe_link', 'A FHIR paging link left the authorized base.');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await request(url.toString(), {
        headers: { Accept: 'application/fhir+json, application/json', Authorization: await options.getAuthorizationHeader() },
        redirect: 'error', cache: 'no-store', credentials: 'omit', signal: controller.signal,
      });
      if (!response.ok) throw new FHIRReadError('http_error', 'The FHIR server declined the request.', response.status);
      const limit = 5 * 1024 * 1024;
      if (Number(response.headers.get('content-length')) > limit) {
        await response.body?.cancel();
        throw new FHIRReadError('response_too_large', 'The FHIR response exceeded the sample reader’s size limit.');
      }
      if (!response.body) throw new FHIRReadError('invalid_json', 'The FHIR server returned an empty response.');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let size = 0;
      let body = '';
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > limit) {
            await reader.cancel();
            throw new FHIRReadError('response_too_large', 'The FHIR response exceeded the sample reader’s size limit.');
          }
          body += decoder.decode(chunk.value, { stream: true });
        }
        body += decoder.decode();
      } finally { reader.releaseLock(); }
      try { return JSON.parse(body); }
      catch { throw new FHIRReadError('invalid_json', 'The FHIR server returned an unreadable response.'); }
    } catch (error) {
      if (error instanceof FHIRReadError) throw error;
      if (controller.signal.aborted) throw new FHIRReadError('request_timeout', 'The FHIR request exceeded the sample reader’s time limit.');
      throw new FHIRReadError('network_error', 'The FHIR request could not be completed.');
    } finally { clearTimeout(timeout); }
  }

  const patient = await read(new URL(`${baseString}/Patient/${patientId}`));
  if (!isRecord(patient) || patient.resourceType !== 'Patient' || patient.id !== patientId) {
    throw new FHIRReadError('patient_mismatch', 'The FHIR response did not match the requested patient.');
  }
  const observations: FhirObservation[] = [];
  const observationIds = new Set<string>();
  async function searchObservations(parameter: 'category' | 'code', value: string): Promise<void> {
    let next: URL | undefined = new URL(`${baseString}/Observation`);
    next.searchParams.set('patient', patientId);
    next.searchParams.set(parameter, value);
    next.searchParams.set('_count', '100');
    const visited = new Set<string>();
    let page = 0;
    while (next && page < maxPages) {
      const current: URL = next;
      if (!withinBase(current, base)) {
        issues.push({ code: 'unsafe_paging_link', message: 'Observation paging stopped because a link left the authorized FHIR base.' });
        break;
      }
      if (visited.has(current.toString())) {
        issues.push({ code: 'paging_cycle', message: 'Observation paging stopped at a repeated link.' });
        break;
      }
      visited.add(current.toString());
      let bundle: unknown;
      try { bundle = await read(current); }
      catch (error) {
        const status = error instanceof FHIRReadError ? error.status : undefined;
        issues.push({ code: status === 401 || status === 403 ? 'observations_access_denied' : 'observations_unavailable', message: 'Some observation data could not be read; the assessment uses only the records actually received.' });
        break;
      }
      if (!isRecord(bundle) || bundle.resourceType !== 'Bundle' || (bundle.entry !== undefined && !Array.isArray(bundle.entry))) {
        issues.push({ code: 'invalid_bundle', message: 'The observation search did not return a usable FHIR Bundle.' });
        break;
      }
      for (const entry of (bundle.entry ?? []) as unknown[]) {
        if (!isRecord(entry) || !isRecord(entry.resource) || entry.resource.resourceType !== 'Observation') continue;
        const observation = entry.resource as unknown as FhirObservation;
        if (!observationMatchesPatient(observation, patientId, subjectBase)) {
          issues.push({ code: 'observation_patient_mismatch', message: 'An observation without the expected patient subject was excluded.' });
        } else if (!observation.id || !observationIds.has(observation.id)) {
          observations.push(observation);
          if (observation.id) observationIds.add(observation.id);
        }
      }
      page += 1;
      next = undefined;
      if (Array.isArray(bundle.link)) {
        const link = bundle.link.find((item: unknown) => isRecord(item) && item.relation === 'next');
        if (isRecord(link) && typeof link.url === 'string') {
          try { next = new URL(link.url, current); }
          catch { issues.push({ code: 'invalid_paging_link', message: 'Observation paging stopped at an invalid link.' }); }
        }
      }
    }
    if (next && page >= maxPages) issues.push({ code: 'page_limit', message: 'The configured observation page limit was reached; records may be incomplete.' });
  }
  // Epic requires a code or category. Separate standard category searches also
  // keep a large lab history from consuming the vital-sign/smoking page budget.
  for (const category of ['vital-signs', 'laboratory', 'social-history']) await searchObservations('category', category);
  const receivedSmokingStatus = observations.some(observation => Array.isArray(observation.code?.coding)
    && observation.code.coding.some(coding => coding?.system === 'http://loinc.org' && coding?.code === '72166-2'));
  // Older synthetic records may categorize smoking status as survey. A precise
  // code search recovers those records without broadening an incomplete read or
  // replacing a received smoking result whose value cannot be interpreted.
  if (issues.length === 0 && !receivedSmokingStatus) await searchObservations('code', 'http://loinc.org|72166-2');
  return { patient: patient as unknown as FhirPatient, observations, issues, loadedAt: new Date().toISOString(), fhirBaseUrl: subjectBase.toString().replace(/\/$/, '') };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
