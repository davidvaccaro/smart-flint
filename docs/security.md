# Security model and operational boundaries

This foundation is intended for development, interoperability testing, and further security review before handling live clinical data. Successful local synthetic workflows do not establish vendor certification or an organization's deployment approval.

## Credentials and administrative access

Production requires an explicit `ENCRYPTION_KEY` containing 32 random bytes encoded as base64 and an explicit administrative authentication mode: local username/password accounts or a configured OIDC provider. First-owner bootstrap additionally requires `ADMIN_BOOTSTRAP_ENABLED=true` and an `ADMIN_TOKEN` containing at least 32 characters. Store them in the operator's secret-management system. Keep upstream client secrets, private keys and OAuth tokens in the encrypted vault. Never commit a real `.env` file, database, encryption key, token response, launch handle or clinical payload.

The administrative token is an explicit first-owner bootstrap credential. It stops working for production login, bearer access and existing bootstrap sessions after an enabled platform administrator for the selected sign-in method is provisioned. Named users sign in with local credentials or OIDC and receive platform-administrator, integration-administrator or viewer roles. Exact issuer/subject identity, fresh per-request role/assignment lookup, both organization and application scopes, shared-resource write protection, and actor/resource-target audit records govern the control plane. Email addresses and provider group claims never grant access. Local passwords use salted, versioned scrypt hashes in the encrypted vault; password changes and offline recovery revoke all earlier local sessions. OIDC-only mode rejects native password authentication and sessions; it never falls back to a password after provider failure. See [administration](administration.md) for deployment and owner handoff. Configuration access and clinical end-user identity are separate trust relationships.

## Browser and native applications

Prefer a backend session for browser apps when available. Native applications should use a system authorization browser, an approved return URI, PKCE and platform-protected storage. A statically embedded mobile secret cannot authenticate a confidential client.

Upstream authorization and application activation handoff each need their own transaction binding. State, exact callback matching, expected issuer validation and one-use code redemption address different threats. An activation ID is a reference, not a credential. Browser tabs must identify their activation explicitly so different patients do not overwrite a global current-patient value.

## Direct access and handoff

Original upstream access-token access is supported through an authenticated application interface. Default context responses and diagnostics should not carry tokens. Token responses need `Cache-Control: no-store` and protection against accidental logging or serialization.

The original-token endpoint returns `{ tokenResponse, refreshOwner, refreshTokenWithheld }`. It preserves original access-token values while withholding the refresh token during bridge-owned renewal. Explicit compatible handoff transfers ownership and returns the current refresh credential; an original response retained from an earlier generation may contain expired or superseded credentials.

Choose one refresh owner per grant. A public native client cannot independently refresh a confidential-client grant if the upstream server requires the bridge's client authentication. DPoP- or certificate-bound access tokens also require their proof mechanism. An exported bearer token retains its original upstream permissions and expiry. Bridge session closure alone does not guarantee upstream invalidation.

Direct access bypasses gateway normalization, gateway-specific request policy and gateway request auditing. Direct browser calls additionally depend on the upstream server's CORS behavior.

## Network boundaries

Treat discovery documents and FHIR links as untrusted endpoint inputs. Permit only configured endpoint relationships and validate redirects, pagination, attachments and asynchronous download locations before attaching upstream authorization. Connections to private networks require an explicit operator decision. Restrict that decision further using allowed connection origins and network egress controls; enabling private-network support is not permission to use arbitrary URLs.

Put externally reachable launch and callback endpoints behind TLS. Keep the database on an internal network. Set `BASE_URL` and `CONSOLE_URL` to their real externally visible origins, and configure the reverse proxy deliberately rather than relying on untrusted forwarding headers.

## Storage and recovery

SQLite is for one runtime process; PostgreSQL provides the shared locking path. Protect configuration and activation records as potentially sensitive even though secret values are encrypted separately. Use encrypted volumes and backups, application-appropriate retention, least-privilege database access and separate storage of recovery key material.

Restoring a database without its master encryption key cannot recover private credentials. The compiled offline operations command supplies authenticated encrypted backups, verified restore into a fresh database, and atomic vault re-encryption with a pre-rotation backup. Restore invalidates old clinical grants and browser/protocol sessions. Follow the [operations runbook](operations.md); replacing `ENCRYPTION_KEY` alone makes existing encrypted values unreadable.

## Diagnostics

Fixed JSON operational events identify generated request IDs, route templates and outcomes without recording raw tokens, authorization codes, launch handles, search query strings, request/response bodies, error objects or concrete patient/resource identifiers. Dependency readiness is separate from process liveness; aggregate counters require a platform administrator. Review custom logging and reverse-proxy logs as part of deployment. Use synthetic data in fixtures and reported issues. See the [release security review](security-review.md) for the checks and their limits.
