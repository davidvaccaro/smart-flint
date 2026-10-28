# Administrative identity and permissions

Administrative identity is separate from SMART patient/clinician identity. A deployment selects standalone username/password administration or its organization's OpenID Connect provider. Both use the same named-user roles, scope enforcement, audit records and browser sessions. Upstream EHR credentials continue to serve application activations. Local synthetic development retains **Open local workspace** when no administrative mode is explicitly selected.

## Choose the deployment authentication mode

| `ADMIN_AUTH_MODE` | Behavior |
| --- | --- |
| `local` | Permanent local username/password accounts. No identity provider is required. Passwordless demo login and OIDC sign-in are disabled, even if synthetic data mode is enabled. |
| `oidc` | Organization OIDC sign-in. Local password login, local sessions, and password changes are disabled; provider outages never trigger a local fallback. |
| Omitted | Backward compatible: ordinary local demos retain one-click access; non-demo deployments retain the OIDC/bootstrap model. |

New `npm run configure` output defaults to `local`. Existing configurations are not rewritten. Use `--auth-mode=oidc` for a new SSO deployment. In local mode, OIDC environment settings are ignored. Changing authentication mode is an explicit deployment operation; there is no automatic fallback or silent identity linking.

## Set up standalone username/password administration

1. Generate a fresh production configuration with `npm run configure -- --base-url=https://flint.example.com --auth-mode=local`. This writes a private `.env` without overwriting an existing file. It generates a temporary bootstrap token and encryption key; it does not seed a default password.
2. Build and deploy behind HTTPS, with `DEMO_MODE=false`. Keep `ADMIN_AUTH_MODE=local`, and enable initial setup with `ADMIN_BOOTSTRAP_ENABLED=true` and the generated `ADMIN_TOKEN`.
3. Open the console and use **Initial deployment setup** with that bootstrap token.
4. Open **Settings & API → Users & access → Add user**. Choose a username and initial passphrase, select **Platform administrator**, and leave the account enabled.
5. Saving the first usable local owner retires bootstrap access. Sign in with the new username/password, then remove the bootstrap token and set `ADMIN_BOOTSTRAP_ENABLED=false` in deployment configuration.

Usernames contain 1–64 ASCII letters/digits plus dots, underscores or hyphens, starting with a letter or digit. They are normalized case-insensitively. Passwords contain 15–128 Unicode characters, preserve spaces and case, and are never trimmed or truncated. Entirely whitespace, repeated-character and a small set of common weak passwords are rejected. Long, unique passphrases or password-manager-generated values are appropriate.

Local passwords use Node's asynchronous scrypt with a unique random 32-byte salt, a 64-byte derived key, and pinned parameters `N=65536`, `r=8`, `p=2` (the OWASP 64 MiB profile). Only the versioned slow hash is stored in the encrypted vault; plaintext passwords and hashes are excluded from user metadata, API responses and audit records. Hash computation has bounded concurrency and queueing. Credentials are verified using a timing-safe comparison, and unknown accounts perform a dummy password derivation.

Local sign-in uses the browser session API; it does not enable HTTP Basic authentication or accept a password as a bearer token. Login has a per-IP limit and a persistent normalized-username limit of five failures within fifteen minutes. Current-password verification has a separate persistent limit. These counters are shared across PostgreSQL instances. Local mode has no built-in MFA; deployments requiring managed MFA should select OIDC and configure that policy at the provider.

## Change or recover a local password

Every signed-in local user, including viewers, can use **Settings & API → Change password**. The current password and confirmation of the new password are required. A successful change rotates the credential version, invalidates earlier local sessions across instances, and returns the user to sign-in.

There is no public forgotten-password email endpoint. A trusted operator with access to the deployment database and encryption key can reset an existing local account offline:

```sh
# Stop every SMART Flint service instance sharing this database first.
npm run build
npm run admin:reset-password -- --offline --username admin
```

The command prompts twice without displaying the password. Automation may supply `--password-file /secure/new-password` instead. On POSIX, the file must be owned by the current user, a nonsymlink regular file, at most 2048 bytes, and permission `0600` or stricter. The file is bounded-read as UTF-8, with one final newline removed; password spaces remain significant. Passwords cannot be passed as command-line arguments. The command never prints passwords or hashes. Its compiled entry point ships in the production server build and does not require a development TypeScript loader.

For a Compose deployment, stop all application replicas, keep PostgreSQL running, and use the same configured secrets:

```sh
docker compose stop flint
docker compose run --rm --no-deps flint node apps/server/dist/scripts/admin-reset-password.js --offline --username admin
docker compose up -d flint
```

`--offline` is an operator attestation, not automatic detection of other servers. Recovery rotates only an existing local credential, revokes prior sessions, clears that user's password-attempt limits, and records an operator audit event. It preserves role, assignments and disabled state, never creates an account, and cannot reset OIDC credentials. A disabled account still requires a platform administrator to enable it. Restart the service before signing in again. Protect or remove any automation password file using your normal secret-handling process.

## Configure organization sign-in

Register a dedicated authorization-code client in your identity provider. Enable S256 PKCE and register this exact redirect URI, replacing the origin with your externally reachable `BASE_URL`:

```text
https://flint.example.com/api/admin/oidc/callback
```

Set the following deployment variables:

| Variable | Purpose |
| --- | --- |
| `ADMIN_OIDC_ISSUER` | Exact issuer URL advertised by the identity provider, including any tenant/realm path and significant trailing slash. |
| `ADMIN_OIDC_CLIENT_ID` | Dedicated administrative client identifier. |
| `ADMIN_OIDC_AUTH_METHOD` | `none` for public PKCE clients, `client_secret_basic`, or `client_secret_post`. |
| `ADMIN_OIDC_CLIENT_SECRET` | Required for a confidential client; keep it in deployment secrets. |
| `ADMIN_OIDC_ALLOWED_ORIGINS` | Comma-separated additional approved HTTPS origins for discovery endpoints. The issuer's origin is included automatically. |
| `ADMIN_OIDC_LABEL` | Deployment label for organization sign-in. |
| `ADMIN_BOOTSTRAP_ENABLED` | Explicitly enables first-owner setup using `ADMIN_TOKEN`; defaults to false. |

The console and runtime must share a hostname and URL scheme for their administrative session cookie. They may use different ports. Deployments with separate public hostnames should proxy administrative routes through the console's public hostname and use that origin consistently for both settings. Production identity endpoints require HTTPS. Private identity networks additionally require the existing explicit private-network configuration and deployment egress controls.

SMART Flint requests `openid profile email`. It validates discovery issuer and endpoint origins, authorization code/PKCE, browser-bound state, nonce, ID-token signature, issuer, audience, authorized party, issuance/expiration and an access-token hash when provided. Supported ID-token algorithms are RS256/384/512, PS256/384/512 and ES256/384/512. It never accepts an unsigned or symmetric ID token. Your identity provider manages passwords, MFA and its own authentication policies. Provider-specific enterprise setup still requires validation in your environment.

## Provision the first OIDC platform administrator

1. Run `npm run configure -- --base-url=https://flint.example.com --auth-mode=oidc`, or explicitly set `ADMIN_BOOTSTRAP_ENABLED=true` and a random `ADMIN_TOKEN` of at least 32 characters in your existing deployment secrets.
2. Configure the OIDC variables above and restart the deployment.
3. Use the bootstrap credential to open the console. Open **Settings & API → Users & access** and add the first platform administrator using the provider's exact **issuer and subject** values.
4. Sign in using that account through your organization identity provider. Provision other named users and assign the organizations and applications they administer.
5. Remove the bootstrap token from deployment secrets and set `ADMIN_BOOTSTRAP_ENABLED=false`.

An enabled platform-administrator account for the selected sign-in method automatically disables production bootstrap login, bootstrap bearer access and existing bootstrap sessions—even if the environment flag remains true. Accounts belonging to an inactive authentication method do not satisfy first-owner setup. A missing or corrupted local password record does not reopen bootstrap; use offline recovery instead. The previous shared-token administrator sessions are not accepted after this upgrade. Plan the first-owner handoff using a known working issuer and subject. Last-owner protection prevents ordinary console/API changes from deleting or disabling the final enabled platform administrator. Recovery from an incorrectly provisioned owner requires an operator-controlled database recovery procedure; resetting environment flags does not bypass the stored owner.

OIDC users are linked only by the exact issuer and subject pair. Local usernames and OIDC identities are separate accounts; matching email addresses do not link them. Email address, display name, provider role/group claims and domain membership do not grant access or automatically create an account. Ask your identity administrator for the stable subject assigned to this client. A successful identity-provider login without a matching active account returns **access not granted**.

## Roles and assignments

| Role | Administrative authority |
| --- | --- |
| Platform administrator | Manage all organizations, applications, integration configuration and administrative users. |
| Integration administrator | Manage permitted integration resources within explicitly assigned organizations and applications. Global administration and user/role management remain platform-administrator tasks. |
| Viewer | Read permitted configuration and launch activity within explicitly assigned organizations and applications. Configuration writes, credential rotation, discovery and session-closing actions are denied. |

Organization and application assignments are both enforced. An installation or activation must belong to an assigned organization **and** an assigned application. Sharing a vendor registration or connection does not extend a user's scope. The API limits metadata projections and rejects shared-resource mutations that would affect configuration outside the user's assignments. The console presents matching read-only and manageability controls; the API remains authoritative.

Role changes, scope changes and disabled accounts take effect on the next administrative request. Administrative sessions are opaque, HttpOnly cookies backed by stored credential hashes, expire after eight hours, and require an approved origin for cookie-authenticated mutations. Logout closes the SMART Flint administrative session. For OIDC users, it does not sign them out of the organization's identity provider.

## Audit and troubleshooting

Administrative changes record the local actor ID, display name, authentication kind and role. Authorization errors use fixed messages; provider descriptions, ID/access tokens, login codes, verifier/nonce values and private credentials are omitted from diagnostics. OIDC verifier/nonce material is encrypted only for the short-lived login transaction and removed after callback consumption or expiry. An actor's display name is administrative metadata, not a patient identity.

If sign-in fails, confirm the provider issuer, registered callback URI, client authentication and approved endpoint origins. For **access not granted**, confirm the exact issuer/subject account and disabled state. For denied resource access, review both organization and application assignments. Start a fresh sign-in after a failed or expired callback; callbacks and state are single-use. No external identity provider is enabled automatically for the local demo.

Protocol references: [OpenID Connect Core](https://openid.net/specs/openid-connect-core-1_0.html#CodeFlowAuth) and [`jose` JWT verification](https://github.com/panva/jose/blob/main/docs/jwt/verify/functions/jwtVerify.md).

Password references: [OWASP password storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html) and [authentication guidance](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html).

See [executed validation](admin-validation.md) for the automated permission, PostgreSQL, browser SSO, and existing SMART sample checks.
