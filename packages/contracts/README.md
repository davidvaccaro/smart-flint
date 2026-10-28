# SMART Flint public contracts

TypeScript interfaces for the public SMART Flint HTTP API. Compiled JavaScript and declarations are included; this package requires no TypeScript loader at runtime. The optional `@smart-flint/sdk` consumes this contract. Application developers may instead use the HTTP API directly and any FHIR client.

Install this package and the SDK from the matching release artifacts. Keep both versions aligned. The `development` export condition serves the monorepo source to Vite and Vitest; ordinary Node.js and bundler consumers use `dist`.

Versions before 1.0 remain prereleases. The v1 compatibility policy is described in the developer onboarding guide distributed with SMART Flint. Authentication credentials are not ordinary metadata: never log, persist casually, or include credential responses in URLs.
