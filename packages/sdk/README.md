# SMART Flint TypeScript SDK

Optional helpers for a versioned HTTP API. Bring any FHIR library or use `fetch` directly.

Install the matching SDK and contracts release archives into any project:

```sh
npm install ./smart-flint-contracts-0.1.0.tgz ./smart-flint-sdk-0.1.0.tgz
```

The package ships compiled ESM JavaScript and TypeScript declarations; no repository checkout or TypeScript runtime loader is required. Use a modern browser or Node.js 20+ with `fetch` and Web Crypto. Registry publication is a separate release step. See the [developer onboarding guide](../../docs/developer-onboarding.md) for registration, entry-point handling, access choices and support policy.

```ts
import { SMARTFlintClient } from '@smart-flint/sdk';

const bridge = new SMARTFlintClient({ baseUrl: 'https://flint.example.org' });
const start = await bridge.start({
  installationId: 'your-installation',
  redirectUri: 'https://app.example.org/callback',
  mode: 'gateway', // also direct or handoff, when configured
});
location.assign(start.launchUrl);
```

On the registered callback:

```ts
const { activation, sessionToken } = await bridge.completeRedirect();
const session = bridge.session(activation.id, sessionToken);
const connection = await session.getFHIRConnection({ route: 'gateway' });

const patient = await fetch(`${connection.baseUrl}/${activation.context.patient!.reference}`, {
  headers: { Authorization: await connection.credentials.getAuthorizationHeader() },
}).then(response => response.json());
```

For direct access, choose `route: 'direct'`. The credential provider obtains the current upstream token from SMART Flint each time it is called. Configure your preferred FHIR client's asynchronous authentication hook with that provider. Server-side SMART Flint policy decides whether the installation supports token export.

An incoming EHR launch first arrives at the app as `?smart_flint_launch=...`. Call `await bridge.resumeEHRLaunch()` and navigate to the returned `launchUrl`. This establishes the application's browser transaction before upstream authorization.

For original credentials use `session.credentials.original()`. Its envelope contains `tokenResponse`, `refreshOwner`, and `refreshTokenWithheld`: the original access token is preserved exactly, while the refresh token is withheld while SMART Flint owns renewal. For a supported transfer of refresh ownership use `session.credentials.handoff()`, which returns the current credential and refresh token when issued. These responses contain sensitive fields; do not print or persist them casually. Full handoff only works with a compatible upstream registration. `session.close()` closes the local activation; exported upstream credentials remain governed by upstream expiration/revocation.

## Native, server, and other runtimes

Use `createPKCE()`, store the verifier and state in your own protected transaction, and pass `codeChallenge` and `state` to `start`. After validating the callback state, call `redeem({ code, codeVerifier, applicationId, redirectUri })`. The returned session behaves identically. No browser storage is required for this explicit flow.

Browser helpers use per-tab `sessionStorage` only for short-lived PKCE transactions. Access tokens, refresh tokens, and session credentials remain in memory. `completeRedirect()` removes authorization parameters from the current browser URL. It consumes a transaction once; after an interrupted redemption, begin a fresh launch.

The SDK exports no proprietary FHIR resource model and requires no particular FHIR client. The public endpoint and bearer credential work with ordinary HTTP clients. Each session is bound to a single immutable activation, allowing independent patient contexts in separate tabs.
