# Preparing a SMART Flint release

This checkout remains version `0.1.0`. The release tooling prepares reviewable candidates; it does not publish a GitHub release, push a container image, upload to npm/PyPI, or declare vendor qualification complete. Additional vendor/pathway testing is intentionally deferred. Keep the distinction between a passing build and supported integration evidence in release notes.

## Qualification gates

1. Use a clean checkout with the lockfile and the documented Node/Python build toolchain. Run `npm ci`, `npm run check`, and `npm run security:check`.
2. Run the production deployment acceptance check, `npm run test:production`. It uses disposable services and synthetic identities, and must never target the operator's saved deployment database or credentials. Review the production/security evidence and any scanner findings.
3. Install Python build requirements from `scripts/sdk-build-requirements.txt` in a build virtual environment. Run `npm run test:sdk-artifacts`, `npm run sdk:python`, and the native example checks documented in [developer onboarding](developer-onboarding.md). The SDK checks install artifacts outside the monorepo, including the Python wheel rebuilt from its source distribution.
4. Review [sample validation](sample-validation.md), known vendor-specific exceptions, supported FHIR interactions, and native-platform boundaries. Real vendor/pathway qualification remains a separate operator-run gate; this workflow does not replace it.
5. Confirm the Community/commercial license, dependency notices, security contact and contributor provenance. Update this changelog and the support policy for the actual release.

An externally distributed version must have a unique semver and immutable tag/artifacts. Coordinate the root package, lockfile, service and public npm package versions and Python project version. Do not republish changed bytes under an existing version. The candidate generator rejects mismatched versions and existing output directories. A version bump alone does not qualify a release.

## Prepare artifacts locally

```sh
npm run notices:generate
npm run notices:check
npm run release:prepare -- --output /private/tmp/smart-flint-candidate
```

The output directory must not exist. The command builds the TypeScript/contracts packs and Python wheel/sdist using the pinned Python build requirements, then writes:

- Compiled TypeScript SDK and contracts `.tgz` packages.
- Python wheel and source distribution.
- A portable source `.tar.gz` containing the allowed project source, tests and documentation.
- `LICENSE`, `THIRD_PARTY_NOTICES.md` and `CHANGELOG.md`.
- `sbom.spdx.json`, covering the locked production npm dependency tree, including browser bundles and optional platform packages.
- A candidate manifest with file/artifact hashes and a `SHA256SUMS` index.

`SOURCE_DATE_EPOCH` selects the source archive timestamp; it defaults to zero for local reproducibility. CI uses the commit timestamp. The source archive fixes ownership and preserves only executable/nonexecutable modes. It includes no dependency tree or build cache. An allowlist excludes `.data`, `.env` files except the empty example, local databases, certificates/keys, logs, generated output and dependency directories. Source symlinks, private file types and embedded complete private-key PEM blocks fail the build. These inclusion checks complement the security review; they are not a proof that arbitrary source text contains no secret.

Existing SDK artifacts can be supplied using `--sdk-dir DIR`. A container image archive and CycloneDX image SBOM can be included together using `--image-archive FILE --image-sbom FILE`. They are copied into the candidate and covered by its manifest and checksums. The npm inventory is not an OS/container SBOM. Node and base-image dependencies require the separate image scan and SBOM.

Verify `SHA256SUMS` after transfer, for example with `sha256sum --check SHA256SUMS` or `shasum -a 256 --check SHA256SUMS` on macOS. The hash index detects byte changes; signatures or repository attestations need the publisher's configured identity and are not implied by an unsigned local candidate.

## Manual CI candidate workflow

`Prepare release candidate` is `workflow_dispatch` only. It checks the requested version against package metadata, builds a versioned local runtime image, runs the production acceptance/security and SDK checks, scans the image, exports it with an image SBOM, and uploads one workflow artifact containing the candidate files. It has no registry or repository-release publishing step. Its dependencies and action revisions are pinned.

The source repository is [davidvaccaro/smart-flint](https://github.com/davidvaccaro/smart-flint). Before using hosted automation, configure private vulnerability reporting and ensure Actions is enabled. Public package/container registry publisher identities remain separate release configuration. Artifact retention is temporary; workflow artifacts do not constitute a permanent distribution channel.

## Publication is an explicit separate operation

After reviewing the candidate and completing the chosen compatibility qualification, select the final repository/registries and publisher identities. Review exact artifact hashes, immutable image digest, license terms, changelog and security/support contact. Publishing the reviewed bytes, signing/attestation, assigning the final tag and announcing support are deliberate operator actions. No default workflow performs them on a push, tag, pull request or timer.

Keep database/key recovery and deployment rollback instructions with the release. Do not use an older binary against a newer database as a substitute for the tested backup/restore procedure in [operations](operations.md).
