import { SMARTFlintClient, type ActivatedSession, type ActivationDescriptor, type AccessMode } from '@smart-flint/sdk';
import { assessHealth, readPatientSnapshot, type PatientSnapshot } from '@smart-flint/health-assessment';

/** The SDK only handles activation. FHIR reads below use ordinary fetch. */
export const bridgeUrl = import.meta.env.VITE_SMART_FLINT_URL || 'http://127.0.0.1:3001';
export const configuredInstallation = import.meta.env.VITE_INSTALLATION_ID || '';
export const client = new SMARTFlintClient({ baseUrl: bridgeUrl });

export interface PatientSession {
  session: ActivatedSession;
  activation: ActivationDescriptor;
}

/** Only launch PKCE/state lives in sessionStorage; session credentials stay in memory. */
export async function startPatientLaunch(installationId: string, mode: AccessMode): Promise<void> {
  const launch = await client.start({
    installationId,
    redirectUri: `${window.location.origin}/callback`,
    mode,
  });
  window.location.assign(launch.launchUrl);
}

let callbackCompletion: Promise<PatientSession | null> | undefined;

/** Release the completed callback's session reference when the user disconnects. */
export function forgetCompletedLaunch(): void {
  callbackCompletion = undefined;
}

/** Cache the one-use callback promise so component remounts cannot redeem it twice. */
export function completePatientLaunch(): Promise<PatientSession | null> {
  callbackCompletion ??= (async () => {
    const params = new URL(window.location.href).searchParams;
    if (params.has('smart_flint_launch')) {
      const launch = await client.resumeEHRLaunch();
      window.location.assign(launch.launchUrl);
      return null;
    }
    if (!params.has('code') && !params.has('error')) return null;
    const result = await client.completeRedirect();
    return {
      session: client.session(result.activation.id, result.sessionToken),
      activation: result.activation,
    };
  })();
  return callbackCompletion;
}

/** Replace this standard HTTP reader with your preferred FHIR client if desired. */
export async function loadPatientSnapshot(
  connection: PatientSession,
  route: 'gateway' | 'direct',
  signal?: AbortSignal,
): Promise<PatientSnapshot> {
  const patientReference = connection.activation.context.patient?.reference;
  if (!patientReference) throw new Error('This launch did not include a patient. Relaunch from a patient context or select a patient in the authorization screen.');
  const fhir = await connection.session.getFHIRConnection({ route });
  if (signal?.aborted) throw new DOMException('Request aborted', 'AbortError');
  const snapshot = await readPatientSnapshot({
    baseUrl: fhir.baseUrl,
    subjectBaseUrl: connection.activation.upstream.baseUrl,
    getAuthorizationHeader: () => fhir.credentials.getAuthorizationHeader(),
    patientReference,
    fetch: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, {
      ...init,
      cache: 'no-store',
      credentials: 'omit',
      // Preserve the reader's timeout while allowing refresh/disconnect to cancel.
      signal: signal && init?.signal ? AbortSignal.any([signal, init.signal]) : signal ?? init?.signal,
    }),
  });
  if (signal?.aborted) throw new DOMException('Request aborted', 'AbortError');
  return snapshot;
}

/** The default view always interprets freshness against the current date. */
export async function loadPatientAssessment(
  connection: PatientSession,
  route: 'gateway' | 'direct',
  signal?: AbortSignal,
) {
  return assessHealth(await loadPatientSnapshot(connection, route, signal));
}
