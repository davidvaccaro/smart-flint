# External environment configuration

These templates describe configuration. See [validation evidence](../../docs/sample-validation.md) for executed tests, including the public SMART Health IT Patient Portal / R4 path. Keep credentials out of tracked files. Use the console and registration worksheet for exact callback and public-key values.

| Environment | Connection profile | Registration |
| --- | --- | --- |
| SMART Health IT launcher | `generic`, sandbox, exact generated R4 FHIR issuer | Public client with a test client ID; no prior launcher registration required |
| Epic | `epic`, exact organization/environment FHIR base, approved authentication origins | Developer's client ID and the organization's enabled configuration |
| Oracle Health / Cerner | `oracle`, exact instance/persona FHIR base | Developer registration plus permitted customer implementation |
| MEDITECH | `meditech`, exact product/version/environment FHIR base | Greenfield/vendor/customer registration applicable to that environment |

The patient app needs a complete Patient birth date for its adult-only illustrative composite, plus usable final Observation records. Its minimal sample requirements are `patient/Patient.r` and `patient/Observation.rs`; use compatible v1 scope syntax when appropriate. Optional `openid fhirUser` provides identity and `offline_access` requests refresh where supported. Requirements remain distinct from the EHR's actual grant.

For Epic registration, the form used on October 25, 2026 requires HTTPS redirect URIs. Use the [local HTTPS profile](../../docs/development.md#local-https-for-sandbox-registrations) and register its worksheet values. Changing only `http` to `https` cannot enable TLS on an HTTP listener; the running profile's canonical origin must match the registered URI exactly.

For Epic patient-facing sandbox tests, prefer the MyChart accounts documented in [Epic's test data](https://fhir.epic.com/Documentation?docId=testpatients). On October 27, 2026, the operator reported successful launches for the other listed MyChart users and repeated `invalid_grant` for Olivia Roberts. Epic's table publishes credentials for Camila Lopez, Derrick Lin and Desiree Powell, but none for Olivia despite her appearance in LaunchPad. Treat Olivia as an unresolved sandbox-specific authorization case, not as proof of a general bridge failure; see the [validation evidence](../../docs/sample-validation.md#olivia-roberts-sandbox-exception). Missing published credentials alone does not establish account status.

Example configuration inputs (replace every placeholder):

```json
{
  "application": {
    "name": "Health Compass external sandbox",
    "callbackUrls": ["https://patient-app.example.com/callback"],
    "requiredContext": ["patient"],
    "requiredScopes": ["patient/Patient.r", "patient/Observation.rs"],
    "allowedModes": ["gateway", "direct"]
  },
  "connection": {
    "name": "Approved sandbox connection",
    "tenantId": "REPLACE_WITH_ORGANIZATION_ID",
    "vendor": "generic",
    "environment": "sandbox",
    "fhirBaseUrl": "REPLACE_WITH_EXACT_LAUNCHER_ISSUER",
    "allowedOrigins": ["https://launch.smarthealthit.org"],
    "fhirVersion": "4.0.1"
  },
  "registration": {
    "name": "Public sandbox client",
    "vendor": "generic",
    "clientId": "health-compass-example",
    "authMethod": "none"
  }
}
```

Create each entity through the console or its documented admin API, then bind their returned IDs in an installation. The JSON illustrates separate entity inputs and is not a single import endpoint. Separately hosted authorization/JWKS origins must also be approved. Use an exact approved OIDC issuer when discovery does not advertise one. Native/embedded workflows require their platform/browser adapters and separate verification.

Public source references: [SMART Health IT launcher](https://github.com/smart-on-fhir/smart-launcher-v2), [Epic OAuth documentation](https://fhir.epic.com/Documentation?docId=oauth2), [Oracle Health authorization](https://docs.oracle.com/en/industries/health/millennium-platform-apis/authorization-framework/), [MEDITECH Greenfield](https://ehr.meditech.com/ehr-solutions/how-to-work-in-the-greenfield-workspace).
