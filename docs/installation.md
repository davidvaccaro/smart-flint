# Install SMART Flint

The guided installer has two paths: a local synthetic sandbox, or a persistent deployment with PostgreSQL and local or organization sign-in. Docker is the only application prerequisite; Node/npm are used inside the installer/build containers. The installer uses the local Docker daemon and Compose plugin. Remote Docker daemons are not supported by this installation workflow.

Download and extract a trusted SMART Flint source/release bundle, then run the installer from that directory. This checkout and its local candidates have not been published to a public download service. The installer never guesses a registry or download URL.

## Prerequisites

- macOS or Windows: Docker Desktop running with Linux containers and Docker Compose available.
- Linux: Docker Engine and the Compose v2 plugin, with permission to use the local daemon.
- Internet access for the pinned installer/base images and dependencies during a source build, unless those inputs are already present locally. A runtime image archive by itself is not a complete air-gapped installation bundle.
- A writable, private installation directory and available host ports. Deployment mode also needs the chosen HTTPS/DNS arrangement and any organization identity-provider client registration.

On macOS/Linux, use Bash (the installer is not a POSIX `sh` script):

```sh
bash ./install.sh
```

On Windows, run the companion script from PowerShell using your organization's normal script policy:

```powershell
.\install.ps1
```

The wizard asks which mode to use and shows the installation directory. Select another directory with `--directory`; the default is outside the source checkout, under your user profile. It checks Docker/Compose, protects saved configuration, checks requested published ports, starts the chosen services and verifies readiness. It opens the console when browser readiness is confirmed unless browser opening is disabled. It does not install Docker, edit firewall/DNS rules, change certificate trust, or replace an existing source checkout's `.data` directory.

The controller uses the local Docker socket and must come from a trusted release. Linux runs it with the host user's identity and socket group. Docker Desktop on macOS requires root inside its restricted controller container for its VM socket; the wrapper validates real host file ownership/permissions, and new bind-mounted files remain owned by the host user. The socket's permissions are never changed. Windows protects private files with ACL checks. Remote Docker engines are outside the launchers' supported setup path.

## Try SMART Flint

Choose **Try SMART Flint** for a synthetic local sandbox. It starts the console/API, mock EHR, Health Compass patient app, CDS Hooks handler and backend assessment sample in a Docker sandbox. All published endpoints bind to `127.0.0.1`. The console opens with **Open local workspace**; no patient-provider account or real EHR credentials are needed.

Default ports are 3010 for the combined console/API, 4010 for the mock EHR, 4100 for the patient app, 4101 for CDS Hooks and 4102 for the backend sample. Existing services are never stopped automatically. Choose different ports if another SMART Flint instance or application is already using them.

For a repeatable, noninteractive installation:

```sh
bash ./install.sh --mode sandbox --directory "$HOME/.smart-flint-sandbox" \
  --port 3010 --mock-port 4010 --patient-port 4100 --cds-port 4101 --fhir-port 4102 \
  --non-interactive --no-open
```

Use **Sample library** to open Health Compass, or **Developer lab** to explore the synthetic launch pathways. The sandbox's records are fictional. Its HTTP loopback endpoints are appropriate for local synthetic use; an EHR sandbox that requires HTTPS needs the explicit HTTPS deployment arrangement below.

The selected ports belong to the saved installation. Resume it using the same directory; do not edit seeded records or silently remap an existing installation to different origins.

## Deploy SMART Flint

Choose **Deploy SMART Flint** for a persistent deployment. The installer generates a master encryption key, database password and temporary setup credential, selects local username/password or OIDC sign-in, and starts PostgreSQL and the hardened service. The generated configuration and setup secrets remain private files in the installation directory. PostgreSQL data resides in that installation's named Docker volume.

Two HTTPS arrangements are available:

- **Existing HTTPS proxy (`external`)**: use your organization's public HTTPS origin. SMART Flint publishes only a loopback HTTP backend on the selected port; configure the existing proxy to forward that origin to the backend. Internal readiness is checked separately. Public HTTPS uses certificate verification; if the proxy/certificate is not yet reachable from the controller, the installer reports public HTTPS as pending and does not automatically open a browser. Private enterprise CA trust is not automatically inherited from the host.
- **Automatic HTTPS (`caddy`)**: use a real public DNS hostname resolving to the server, with inbound TCP ports 80 and 443 available. The installer configures Caddy to obtain and renew certificates and preserves its state in named volumes. It does not configure DNS/router/firewall rules. Caddy mode is not used for localhost, private names or the isolated acceptance tests.

For local account authentication behind an existing proxy:

```sh
bash ./install.sh --mode deploy --directory "$HOME/.smart-flint-production" \
  --public-url https://flint.your-domain.com --tls external --auth local --port 3011 \
  --non-interactive --no-open
```

Supply your real HTTPS origin; the example domain above is a placeholder. A source bundle builds the runtime inside Docker when no verified local image/archive is supplied. A trusted prepared image can be selected with `--image <local-reference>`. A release archive can be selected with `--image-archive /path/to/smart-flint-image.tar.gz`; keep its `SHA256SUMS` file alongside it. The installer verifies archive bytes before loading them into Docker. Obtain both archive and checksum index through your trusted distribution channel; an unsigned checksum file alone does not establish publisher identity.

For organization sign-in, choose OIDC in the wizard and enter the exact issuer, client ID and client authentication settings. Register the displayed administrative callback with the provider. Secrets can be entered through the guided workflow or supplied in a private configuration file with `--config`; do not put passwords or client secrets in shell arguments. See [administrative identity](administration.md) for identity linking, first-owner setup and provider requirements.

## First administrator and saved files

The interactive workflow can create the first local administrator with a password entered without echo. The generated `setup-secrets.json` also contains the one-time bootstrap credential. If first-owner setup was deferred, open that private file locally, use **Initial deployment setup** in the console, and create the first **Platform administrator** under **Settings & API → Users & access**. The installer prints the file's path, not its secret values.

Once the first enabled owner exists, bootstrap access is retired automatically. Sign in with the selected account and follow the generated installation instructions to remove the bootstrap credential from the running deployment configuration. For OIDC, provision the provider's exact issuer/subject pair; an email match does not grant access.

Treat the whole installation directory as private deployment material. It contains Compose configuration, generated instructions and setup secrets. The authoritative `installation.json` also contains the full private installation plan, including credentials; it is not a public metadata file. Back it up appropriately and retain the master key separately from database backups. Generated files are not a substitute for the encrypted database backup/restore process in [operations and recovery](operations.md).

## Stop, start and inspect

Use the same installer bundle and installation directory:

```sh
bash ./install.sh --action status --directory "$HOME/.smart-flint-production" --non-interactive --no-open
bash ./install.sh --action stop --directory "$HOME/.smart-flint-production" --non-interactive --no-open
bash ./install.sh --action start --directory "$HOME/.smart-flint-production" --non-interactive --no-open
```

Running the installer again on a recognized installation resumes its saved configuration. It does not regenerate keys/passwords or replace the database. The resolved image ID is kept in `image.lock.yaml` and verified before startup; resume does not silently substitute a changed tag or a new source build. Attempts to change mode, alter the image lock or overwrite unrelated files fail. `stop` preserves named volumes and certificate state. Removing volumes is a deliberate destructive operator action, not part of normal start/stop, resume or upgrade.

`--configure-only` generates a new private installation without starting its services or reserving host ports. An explicitly supplied image/archive is resolved and locked during configuration; without one, the Docker source build is deferred until start. Archive bytes are privately staged and verified before loading. Port checks occur before committing a fresh running installation, so a port conflict can be retried with different choices in the same empty folder. `--help` lists the supported options. Do not edit generated files while the installer is running or use two installer processes against the same directory.

For upgrades, first back up and verify recovery, then follow the release-specific operational procedure. Resume is not an automatic upgrade mechanism, and recreating an installation with a new random key cannot recover an existing encrypted database. See [release preparation](releasing.md) and [operations](operations.md).

## Validation and boundaries

`scripts/test-installer.mjs` uses fresh temporary directories, alternate ports, local synthetic identities and disposable Docker projects. It exercises the public shell installer, configuration-only setup, private secrets, start/status/stop/resume persistence, first-owner handoff, safe failure cases and a synthetic patient launch through the sandbox. TLS for the deployment fixture uses an explicit temporary test CA without changing system trust.

Installer checks complement the broader [production validation](release-validation.md). New vendor/pathway qualification and native-device acceptance remain separate joint testing tasks; installation success does not establish EHR compatibility.
