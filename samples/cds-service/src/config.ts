export const DEMO_CDS_HANDLER_TOKEN = 'demo-health-cds-handler';
export const DEMO_FHIR_BASE_URLS = [
  'http://127.0.0.1:4010/epic/northstar/r4',
  'http://127.0.0.1:4010/epic/harbor/r4',
  'http://127.0.0.1:4010/oracle/lakeside/r4',
  'http://127.0.0.1:4010/meditech/cedar/r4',
];

export interface HealthCDSConfig {
  production: boolean;
  host: string;
  port: number;
  handlerToken: string;
  fhirBaseUrls: string[];
  smartAppLaunchUrl?: string;
}

export function isLoopback(address: string): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/** Only deployment configuration can authorize an upstream origin. Hook input cannot. */
export function normalizeFHIRBase(value: string, production: boolean): string {
  const url = new URL(value);
  const localHTTP = !production && url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !localHTTP) || url.username || url.password || url.search || url.hash) {
    throw new Error('FHIR_BASE_URLS must contain HTTPS FHIR bases (loopback HTTP is allowed during development).');
  }
  return url.href.replace(/\/$/, '');
}

export function loadCDSConfig(overrides: Partial<HealthCDSConfig> = {}, env = process.env): HealthCDSConfig {
  const production = overrides.production ?? env.NODE_ENV === 'production';
  const handlerToken = overrides.handlerToken ?? env.CDS_HANDLER_TOKEN ?? (production ? '' : DEMO_CDS_HANDLER_TOKEN);
  const host = overrides.host ?? env.CDS_SAMPLE_HOST ?? '127.0.0.1';
  if (!handlerToken || (production && (handlerToken.length < 32 || handlerToken === DEMO_CDS_HANDLER_TOKEN))) {
    throw new Error('Production CDS_HANDLER_TOKEN must be a unique secret of at least 32 characters.');
  }
  if (handlerToken === DEMO_CDS_HANDLER_TOKEN && !isLoopback(host)) {
    throw new Error('The development CDS handler token requires a loopback listener.');
  }
  const bases = overrides.fhirBaseUrls ?? (env.FHIR_BASE_URLS?.split(',').map(value => value.trim()).filter(Boolean))
    ?? (production ? [] : DEMO_FHIR_BASE_URLS);
  const smartAppLaunchUrl = overrides.smartAppLaunchUrl ?? env.SMART_APP_LAUNCH_URL;
  if (smartAppLaunchUrl) {
    const url = new URL(smartAppLaunchUrl);
    const localHTTP = !production && url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !localHTTP) || url.username || url.password || url.hash) {
      throw new Error('SMART_APP_LAUNCH_URL requires HTTPS outside loopback development, without credentials or a fragment.');
    }
  }
  const port = overrides.port ?? Number(env.CDS_SAMPLE_PORT ?? 4101);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('CDS_SAMPLE_PORT must be a valid TCP port.');
  return { production, host, port, handlerToken, fhirBaseUrls: bases.map(value => normalizeFHIRBase(value, production)), smartAppLaunchUrl };
}
