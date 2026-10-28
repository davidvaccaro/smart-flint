import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { packageNodeSDKs, sdkRoot } from './package-sdks.mjs';

const temporary = await mkdtemp(join(tmpdir(), 'smart-flint-sdk-artifacts-'));
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(result.status, 0, `${command} ${args[0]} failed:\n${result.stderr}\n${result.stdout}`);
}
try {
  const artifacts = await packageNodeSDKs(join(temporary, 'artifacts'));
  const consumer = join(temporary, 'consumer');
  await mkdir(consumer);
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: 'independent-smart-flint-consumer', private: true, type: 'module', dependencies: Object.fromEntries(artifacts.map(item => [item.name, `file:${item.filename}`])) }));
  run('npm', ['install', '--ignore-scripts', '--offline', '--no-audit', '--no-fund'], consumer);
  await writeFile(join(consumer, 'consumer.mts'), `import { SMARTFlintClient, createPKCE, type FHIRConnection } from '@smart-flint/sdk';
import type { ActivationDescriptor } from '@smart-flint/contracts';
const flint: SMARTFlintClient = new SMARTFlintClient({ baseUrl: 'https://flint.example' });
const activation = {} as ActivationDescriptor;
const connection: Promise<FHIRConnection> = flint.session(activation.id, 'synthetic-session').getFHIRConnection();
void connection; void createPKCE;
`);
  await writeFile(join(consumer, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', lib: ['ES2023', 'DOM', 'DOM.Iterable'], strict: true, skipLibCheck: false, noEmit: true, types: [] }, include: ['consumer.mts'] }));
  run(process.execPath, [resolve(sdkRoot, 'node_modules/typescript/bin/tsc'), '--project', 'tsconfig.json'], consumer);
  await writeFile(join(consumer, 'smoke.mjs'), `import assert from 'node:assert/strict';
import { SMARTFlintClient, createPKCE } from '@smart-flint/sdk';
const origin = 'https://flint.example';
const descriptor = { id:'act-artifact', mode:'gateway', context:{ patient:{ reference:'Patient/synthetic' } }, upstream:{ baseUrl:'https://ehr.example/fhir', fhirVersion:'4.0.1' }, gateway:{ baseUrl:origin+'/fhir/act-artifact' } };
let directRead = 0;
const flint = new SMARTFlintClient({baseUrl:origin, fetch:async (url, init) => {
  assert.equal(new URL(url).origin, origin);
  assert.equal(init.redirect, 'error');
  const path = new URL(url).pathname;
  let result;
  if (path === '/api/launches') {
    const request = JSON.parse(init.body); assert.equal(request.installationId,'inst-artifact'); assert.equal(request.codeChallenge.length,43);
    result = {launchUrl:origin+'/launch/synthetic',expiresAt:'2099-01-01T00:00:00Z',applicationId:'app-artifact'};
  } else if (path === '/api/activations/redeem') {
    assert.equal(JSON.parse(init.body).applicationId,'app-artifact'); result={activation:descriptor,sessionToken:'local-synthetic'};
  } else {
    assert.equal(new Headers(init.headers).get('Authorization'),'Bearer local-synthetic');
    if (path.endsWith('/credentials/original')) result={tokenResponse:{access_token:'original-synthetic'},refreshOwner:'bridge',refreshTokenWithheld:true};
    else if (path.endsWith('/credentials')) result={baseUrl:'https://ehr.example/fhir',accessToken:'upstream-synthetic-'+(++directRead),tokenType:'Bearer',grantedScopes:[],refreshOwner:'bridge'};
    else if (init.method === 'DELETE') return new Response(null,{status:204});
    else result=descriptor;
  }
  return Response.json(result);
}});
const pkce=await createPKCE();
const launch=await flint.start({installationId:'inst-artifact',redirectUri:'https://app.example/callback',codeChallenge:pkce.codeChallenge,state:pkce.state});
const redeemed=await flint.redeem({applicationId:launch.applicationId,code:'synthetic-code',codeVerifier:pkce.codeVerifier,redirectUri:'https://app.example/callback'});
const session=flint.session(redeemed.activation.id,redeemed.sessionToken);
const gateway=await session.getFHIRConnection({route:'gateway'});
assert.equal(await gateway.credentials.getAuthorizationHeader(),'Bearer local-synthetic');
const direct=await session.getFHIRConnection({route:'direct'});
assert.equal(direct.baseUrl,'https://ehr.example/fhir');
assert.equal(await direct.credentials.getAuthorizationHeader(),'Bearer upstream-synthetic-1');
assert.equal(await direct.credentials.getAccessToken(),'upstream-synthetic-2');
assert.equal((await session.credentials.original()).tokenResponse.access_token,'original-synthetic');
assert.equal(JSON.stringify(session).includes('local-synthetic'),false);
await session.close();
`);
  run(process.execPath, ['smoke.mjs'], consumer);
  process.stdout.write('Standalone SDK artifacts passed: offline npm tarball installation outside the monorepo, native ESM import, TypeScript declarations, PKCE, activation redemption, ordinary FHIR connection credentials, lazy renewal, original-token access and credential-safe serialization.\n');
} finally { await rm(temporary, { recursive: true, force: true }); }
