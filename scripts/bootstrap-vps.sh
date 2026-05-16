#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/meridian}"
APP_USER="${APP_USER:-meridian}"
NODE_MAJOR="${NODE_MAJOR:-24}"
REPO_URL="${REPO_URL:-https://github.com/yunus-0x/meridian.git}"

echo "[1/6] Installing base packages"
sudo apt-get update
sudo apt-get install -y curl git build-essential

if ! command -v node >/dev/null 2>&1; then
  echo "[2/6] Installing Node.js ${NODE_MAJOR}"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
  sudo apt-get install -y nodejs
else
  echo "[2/6] Node.js already installed: $(node -v)"
fi

if ! id -u "${APP_USER}" >/dev/null 2>&1; then
  echo "[3/6] Creating app user ${APP_USER}"
  sudo useradd --system --create-home --shell /bin/bash "${APP_USER}"
else
  echo "[3/6] App user already exists: ${APP_USER}"
fi

echo "[4/6] Preparing app directory ${APP_DIR}"
sudo mkdir -p "${APP_DIR}"
sudo chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}"

if [ ! -d "${APP_DIR}/.git" ]; then
  echo "[5/6] Cloning repository"
  sudo -u "${APP_USER}" git clone "${REPO_URL}" "${APP_DIR}"
else
  echo "[5/6] Repository already present, pulling latest"
  sudo -u "${APP_USER}" git -C "${APP_DIR}" pull --ff-only
fi

echo "[6/6] Installing npm dependencies"
sudo -u "${APP_USER}" bash -lc "cd '${APP_DIR}' && npm install"

echo
echo "Bootstrap complete."
echo "Next:"
echo "  1. Edit ${APP_DIR}/.env"
echo "  2. Review ${APP_DIR}/user-config.json"
echo "  3. Install deploy/systemd/meridian.service to /etc/systemd/system/meridian.service"
echo "  4. sudo systemctl daemon-reload && sudo systemctl enable --now meridian"
