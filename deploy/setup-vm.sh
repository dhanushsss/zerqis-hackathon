#!/usr/bin/env bash
# Provision Alibi on a fresh Ubuntu 22.04/24.04 VM (e.g. a Nebius AI Cloud
# Compute instance). Installs Docker, Node 20, Caddy (automatic HTTPS), builds
# Alibi, and runs it as a systemd service under a dedicated user.
#
#   sudo DOMAIN=alibi.example.com REPO=https://github.com/<you>/alibi bash deploy/setup-vm.sh
#
# The Alibi service talks to the local Docker daemon to start sandbox
# containers. Sandbox containers never receive the Docker socket or any secret.
set -euo pipefail
: "${REPO:?set REPO to the git URL of this repository}"
DOMAIN="${DOMAIN:-}"
APP_DIR=/opt/alibi

apt-get update
apt-get install -y ca-certificates curl git gnupg debian-keyring debian-archive-keyring apt-transport-https

# Docker Engine
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi

# Node.js 20
if ! command -v node >/dev/null || ! node -v | grep -q '^v20'; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

# Service user that may use Docker but has no other privileges.
id alibi >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin alibi
usermod -aG docker alibi

if [ ! -d "$APP_DIR/.git" ]; then
  git clone "$REPO" "$APP_DIR"
fi
chown -R alibi:alibi "$APP_DIR"
cd "$APP_DIR"
sudo -u alibi npm ci
sudo -u alibi npm run build
sudo -u alibi docker pull node:20-bookworm-slim
sudo -u alibi docker pull maven:3.9-eclipse-temurin-17
[ -f .env ] || { cp .env.example .env; chown alibi:alibi .env; chmod 600 .env; echo "Edit $APP_DIR/.env and set NEBIUS_API_KEY etc."; }
sed -i 's/^HOST=.*/HOST=127.0.0.1/' .env

cp deploy/alibi.service /etc/systemd/system/alibi.service
systemctl daemon-reload
systemctl enable --now alibi

if [ -n "$DOMAIN" ]; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update && apt-get install -y caddy
  sed "s/{\$DOMAIN}/$DOMAIN/" deploy/Caddyfile > /etc/caddy/Caddyfile
  systemctl reload caddy
  echo "Alibi will be served at https://$DOMAIN once DNS points at this VM."
else
  echo "Alibi is listening on 127.0.0.1:8787. Set DOMAIN to enable HTTPS via Caddy."
fi
