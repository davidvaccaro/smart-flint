import { buildMockEHR } from './app.js';

const port = Number(process.env.MOCK_EHR_PORT ?? 4010);
const host = process.env.MOCK_EHR_HOST ?? '127.0.0.1';
const app = await buildMockEHR();
await app.listen({ port, host });
process.stdout.write(`Synthetic EHR ready at http://${host === '0.0.0.0' ? 'localhost' : host}:${port} (fictional data only)\n`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void app.close().then(() => process.exit(0)); });
}
