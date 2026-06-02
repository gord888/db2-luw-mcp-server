#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/gord888/db2-luw-mcp-server.git}"
REPO_REF="${REPO_REF:-main}"
INSTALL_DIR="${INSTALL_DIR:-/opt/db2-luw-mcp-server}"
SERVICE_NAME="${SERVICE_NAME:-db2-luw-mcp-server}"
SERVICE_USER="${SERVICE_USER:-db2mcp}"
ENV_FILE="${ENV_FILE:-/etc/db2-luw-mcp-server.env}"
NODE_MAJOR="${NODE_MAJOR:-20}"

log() {
  printf '==> %s\n' "$*"
}

require_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    echo "This script must run as root." >&2
    exit 1
  fi
}

upsert_env() {
  local key="$1"
  local value="$2"

  if grep -q "^${key}=" "${ENV_FILE}" 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${value}|" "${ENV_FILE}"
  else
    printf '%s=%s\n' "${key}" "${value}" >> "${ENV_FILE}"
  fi
}

ensure_env_if_missing() {
  local key="$1"
  local value="$2"

  if ! grep -q "^${key}=" "${ENV_FILE}" 2>/dev/null; then
    printf '%s=%s\n' "${key}" "${value}" >> "${ENV_FILE}"
  fi
}

install_packages() {
  export DEBIAN_FRONTEND=noninteractive

  log "Installing OS prerequisites"
  apt-get update
  apt-get install -y ca-certificates curl git build-essential python3 gpg

  if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | cut -d. -f1 | tr -d 'v')" != "${NODE_MAJOR}" ]]; then
    log "Installing Node.js ${NODE_MAJOR}"
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
    apt-get install -y nodejs
  fi

  log "Using Node $(node -v) and npm $(npm -v)"
}

prepare_user() {
  if ! id -u "${SERVICE_USER}" >/dev/null 2>&1; then
    log "Creating service user ${SERVICE_USER}"
    useradd --system --create-home --home-dir "${INSTALL_DIR}" --shell /usr/sbin/nologin "${SERVICE_USER}"
  fi

  mkdir -p "${INSTALL_DIR}"
}

fetch_source() {
  if [[ -d "${INSTALL_DIR}/.git" ]]; then
    log "Updating source in ${INSTALL_DIR}"
    git -C "${INSTALL_DIR}" fetch --tags origin
    git -C "${INSTALL_DIR}" checkout "${REPO_REF}"
    git -C "${INSTALL_DIR}" pull --ff-only origin "${REPO_REF}"
  else
    log "Cloning ${REPO_URL} (${REPO_REF}) into ${INSTALL_DIR}"
    rm -rf "${INSTALL_DIR}"
    git clone --branch "${REPO_REF}" "${REPO_URL}" "${INSTALL_DIR}"
  fi
}

build_app() {
  log "Installing Node dependencies and building the app"
  cd "${INSTALL_DIR}"
  npm ci
  npm run build
  npm prune --omit=dev
  chown -R "${SERVICE_USER}:${SERVICE_USER}" "${INSTALL_DIR}"
}

write_env_file() {
  log "Ensuring ${ENV_FILE} exists"
  touch "${ENV_FILE}"
  chmod 600 "${ENV_FILE}"

  upsert_env "DB2_MCP_MODE" "${DB2_MCP_MODE:-readonly}"
  ensure_env_if_missing "DB2_MCP_API_KEY" "replace-with-your-api-key"
  ensure_env_if_missing "DB2_MCP_CONNECTION_STRING" "DATABASE=SAMPLE;HOSTNAME=db2.internal;PORT=50000;PROTOCOL=TCPIP;UID=db2_mcp;PWD=change-me;"
  ensure_env_if_missing "LOG_LEVEL" "info"
}

write_service() {
  log "Writing systemd unit /etc/systemd/system/${SERVICE_NAME}.service"
  cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=DB2 LUW MCP Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=${ENV_FILE}
ExecStart=/usr/bin/node ${INSTALL_DIR}/dist/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable --now "${SERVICE_NAME}"
}

verify_health() {
  log "Checking local health endpoint"
  curl -fsS http://127.0.0.1:3000/healthz >/dev/null
}

print_next_steps() {
  cat <<EOF

Deployment complete.

Paths:
  Source checkout : ${INSTALL_DIR}
  Runtime env file: ${ENV_FILE}
  Systemd unit    : /etc/systemd/system/${SERVICE_NAME}.service

Next steps:
  1. Edit ${ENV_FILE} and replace the placeholder connection string and API key.
  2. Set DB2_MCP_MODE to readonly, readonly_procedures, or full depending on needs.
  3. Restart the service:
       systemctl restart ${SERVICE_NAME}
  4. Verify deployment:
       curl http://127.0.0.1:3000/healthz

Recommended end-to-end validation after changing credentials:
  - Call /healthz
  - Make an MCP query such as:
      select * from tmwin.tlorder limit 1
EOF
}

main() {
  require_root
  install_packages
  prepare_user
  fetch_source
  build_app
  write_env_file
  write_service
  verify_health
  print_next_steps
}

main "$@"
