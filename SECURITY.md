# Security

Use synthetic data when reporting security issues. Do not put tokens, private keys, clinical data, local databases, or unredacted authorization traces in public issues.

This repository is a foundation release. Before handling live data, review the deployment, registration topology, network trust, credentials, retention, access policy, and operational processes. The [security design](docs/security.md) documents the implemented controls and remaining boundaries.

Report a suspected vulnerability privately to the project maintainer at [dvaccaro@xinonix.com](mailto:dvaccaro@xinonix.com). Start with the affected version, deployment mode, a short description and synthetic reproduction steps. Request an appropriate private transfer channel before sending a detailed exploit or a large attachment. Do not send real patient records or active credentials. This is a disclosure contact, not a hosted support service or a response-time commitment.

When the repository is published, its owner should also enable GitHub private vulnerability reporting and confirm the maintainer contact. No repository URL or advisory endpoint is assumed by this source distribution. Public issues are suitable for ordinary defects after sensitive details have been removed.

Only explicitly identified release versions have a support policy. The current `0.1.0` candidate is prerelease software; security fixes may require upgrading rather than a maintained backport. Candidate artifacts have not been published automatically. Release gates and dependency/container checks are described in [releasing](docs/releasing.md).
