# Release security review

This is an engineering review and reproducible release gate, not an independent penetration test, certification, or approval to process a particular organization's clinical records. New EHR/pathway qualification is deliberately deferred to joint testing. Existing compatibility evidence remains in [sample validation](sample-validation.md).

## Reviewed trust boundaries

| Boundary | Implemented control and evidence |
| --- | --- |
| Browser/app to launch service | Exact registered callbacks, two independent S256 PKCE transactions, expected issuer, browser binding, single-use state/handoff codes; `tests/security.test.ts` and `tests/integration.test.ts`. |
| Organization/application isolation | Both assignment axes, fresh per-request user lookup, explicit metadata projections, shared-resource mutation guards, activation-bound credentials; `tests/admin-access.test.ts` and PostgreSQL tests. |
| Administrative identity | Selected local or OIDC mode, no implicit fallback/linking, slow salted password derivation, persistent failure counters, version-bound sessions, controlled first-owner retirement; local/OIDC browser suites and authentication tests. |
| EHR/identity/next-page network calls | Configured origin/base-path checks, HTTPS, controlled private-network opt-in, connection-time DNS address checks, redirects blocked before credentials are forwarded, bounded response bodies/timeouts; security and integration tests. |
| Upstream credentials and gateway | Authenticated vault envelopes, explicit token-export policy, one refresh owner, refresh-token withholding, grant locks across PostgreSQL pools, no credentials in ordinary activation descriptors. Direct/exported credentials retain their original upstream authority. |
| Operators and recovery | Separate offline trust boundary; authenticated whole-backup encryption, private files, bounded inputs, empty-target transactional restore, full-vault compare-and-replace rotation and atomic audit; `tests/operations.test.ts`. |
| Diagnostics and artifacts | Generated request IDs and fixed route templates, no raw exceptions/requests, restricted telemetry, explicit artifact allowlists, source/SDK path and credential guards, private scanner reports; operations-health and release-tooling tests. |

The application deliberately leaves proxy forwarding headers untrusted. In a proxy deployment, apply appropriate connection/request limits at the edge as well: the application's per-IP limiter sees the proxy address. Private-network opt-in must be paired with an origin allowlist and deployment egress restrictions. An administrator authorized to configure an upstream endpoint is part of the trust boundary.

## Reproducible security gates

Run `npm run security:check` for dependency advisories, notice consistency and the focused authorization/isolation/redaction tests. The ordinary full check also includes replay, refresh concurrency, expiry, cleanup, storage and recovery cases.

Run `npm run security:image -- --image <local-image>` for the runtime image. The pinned Trivy scanner examines an exported archive without a Docker socket mount, writes private vulnerability/secret reports and an image CycloneDX SBOM, and fails on any HIGH/CRITICAL vulnerability or embedded secret. Scanner/network failure is a failed check. Findings are not silently ignored because a vendor has not published a patch. The source/SDK SPDX inventory and image SBOM have different scopes; retain both with the candidate.

The production acceptance command uses a real isolated Keycloak reference provider over HTTPS, signed ID tokens, S256 PKCE, first-owner provisioning, Secure/HttpOnly cookies and logout. It verifies protocol interoperability with that version and configuration. Microsoft Entra ID, Okta, customer policies, MFA enrollment, app-link ownership and native device behavior require their own deployment/integration acceptance. The Keycloak realm and TLS edge in this check are disposable test fixtures, not production identity-server deployment templates.

The image runs as an unprivileged user with a read-only root filesystem, no additional Linux capabilities and no-new-privileges. Compiled Node commands handle startup and maintenance; package-manager tooling is omitted from the runtime. Build/CI tooling and the operating-system base must be kept current as new advisories appear. Use the patched runtime in `.nvmrc` for source deployments; the release image pins its Node version separately.

## Deployment responsibilities

Set the public origins and TLS configuration, protect the database and encryption keys, define backup/restore objectives, review upstream scopes and exported-token policy, monitor readiness/capacity/certificate expiry, and validate the chosen IdP. Use the [operations runbook](operations.md) and [administration guide](administration.md). An external security review and the deploying organization's own acceptance remain appropriate before live clinical use.
