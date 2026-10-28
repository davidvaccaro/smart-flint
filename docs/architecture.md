# SMART Flint architecture

SMART Flint is a self-hosted service that separates SMART launch orchestration, credential lifecycle management, and FHIR transport. An application can use the managed gateway, connect directly to the upstream FHIR server while SMART Flint manages credentials, or assume a compatible grant through explicit handoff. SDK use is optional.

## Workspace

| Path | Responsibility |
| --- | --- |
| `apps/server` | Administrative API, launch orchestration, activation sessions, credential access and FHIR gateway |
| `apps/console` | Management console and interactive reference application |
| `apps/mock-ehr` | Synthetic authorization and FHIR environments for local exercises |
| `packages/contracts` | Shared, versioned application and administrative types |
| `packages/sdk` | TypeScript activation and credential helpers |
| `packages/storage` | SQLite/PostgreSQL repository and encrypted secret vault |
| `examples/native` | Native integration examples; see the example-specific setup and verification notes |

## Persistent model

- **Application:** application identity, approved callback URLs, context requirements and permitted access modes.
- **Tenant:** organizational configuration and security boundary.
- **EHR platform:** managed metadata identifying an integration platform and its protocol profile. Built-in profiles cover Epic, Oracle Health, MEDITECH and generic SMART/FHIR; additional platform entries can reuse those protocol profiles. Customer-specific endpoints remain on connections.
- **Vendor app registration (`AppRegistration`):** a portal-registration grouping associated with an EHR platform and application identities. It contains references to one or more environment-specific OAuth client profiles. Explicit application sharing preserves existing integrations that deliberately reuse credentials.
- **Client profile (`Registration`):** upstream client identity, authentication method, optional environment metadata and references to encrypted credentials. The existing type and `/registrations` API remain compatible with earlier deployments.
- **Connection:** tenant-specific FHIR endpoint, EHR platform, protocol profile, environment and discovered configuration. Multiple connections can reference one physical server.
- **Installation:** binding of an application, tenant, connection, vendor app registration/client profile and policy.
- **Grant:** upstream authorization and its credential lifecycle. It has exactly one refresh owner.
- **Activation:** one execution context bound to an application, installation, tenant and connection.

Each database collection has its own table with an identifier and a versionable JSON record. PostgreSQL uses JSONB; local SQLite uses JSON text. The service validates relationships and protocol transitions. This initial schema favors evolution of the integration contract; database-level relational constraints and indexed operational queries can be added through explicit migrations as usage develops.

Workspace organization is described in the [workspace guide](workspace.md). Application and EHR-platform registration views reference the same records. Organizations remain independent of EHR platforms, and their connections can serve several applications through installations. Activations also expose launch activity, including authorization failures that occurred before any activation was established.

## Administrative identity

Named administrator records live in `admin_users` and link either to a unique local username or to an exact configured OIDC issuer and subject. The deployment explicitly selects local password authentication or OIDC. Local password hashes are salted scrypt records in the encrypted vault, and sessions bind the current credential version so changes and recovery invalidate earlier sessions. Platform administrators manage the deployment; integration administrators and viewers receive explicit organization and application assignments. Per-request authorization loads current user state and projects the resource graph before returning administrative metadata. Shared resources require authority over all affected bindings for writes and new credential bindings. An asynchronous request context attaches actor identity and resource targets to administrative audit events. Demo/bootstrap identities remain distinct from named users and from clinical end-user identity. See [administration](administration.md).

## Activation and access

The application first establishes a PKCE-bound handoff transaction with SMART Flint. SMART Flint runs a separate upstream authorization transaction, exchanges the authorization code, validates the resulting grant, and returns a short-lived one-use code to an approved application callback. Redemption establishes an activation-bound session. The ordinary descriptor contains context and endpoint information; upstream token material has an explicit authenticated API.

Gateway credentials authorize SMART Flint access. Upstream access tokens authorize the original FHIR server. They are separate credentials with separate audiences; exporting an upstream token does not impose gateway-only restrictions on it. A connection-qualified resource identity remains necessary even when the application uses a gateway base URL.

## Persistence and concurrency

SQLite provides a local single-process development setup. It uses WAL mode, parameterized statements, and atomic `DELETE ... RETURNING` to consume one-use records. Its refresh lock is process-local, so SQLite deployments must use one runtime process.

PostgreSQL is the deployment path for multiple runtime processes. `withLock` obtains a transaction-scoped advisory lock derived from the grant key. Repository operations in that callback use the same leased connection and transaction through async context. This allows atomic refresh-token replacement across service instances. Consuming a handoff is one atomic database statement.

The secret vault uses AES-256-GCM with a fresh nonce for every value. The record identifier is authenticated associated data, so moving encrypted values between identifiers fails authentication. The master key remains outside the database. Backups need both the database and separately protected key material.

## Compatibility boundaries

The local mock environments exercise distinct connection namespaces and OAuth/FHIR behavior. Their vendor labels are synthetic fixtures, not evidence of Epic, Oracle Health, or MEDITECH certification. Real deployments require the corresponding application registration, customer enablement, supported flow, scopes, endpoint relationships and live validation.

Scope grants and endpoint capabilities are distinct. Discovery indicates advertised behavior; actual resource authorization still belongs to the upstream server. FHIR-version conversion, clinical terminology mapping and cross-system patient identity matching require separate capabilities. Initial SMART context does not imply ongoing chart synchronization.

## Design references

- [SMART App Launch 2.2](https://hl7.org/fhir/smart-app-launch/STU2.2/)
- [CDS Hooks](https://cds-hooks.hl7.org/)
- [OAuth Security Best Current Practice](https://www.rfc-editor.org/rfc/rfc9700.html)
- [OAuth for Native Apps](https://www.rfc-editor.org/rfc/rfc8252.html)
- [OAuth for Browser-Based Applications](https://www.rfc-editor.org/rfc/rfc10017.html)
