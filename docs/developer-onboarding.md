# Connect an application to SMART Flint

SMART Flint runs in your environment. Its administration sign-in is separate from the EHR patient's or clinician's SMART authorization. Register and enable your application with the EHR vendor/customer as usual; SMART Flint provides the launch/callback URLs and manages the supported connection workflow.

## Install independently of this repository

Download the SDK artifacts for the same SMART Flint release as your server. Install both matching npm archives into an ordinary JavaScript/TypeScript project:

```sh
npm install ./smart-flint-contracts-0.1.0.tgz ./smart-flint-sdk-0.1.0.tgz
```

The archives include ESM JavaScript, declarations, readable source maps, product licensing terms and third-party notices. They do not require a TypeScript loader or this monorepo at runtime. The JavaScript SDK uses browser-standard `fetch`, Web Crypto, `URL`, and `Headers`; use a modern browser or Node.js 20+. Browser transaction helpers additionally use per-tab `sessionStorage`. CommonJS applications can use dynamic `import('@smart-flint/sdk')`. The `development` package condition supplies public TypeScript source for Vite/Vitest development.

Python backend applications can install the release wheel:

```sh
python3 -m pip install ./smart_flint-0.1.0-py3-none-any.whl
```

The Python runtime requires Python 3.9+ and has no third-party runtime dependencies. A source distribution is provided for environments that build their own wheel. Published package-registry names are not assumed to be available: use the supplied release artifacts until a registry release is explicitly announced.

## Configure the integration

1. Open **Applications**, add your application's exact callback URL, required context/scopes and permitted access modes. Use HTTPS for web callbacks; use a registered platform return URI for native apps.
2. Add an integration using an EHR platform, its portal registration/client profile, an organization, and that organization's approved FHIR connection. Create the installation binding and inspect its registration worksheet.
3. Copy the worksheet's SMART Flint launch URL and OAuth callback into the matching EHR vendor registration. The OAuth callback points to SMART Flint; your application callback receives SMART Flint's one-use activation code.
4. Launch using the local synthetic EHR first. Your real EHR configuration remains a separate verification target. Review the compatibility evidence for the exact pathway before depending on it.

Do not embed an EHR client secret, SMART Flint administrative password, bootstrap token, or encryption key in the app. Backend service applications use their own provisioned application API credential, held only on a trusted backend.

## Web application entry point

Handle incoming launch and callback parameters before rendering the app's ordinary welcome/dashboard view:

```ts
import { SMARTFlintClient } from '@smart-flint/sdk';

const flint = new SMARTFlintClient({ baseUrl: 'https://flint.example.org' });
const query = new URL(location.href).searchParams;

if (query.has('smart_flint_launch')) {
  // EHR initiated: establish this application's own PKCE/browser transaction.
  const launch = await flint.resumeEHRLaunch();
  location.assign(launch.launchUrl);
} else if (query.has('code') || query.has('error')) {
  // Validates state, exact callback, expiry and single-use transaction ownership.
  const { activation, sessionToken } = await flint.completeRedirect();
  const session = flint.session(activation.id, sessionToken);
  const connection = await session.getFHIRConnection({ route: 'gateway' });
  // Give activation.context and connection to your application's startup code.
  // Retain the session only in memory or in your protected application backend.
} else {
  // Bind this to your application's Connect button for a standalone launch.
  const connect = async () => {
    const launch = await flint.start({
      installationId: 'your-installation-id',
      redirectUri: 'https://app.example.org/smart/callback',
      mode: 'gateway',
    });
    location.assign(launch.launchUrl);
  };
}
```

Handle rejected/expired launches with a fresh launch. Do not replay an old activation code or put session credentials in URLs, analytics, local storage or error reports. The built-in [Health Compass app](../samples/patient-app/README.md) shows loading, error, disconnect and EHR entry handling in a real UI.

## Use any FHIR client

`session.getFHIRConnection({ route: 'gateway' })` returns the standard FHIR base URL and a lazy authorization provider. Use it with `fetch` or configure the equivalent authorization callback in your preferred FHIR library:

```ts
const response = await fetch(`${connection.baseUrl}/Patient/${encodeURIComponent(patientId)}`, {
  headers: { Accept: 'application/fhir+json',
    Authorization: await connection.credentials.getAuthorizationHeader() },
});
```

`patientId` comes from your activation's patient context, not a global shared patient variable. The gateway implements the documented JSON read/search interactions and returns FHIR responses. It does not require a proprietary resource model.

Choose `route: 'direct'` for the upstream FHIR URL and a credential provider that retrieves current upstream access tokens from SMART Flint. Call that provider when sending requests; retaining one token forever defeats bridge-managed renewal. Browser direct access additionally depends on upstream CORS.

`session.credentials.original()` retrieves the explicit original-token envelope when installation policy permits export. `session.credentials.handoff()` transfers supported renewal ownership once. Direct access/handoff bypass gateway normalization and gateway request auditing. Confidential registrations can still require backend client authentication for independent renewal; private authentication keys are not exported. Closing a local session does not revoke an already exported upstream bearer token at the EHR.

## Backend applications and CDS Hooks

For a Python backend service, see the [Python SDK guide](../sdks/python/README.md) and [headless sample](../samples/fhir-service/README.md). Use `service_activation()` with the installation and its application API credential, then select gateway or direct FHIR access. That application credential is distinct from an activation session token.

A CDS Hooks implementation exposes the hook service API and uses the configured SMART Flint forwarding/authorization relationship. See the [CDS Hooks sample](../samples/cds-service/README.md). An inbound hook request is not an interactive browser launch; do not ask a clinician's browser to supply backend application secrets.

## Native applications

[Native examples](../examples/native/README.md) include an Apple system-browser controller plus a UIKit launch/disconnect screen, and an Android external-browser Activity with callback manifest. Both use native-owned PKCE/state and activation-bound sessions, and resume EHR launch tickets. The exact installation callback must match the platform registration and the app's configured return handler.

Native sessions and transactions are intentionally in memory. Process termination requires a fresh launch. If your application persists credentials, implement Keychain/Keystore-protected storage and lifecycle/revocation policy. Test claimed HTTPS link associations and process/browser behavior on devices in your own application. Native examples are reference integrations, not separately published production SDKs or proof of every EHR/native combination.

## Contract and support policy

The public HTTP description is `/api/openapi.json`. SDKs are optional wrappers over that API. Use the server, contracts and SDK versions from the same release. Current `0.x` artifacts remain prereleases; no 1.0 release is implied by this guide.

For a qualified 1.x release, the compatibility policy is:

- Existing documented endpoints, request fields, credential ownership semantics and structured error codes remain compatible within the major version. Breaking changes require a new major version and migration notes.
- Responses may add optional fields or documented extension values. Clients must ignore unknown optional fields; do not serialize an entire response to diagnostics.
- SMART Flint API compatibility is separate from upstream FHIR capabilities, vendor registration requirements and authorization grants. A FHIR base URL or discovered metadata alone does not establish end-to-end support.
- The server, SDKs, examples and documentation state their actual support boundaries. Vendor/pathway claims require separately recorded compatibility evidence.

For a failed request, retain the returned request ID and sanitized error code. Supply the deployment/version and pathway when reporting an issue, using synthetic records. Exclude authorization URLs, launch handles, patient records, cookies, session credentials, upstream tokens and key material.

## Maintainer artifact checks

```sh
node scripts/test-sdk-artifacts.mjs
python3 -m venv .data/sdk-build-venv
.data/sdk-build-venv/bin/python -m pip install -r scripts/sdk-build-requirements.txt
.data/sdk-build-venv/bin/python scripts/build-python-sdk.py --verify
node scripts/package-sdks.mjs --output dist/sdk
```

The npm check installs tarballs offline into a temporary project outside the repository, compiles a consumer against their declarations, and runs native ESM/HTTP-contract scenarios. Python verification installs both the wheel and a wheel rebuilt from the sdist into separate clean virtual environments and runs the transport/credential tests. These checks do not contact an EHR or publish artifacts.

With the platform toolchains installed, run `node scripts/check-native.mjs` or select `--swift`/`--android`. The command compiles native sources and the included launch UI; it does not claim a completed device/browser/vendor round trip.
