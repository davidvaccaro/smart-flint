# Installer validation — October 28, 2026

The guided installer is implemented in `install.sh`, `install.ps1` and the Docker-contained controller `scripts/install.mjs`. Users need local Docker with Linux containers and their operating system's shell; they do not need host Node/npm/Python. Source bundles build inside Docker; verified image archives or explicitly selected images can be reused. No registry URL or published image is assumed.

## Executed checks

- Full TypeScript checks, production builds and **296 automated tests passed with no skips**, including the isolated PostgreSQL cases, installer state/checksum/archive tests and production configuration generator tests.
- `npm run test:installer` passed against the public shell launcher. It verified a checksummed gzip image archive, private configure-only setup, preservation of the explicitly selected image, deployment readiness, first administrator creation using private configuration/stdin, bootstrap retirement, Secure session cookies, retained database records and unchanged keys across stop/start/resume, and safe rejection of mode changes, unrelated directories and occupied ports.
- The same acceptance suite verified an isolated five-port Docker sandbox, a synthetic EHR launch ticket, S256 PKCE/code redemption, patient FHIR access and session closure. Temporary installation projects, volumes and image aliases were removed.
- A separate genuinely fresh invocation supplied no application image. The controller built the sandbox from the mounted source using Docker, started it and passed readiness. No host application runtime was required.
- The default browser handoff passed with an isolated opener stub; no real browser was opened by the test. This found and fixed a macOS `sed` expression compatibility issue.
- The sandbox also passed the existing patient browser suite and 48 synthetic CDS/backend sample operations, plus restart/named-volume persistence checks.
- Strict scans of the final sandbox and installer-controller images found **zero detected vulnerabilities at any severity and zero embedded secrets**. Image inventories/reports are private under `.data/security-sandbox-installer-qualified/` and `.data/security-installer-helper/`.
- The generated production configuration preserved literal OIDC secrets containing dollar signs/quotes/backslashes in actual Compose containers. The pinned official Caddy parser accepted the generated configuration. No public listener or ACME certificate request was started during validation.
- The Windows PowerShell launcher passed the official PowerShell parser. Native Windows/Docker Desktop lifecycle and ACL behavior were not executed in this macOS environment and remain platform acceptance work.

Docker Desktop validation found two actual portability differences: its host API socket cannot be filesystem-shared from `~/.docker/run`, and its VM socket is root-writable while bind ownership is mapped to UID 0. The macOS wrapper now uses the VM socket, a restricted root controller, and explicit real-host ownership/mode checks. New private files still belong to the host user; no shared socket or system trust permissions were changed. Linux retains host UID/GID/socket-group execution. Both profiles keep data in isolated named volumes and keep the source checkout read-only.

## Preserved boundaries

Private plans and generated credentials remain in the selected installation directory. Runtime images are locked to resolved local identities; archive bytes are privately staged, checksummed, normalized to bounded raw tar, then loaded. The archive's single-image metadata and actual loaded identity are checked rather than trusting Docker's output text. A real Docker 24 round trip exposed compressed-input and tag-output compatibility quirks, both now handled. Restart never regenerates keys or silently changes mode/origins. `stop` does not delete volumes. A public HTTPS endpoint is checked with certificate validation; until it is verified, setup reports HTTPS as pending and does not automatically open the browser.

The existing development console on port 3010 and trusted API on 3443 remained healthy. Its saved EHR registrations, master key and database were not replaced. New real-vendor/pathway qualification remains intentionally deferred. Nothing was published. See the [installer guide](installation.md) for user commands and the [operations runbook](operations.md) for recovery/upgrade procedures.
