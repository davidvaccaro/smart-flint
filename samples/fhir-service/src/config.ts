export const DEMO_SERVICE_TOKEN = 'demo-health-service-client';
export const DEMO_APPLICATION_KEY = 'demo-health-service-key';
export const DEMO_INSTALLATION_IDS = [
  'inst_health_service_northstar', 'inst_health_service_harbor', 'inst_health_service_lakeside',
  'inst_health_service_cedar',
];
const demoFHIRBases = [
  'http://127.0.0.1:4010/epic/northstar/r4',
  'http://127.0.0.1:4010/epic/harbor/r4',
  'http://127.0.0.1:4010/oracle/lakeside/r4',
  'http://127.0.0.1:4010/meditech/cedar/r4',
];

export interface HealthFHIRServiceConfig {
  production: boolean;
  host: string;
  port: number;
  callerToken: string;
  applicationKey: string;
  bridgeUrl: string;
  installationIds: string[];
  fhirBaseUrls: string[];
  maxPatients: number;
  maxPatientPages: number;
}

export function isLoopback(address: string): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

export function normalizeBase(value: string, production: boolean): string {
  const url = new URL(value);
  const localHTTP = !production && url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !localHTTP) || url.username || url.password || url.search || url.hash) {
    throw new Error('Service URLs require HTTPS outside loopback development, without credentials, queries or fragments.');
  }
  return url.href.replace(/\/$/, '');
}

export function loadServiceConfig(overrides: Partial<HealthFHIRServiceConfig> = {}, env = process.env): HealthFHIRServiceConfig {
  const production = overrides.production ?? env.NODE_ENV === 'production';
  const callerToken = overrides.callerToken ?? env.SAMPLE_SERVICE_TOKEN ?? (production ? '' : DEMO_SERVICE_TOKEN);
  const applicationKey = overrides.applicationKey ?? env.SMART_FLINT_APPLICATION_KEY ?? (production ? '' : DEMO_APPLICATION_KEY);
  const host = overrides.host ?? env.FHIR_SAMPLE_HOST ?? '127.0.0.1';
  if (!callerToken || !applicationKey || (production && (callerToken.length < 32 || applicationKey.length < 32
    || callerToken === DEMO_SERVICE_TOKEN || applicationKey === DEMO_APPLICATION_KEY || callerToken === applicationKey))) {
    throw new Error('Production SAMPLE_SERVICE_TOKEN and SMART_FLINT_APPLICATION_KEY must be distinct deployment secrets of at least 32 characters.');
  }
  if ((callerToken === DEMO_SERVICE_TOKEN || applicationKey === DEMO_APPLICATION_KEY) && !isLoopback(host)) {
    throw new Error('Development credentials require a loopback listener.');
  }
  const installationIds = overrides.installationIds
    ?? env.SAMPLE_INSTALLATION_IDS?.split(',').map(value => value.trim()).filter(Boolean)
    ?? (production ? [] : DEMO_INSTALLATION_IDS);
  if (!installationIds.length || installationIds.some(value => !/^[A-Za-z0-9_-]{1,128}$/.test(value))) {
    throw new Error('SAMPLE_INSTALLATION_IDS must explicitly list the allowed installation identifiers.');
  }
  const fhirBaseUrls = overrides.fhirBaseUrls
    ?? env.FHIR_BASE_URLS?.split(',').map(value => value.trim()).filter(Boolean)
    ?? (production ? [] : demoFHIRBases);
  const port = overrides.port ?? Number(env.FHIR_SAMPLE_PORT ?? 4102);
  const maxPatients = overrides.maxPatients ?? 20;
  const maxPatientPages = overrides.maxPatientPages ?? 2;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('FHIR_SAMPLE_PORT must be a valid TCP port.');
  if (!Number.isInteger(maxPatients) || maxPatients < 1 || maxPatients > 20) throw new Error('The sample bounds each request to at most 20 patients.');
  if (!Number.isInteger(maxPatientPages) || maxPatientPages < 1 || maxPatientPages > 5) throw new Error('Patient paging must be bounded between one and five pages.');
  return {
    production, host, port, callerToken, applicationKey,
    bridgeUrl: normalizeBase(overrides.bridgeUrl ?? env.SMART_FLINT_URL ?? 'http://127.0.0.1:3001', production),
    installationIds, fhirBaseUrls: fhirBaseUrls.map(value => normalizeBase(value, production)), maxPatients, maxPatientPages,
  };
}
