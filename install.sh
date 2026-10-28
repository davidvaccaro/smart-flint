#!/usr/bin/env bash
# Docker is the only host runtime dependency. No downloaded script is executed.
set -euo pipefail
umask 077
SOURCE_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
INSTALL_DIR="${HOME}/.smart-flint"
CONFIG_FILE=""
IMAGE_ARCHIVE=""
CHECKSUMS=""
NO_OPEN=0
ARGS=()
fail() { printf '%s\n' "$1" >&2; exit 1; }
while [ "$#" -gt 0 ]; do
  case "$1" in
    --directory|--config|--image-archive|--checksums)
      [ "$#" -ge 2 ] || fail "Missing value for $1."
      case "$1" in --directory) INSTALL_DIR="$2";; --config) CONFIG_FILE="$2";; --image-archive) IMAGE_ARCHIVE="$2";; --checksums) CHECKSUMS="$2";; esac
      shift 2;;
    --directory=*) INSTALL_DIR="${1#*=}"; shift;;
    --config=*) CONFIG_FILE="${1#*=}"; shift;;
    --image-archive=*) IMAGE_ARCHIVE="${1#*=}"; shift;;
    --checksums=*) CHECKSUMS="${1#*=}"; shift;;
    --no-open) NO_OPEN=1; ARGS+=("$1"); shift;;
    --help)
      cat <<'HELP'
SMART Flint guided installer (Docker only)

./install.sh                           Guided setup
./install.sh --mode sandbox            Local console and synthetic samples
./install.sh --mode deploy             Secure self-hosted deployment

--directory PATH                      Private installation folder (default: ~/.smart-flint)
--port N                              Console/backend port (default: 3010)
--mock-port N --patient-port N --cds-port N --fhir-port N
--public-url https://HOST --tls external|caddy --auth local|oidc
--config PRIVATE_JSON                 OIDC and optional first-owner credentials
--image REFERENCE                     Explicit existing/registry application image
--image-archive FILE                   Release image with matching SHA256SUMS
--configure-only --non-interactive --no-open
--action start|status|stop             Existing installation; stop retains data

Automatic HTTPS requires public DNS and inbound ports 80/443.
Passwords and provider secrets belong in hidden wizard prompts or a private
configuration file, never command-line arguments. Existing installations are preserved.
HELP
      exit 0;;
    *) ARGS+=("$1"); shift;;
  esac
done
command -v docker >/dev/null 2>&1 || fail 'Install and start Docker Desktop or local Docker Engine, then run this installer again.'
docker version --format '{{.Server.Version}}' >/dev/null 2>&1 || fail 'Docker is unavailable. Start Docker Desktop or the local Docker Engine.'
[ "$(docker info --format '{{.OSType}}' 2>/dev/null)" = linux ] || fail 'Switch Docker Desktop to Linux containers.'
ENDPOINT="${DOCKER_HOST:-$(docker context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null)}"
case "$ENDPOINT" in unix://*) SOCKET="${ENDPOINT#unix://}";; *) fail 'This installer requires a local Unix-socket Docker Engine. Use install.ps1 on Windows; use the documented Compose deployment for remote Docker engines.';; esac
[ -S "$SOCKET" ] || fail 'The local Docker socket could not be found.'
[ ! -L "$INSTALL_DIR" ] || fail 'The installation directory must not be a symbolic link.'
if [ -e "$INSTALL_DIR" ] && [ ! -d "$INSTALL_DIR" ]; then fail 'The installation path must be a private directory.'; fi
if [ -d "$INSTALL_DIR" ] && [ ! -f "$INSTALL_DIR/installation.json" ] && [ -n "$(ls -A "$INSTALL_DIR")" ]; then fail 'The installation directory contains unrelated files. Choose a new empty directory.'; fi
mkdir -p -- "$INSTALL_DIR"
INSTALL_DIR="$(CDPATH= cd -- "$INSTALL_DIR" && pwd -P)"
case "$INSTALL_DIR/" in "$SOURCE_DIR/"*) fail 'Choose an installation directory outside the source checkout so deployment secrets cannot enter image build contexts.';; esac
chmod 700 "$INSTALL_DIR"
host_uid() { if [ "$(uname -s)" = Darwin ]; then stat -f %u "$1"; else stat -c %u "$1"; fi; }
host_mode() { if [ "$(uname -s)" = Darwin ]; then stat -f %Lp "$1"; else stat -c %a "$1"; fi; }
[ "$(host_uid "$INSTALL_DIR")" = "$(id -u)" ] || fail 'The installation directory must be owned by your user account.'
private_input() {
  [ -f "$1" ] && [ ! -L "$1" ] || fail 'Private inputs must be regular files without symbolic links.'
  [ "$(host_uid "$1")" = "$(id -u)" ] || fail 'Private input files must be owned by your user account.'
  PERMISSIONS="$(host_mode "$1")"
  [ $((8#$PERMISSIONS & 077)) -eq 0 ] || fail 'Private files must have permission 0600 or stricter. Restrict their permissions before continuing.'
}
for MANAGED in installation.json compose.yaml setup-secrets.json image.lock.yaml Caddyfile installation.md; do
  if [ -e "$INSTALL_DIR/$MANAGED" ] || [ -L "$INSTALL_DIR/$MANAGED" ]; then private_input "$INSTALL_DIR/$MANAGED"; fi
done
case "$SOURCE_DIR$INSTALL_DIR$SOCKET" in *,*) fail 'Source and installation paths must not contain commas.';; esac
TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/smart-flint-installer.XXXXXXXX")"
cleanup() { rm -rf -- "$TEMP_DIR"; }
trap cleanup EXIT
MOUNTS=(--mount "type=bind,source=$SOURCE_DIR,target=/source,readonly" --mount "type=bind,source=$INSTALL_DIR,target=/installation")
# Docker Desktop's host API socket cannot be filesystem-shared from ~/.docker/run.
# Its standard /var/run socket lives inside the Linux VM and is bindable directly.
if [ "$(uname -s)" = Darwin ]; then MOUNTS+=(-v /var/run/docker.sock:/var/run/docker.sock)
else MOUNTS+=(--mount "type=bind,source=$SOCKET,target=/var/run/docker.sock"); fi
absolute_file() {
  [ -f "$1" ] && [ ! -L "$1" ] || fail 'Installer input files must be regular files without symbolic links.'
  printf '%s/%s\n' "$(CDPATH= cd -- "$(dirname -- "$1")" && pwd -P)" "$(basename -- "$1")"
}
if [ -n "$CONFIG_FILE" ]; then
  CONFIG_FILE="$(absolute_file "$CONFIG_FILE")"
  private_input "$CONFIG_FILE"
  case "$CONFIG_FILE" in *,*) fail 'Input paths must not contain commas.';; esac
  MOUNTS+=(--mount "type=bind,source=$CONFIG_FILE,target=/input/config.json,readonly")
  ARGS+=(--config /input/config.json)
fi
if [ -n "$IMAGE_ARCHIVE" ]; then
  IMAGE_ARCHIVE="$(absolute_file "$IMAGE_ARCHIVE")"
  if [ -z "$CHECKSUMS" ]; then CHECKSUMS="$(dirname -- "$IMAGE_ARCHIVE")/SHA256SUMS"; fi
  CHECKSUMS="$(absolute_file "$CHECKSUMS")"
  case "$IMAGE_ARCHIVE$CHECKSUMS" in *,*) fail 'Input paths must not contain commas.';; esac
  ARCHIVE_NAME="$(basename -- "$IMAGE_ARCHIVE")"
  MOUNTS+=(--mount "type=bind,source=$IMAGE_ARCHIVE,target=/artifact/$ARCHIVE_NAME,readonly" --mount "type=bind,source=$CHECKSUMS,target=/artifact/SHA256SUMS,readonly")
  ARGS+=(--image-archive "/artifact/$ARCHIVE_NAME" --checksums /artifact/SHA256SUMS)
elif [ -n "$CHECKSUMS" ]; then fail '--checksums requires --image-archive.'; fi
export BUILDX_CONFIG="${BUILDX_CONFIG:-$TEMP_DIR/buildx}"
printf '%s\n' 'Preparing the Docker-only SMART Flint installer…'
docker build --quiet --file "$SOURCE_DIR/deploy/Dockerfile.installer" --iidfile "$TEMP_DIR/image.id" "$SOURCE_DIR" >/dev/null || fail 'The installer image could not be built. Check Docker Buildx and internet access.'
INSTALLER_IMAGE="$(cat "$TEMP_DIR/image.id")"
if [ "$(uname -s)" = Darwin ]; then
  SOCKET_GROUP=0
  # Desktop's VM socket is root-writable only. Host ACL/owner checks above
  # remain authoritative; Desktop maps new bind files back to the host user.
  CONTROLLER_USER=0:0
else SOCKET_GROUP="$(stat -c %g "$SOCKET")"; CONTROLLER_USER="$(id -u):$(id -g)"; fi
RUN=(docker run --rm --read-only --tmpfs /tmp:rw,noexec,nosuid,size=256m --cap-drop ALL --security-opt no-new-privileges --user "$CONTROLLER_USER" --group-add "$SOCKET_GROUP")
if [ -t 0 ] && [ -t 1 ]; then RUN+=(-it); else RUN+=(-i); fi
RUN+=("${MOUNTS[@]}" -e HOME=/tmp -e DOCKER_CONFIG=/tmp/docker -e BUILDX_CONFIG=/tmp/buildx -e SMART_FLINT_SOURCE_DIRECTORY=/source -e SMART_FLINT_INSTALL_DIRECTORY=/installation -e "SMART_FLINT_HOST_DIRECTORY=$INSTALL_DIR" -e "SMART_FLINT_INSTALLER_IMAGE=$INSTALLER_IMAGE")
if [ "$(uname -s)" = Darwin ]; then RUN+=(-e SMART_FLINT_HOST_PLATFORM=darwin -e SMART_FLINT_POSIX_PRIVATE=1); fi
RESULT="$INSTALL_DIR/.browser-result.json"
if [ "$NO_OPEN" -eq 0 ]; then
  if [ -e "$RESULT" ]; then [ -f "$RESULT" ] && [ ! -L "$RESULT" ] || fail 'Unexpected browser handoff file.'; rm -- "$RESULT"; fi
  RUN+=(-e SMART_FLINT_BROWSER_RESULT=/installation/.browser-result.json)
fi
"${RUN[@]}" "$INSTALLER_IMAGE" --directory /installation "${ARGS[@]}"
if [ "$NO_OPEN" -eq 0 ] && [ -f "$RESULT" ] && [ ! -L "$RESULT" ]; then
  URL="$(sed -n 's/^{"url":"\([^"]*\)"}$/\1/p' "$RESULT")"
  rm -- "$RESULT"
  case "$URL" in
    http://127.0.0.1:*|https://*)
      if command -v open >/dev/null 2>&1; then open "$URL" >/dev/null 2>&1 || true
      elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL" >/dev/null 2>&1 || true; fi;;
  esac
fi
