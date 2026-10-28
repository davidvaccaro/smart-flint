# Contributing

Run `npm install`, then `npm run check`. Use the local synthetic EHR and fictional patient records for development. Python SDK checks use `PYTHONPATH=sdks/python/src python3 -m unittest discover -s sdks/python/tests`.

Keep application identity, tenant connections, upstream registrations, grants, and activations distinct. A change to one access pathway must preserve isolation and credential ownership in the others. SDK use and gateway use remain optional. Keep launch context, tokens, and private keys out of logs and administrative projections.

Vendor-specific behavior belongs in an explicit, documented profile with synthetic fixtures. Label simulated behavior separately from tests against actual vendor environments. Never commit real credentials, clinical records, private vendor documentation, local databases, or `.env` files.

Include meaningful tests for changes to authorization, storage, normalization, routing, or lifecycle behavior. Document unsupported behavior and compatibility evidence. New SDKs should use the public HTTP contract, follow their platform's native authorization conventions, and pass the shared protocol scenarios.

SMART Flint is source available under the [Community License](LICENSE), with a separate commercial licensing option. Submit only work you have authority to license and identify copied or adapted third-party material. You retain ownership of your original contribution. External contributions need a separate written authorization before acceptance for redistribution under Xinonix commercial agreements; a pull request does not transfer ownership or silently grant unrestricted commercial relicensing rights. Review [licensing](docs/licensing/README.md) before contributing.

Before changing dependencies, regenerate `THIRD_PARTY_NOTICES.md` with `npm run notices:generate` and inspect the new license expressions and retained notices. Keep SDK license copies synchronized. Before release, run the packaged-SDK acceptance checks and [release procedure](docs/releasing.md); do not rely only on monorepo imports. Security reports use the private contact in [SECURITY.md](SECURITY.md).
