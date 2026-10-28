# SMART Flint licensing and distribution

SMART Flint uses the Community/commercial model already used by EASI JS. The controlling Community License is the root [LICENSE](../../LICENSE), version 1.0. The license is source available; it explicitly does not describe itself as OSI-approved open source.

The Community License provides the eligibility rules, including individual, research and nonprofit exceptions and the USD 5,000,000 Organization Group revenue threshold. Its definitions, evaluation and transition periods, downstream conditions, patent grant and exclusions control. This overview does not replace those terms.

The covered SMART Flint distribution includes its service, console, TypeScript and Python SDKs, native examples, owned synthetic fixtures, and documentation. Third-party code and data, real patient data, external tools, platform SDKs and separately licensed specifications retain their own terms. Data processed by the service does not become licensed software merely because it was processed.

Commercial enquiries use the contact already identified in the license: [dvaccaro@xinonix.com](mailto:dvaccaro@xinonix.com). The [commercial agreement template](SMART-FLINT-COMMERCIAL-LICENSE-TEMPLATE.txt) preserves the EASI model and requires a completed order and signatures. The template itself grants no commercial rights and sets no automatic price, subscription, support promise or service level.

## License files in artifacts

`node scripts/generate-notices.mjs` generates the locked production npm inventory and retained dependency notices in [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md). It synchronizes the product license and notices into both npm packages and the Python SDK. `--check` verifies that the copies are current without writing them. Package metadata identifies the custom license and points to its included text.

The inventory includes browser-bundled dependencies and platform-specific optional packages, so it may be broader than any one SDK. It excludes development-only tools and the external Python interpreter/standard library. A distributed container additionally carries its base-image licenses and a separate image SBOM. Do not relabel dependency licenses as SMART Flint Community License or remove their notices.

Release archives include the license, notices, commercial template, package metadata, SBOM and checksums. The source archive excludes private deployment files, databases, credentials, dependency directories and generated runtime output. The release checks are described in [releasing](../releasing.md).

## Existing copies and contributions

This licensing change applies to the distribution that carries it. It does not rewrite terms on copies already received under an earlier license. Preserve provenance when incorporating material that was previously distributed separately.

Contributors retain ownership of their original work. Contributions must have clear licensing provenance. A separate written contributor authorization is required before accepting external work for redistribution under Xinonix commercial agreements; submitting a pull request alone is not an assignment of ownership. Third-party contributions and notices must be reviewed before inclusion in a release.
