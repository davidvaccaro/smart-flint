# SMART Flint workspace

Applications are the main entry point. The workspace separates reusable configuration from the installations that bind it and the runtime activations that use it.

| Section | Responsibility |
| --- | --- |
| Applications | Product callbacks, required launch context and scopes, allowed access modes, registrations and installations |
| EHR Platforms | Platform profiles, vendor app registrations and the organizations/connections using a platform |
| Organizations | Organizational configuration, owned FHIR connections, installations and activity |
| Installations | The binding of application, organization, connection, registration/client profile and access policy |
| Activations | Established app access and launch activity, including failures before an activation exists |

Overview, Developer lab, Sample library and Settings remain available as workspace tools. A connection can serve multiple applications, and an organization can have connections to several EHR platforms.

## Registrations and client profiles

A vendor app registration represents the registration maintained in an EHR developer portal. Its application associations and platform are explicit. Client profiles beneath it hold the actual client IDs and authentication configuration, with sandbox/test, production or unspecified environment metadata. This allows one portal registration to group separate non-production and production credentials.

The same logical registration is visible from its application's registration view and the EHR platform's registration view. These are linked views, not copies. Registrations used deliberately by multiple application configurations retain those explicit associations. Vendor portal changes and customer enablement remain operator tasks; the workspace does not silently create or synchronize vendor portal applications.

The existing `Registration` transport type and `/api/admin/registrations` endpoint continue to refer to individual OAuth clients. The new `AppRegistration` type and `/api/admin/app-registrations` endpoint supply the portal-registration grouping. Applications using the launch SDK do not need to change their activation contract.

## Add an EHR integration

1. Open or create an application and begin its integration setup.
2. Select the EHR platform, logical vendor registration and appropriate client profile.
3. Select the organization and one of its FHIR connections. Create missing configuration within setup where needed.
4. Choose requested scopes, gateway/direct/handoff access, token-export policy and normalization behavior.
5. Review the installation and its registration worksheet, verify connection discovery and execute a test launch.

Choose each resource from the existing registry when it already represents the desired environment. A new installation should not require duplicating an organization's connection or a reusable vendor registration.

## Connection identity and launch URLs

Connections retain the full approved FHIR base URL, including its path, platform, environment and trusted endpoint origins. SMART discovery retrieves authorization endpoints from that base. The incoming EHR launch `iss` must match the installation's configured FHIR base. Platform metadata does not replace connection-specific discovery or establish verified vendor compatibility.

The installation remains the runtime routing unit. Its launch URL is `/launch/{installationId}`; the EHR OAuth callback is `/oauth/callback/{connectionId}`. An application's callback belongs to the application, and its gateway URL is specific to the activation. The restructured workspace does not replace these registered URLs with new application-level launch routes.

## Existing installations and upgrade

Registry migration adds platform metadata and registration groupings to existing records. It preserves application, organization, connection, client-profile and installation IDs, existing client IDs, secret references, callbacks, requested scopes and access policies. Existing EHR portal registrations and application launch configurations therefore retain their registered URLs.

Legacy clients may be shared across multiple applications or synthetic platform fixtures. Migration retains those clients and associates logical registration groups with the relevant platform and application identities. It does not duplicate or regenerate credentials. Where environment or audience metadata cannot be established safely, it remains unspecified for an operator to review.

Back up the database and separately retain the existing encryption key before upgrading a self-hosted deployment. Migration is additive and repeatable; using a newer database with an older binary is not a substitute for a verified restore procedure. Run the protocol and sample checks after upgrading. The local synthetic fixtures, SMART Health IT configuration and Epic configuration are separate verification targets; discovery success alone does not establish end-to-end compatibility.

## Launch activity

An activation exists after authorization, required scope and required context checks succeed. Rejected EHR launches can therefore appear in launch activity without an activation row. Use the audit detail to distinguish initial issuer/handle rejection, EHR authorization denial, token-exchange failure and a later FHIR-read issue. Operational views omit upstream token material and sensitive clinical context.
