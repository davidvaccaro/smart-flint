import { DEMO_SERVICE_TOKEN } from './config.js';

const args = process.argv.slice(2);
const value = (flag: string) => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
const serviceUrl = new URL(process.env.SAMPLE_SERVICE_URL ?? 'http://127.0.0.1:4102');
const local = ['127.0.0.1', '[::1]', 'localhost'].includes(serviceUrl.hostname);
if (serviceUrl.username || serviceUrl.password || serviceUrl.search || serviceUrl.hash
  || (serviceUrl.protocol !== 'https:' && !(process.env.NODE_ENV !== 'production' && local && serviceUrl.protocol === 'http:'))) {
  throw new Error('SAMPLE_SERVICE_URL requires HTTPS outside loopback development.');
}
const callerToken = process.env.SAMPLE_SERVICE_TOKEN ?? (process.env.NODE_ENV !== 'production' && local ? DEMO_SERVICE_TOKEN : '');
if (!callerToken || (callerToken === DEMO_SERVICE_TOKEN && (!local || process.env.NODE_ENV === 'production'))) {
  throw new Error('Set SAMPLE_SERVICE_TOKEN for this deployment.');
}
const route = value('--route') ?? 'gateway';
if (!['gateway', 'direct'].includes(route)) throw new Error('--route must be gateway or direct.');
const response = await fetch(`${serviceUrl.href.replace(/\/$/, '')}/assessments`, {
  method: 'POST', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(120_000),
  headers: { Authorization: `Bearer ${callerToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    installationId: value('--installation') ?? 'inst_health_service_northstar',
    ...(value('--patient') ? { patientId: value('--patient') } : {}), route,
  }),
});
if (!response.ok) {
  process.stderr.write(`Health review failed (HTTP ${response.status}). Check the service and SMART Flint configuration.\n`);
  process.exitCode = 1;
} else {
  const result = await response.json() as { assessments?: unknown[]; issues?: { code?: string }[] };
  // Safe for real deployments: do not print Patient identifiers, observations, scores or credentials.
  process.stdout.write(JSON.stringify({
    status: 'completed', assessedPatients: result.assessments?.length ?? 0,
    issueCodes: result.issues?.map(issue => issue.code).filter(Boolean) ?? [],
  }, null, 2) + '\n');
}
