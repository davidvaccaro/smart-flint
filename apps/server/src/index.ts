import { buildApp } from './app.js';
import { serviceVersion } from './version.js';

try {
  const { app, config } = await buildApp();
  await app.listen({ port: config.port, host: config.host });
  process.stdout.write(`SMART Flint ${serviceVersion} listening. Administrative and clinical credentials are omitted from operational logs.\n`);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
    void app.close().then(() => process.exit(0), () => { process.stderr.write('SMART Flint shutdown failed.\n'); process.exit(1); });
  });
} catch {
  process.stderr.write('SMART Flint startup failed. Check deployment configuration, database availability, encryption key and schema compatibility.\n');
  process.exit(1);
}
