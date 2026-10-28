import { buildHealthCDS } from './app.js';
import { loadCDSConfig } from './config.js';

const config = loadCDSConfig();
const app = await buildHealthCDS({ config });
await app.listen({ host: config.host, port: config.port });
process.stdout.write(`Health Compass CDS handler ready at http://${config.host}:${config.port}\n`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void app.close().then(() => process.exit(0)); });
}
