import { buildHealthFHIRService } from './app.js';
import { loadServiceConfig } from './config.js';

const config = loadServiceConfig();
const app = await buildHealthFHIRService({ config });
await app.listen({ host: config.host, port: config.port });
process.stdout.write(`Health Compass backend FHIR sample ready at http://${config.host}:${config.port}\n`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void app.close().then(() => process.exit(0)); });
}
