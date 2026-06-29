#!/bin/bash
#
# DigitalOcean droplet startup script ("User data" field) — brings dodian fully live
# on first boot: installs Deno + Caddy, fetches the code, and starts the game server
# and reverse proxy. Paste the whole file into the droplet's User Data field at create
# time (after editing the three variables below).
#
# Prerequisite: the code must be in a git repo the droplet can clone. Push your branch
# to GitHub first. If the repo is PRIVATE, put a read-only token in REPO_URL, e.g.
#   https://<token>@github.com/you/dodian.git
#
# Progress/errors are logged to /var/log/dodian-setup.log.
# DNS note: set the dodian.org A record to the droplet's IP after it boots — Caddy keeps
# retrying the TLS cert and will succeed within a minute of DNS resolving.

set -euxo pipefail
exec > /var/log/dodian-setup.log 2>&1

# ---- edit these ----
DOMAIN="dodian.org"
REPO_URL="https://github.com/jamesurobertson/dodian.git"
BRANCH="freeform-conversion"
ARENA_SIZE=600
BOTS=15
# --------------------

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y curl git unzip debian-keyring debian-archive-keyring apt-transport-https gnupg

# Deno (system-wide)
curl -fsSL https://deno.land/install.sh | sh
install -m 0755 /root/.deno/bin/deno /usr/local/bin/deno

# Caddy
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' |
	gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
	> /etc/apt/sources.list.d/caddy-stable.list
apt-get update
apt-get install -y caddy

# App user + code
id -u dodian >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin dodian
if [ -d /opt/dodian/.git ]; then
	git -C /opt/dodian fetch --all
	git -C /opt/dodian checkout "$BRANCH"
	git -C /opt/dodian pull
else
	git clone --branch "$BRANCH" "$REPO_URL" /opt/dodian
fi
mkdir -p /opt/dodian/.deno
chown -R dodian:dodian /opt/dodian

# Warm the Deno module cache as the service user.
sudo -u dodian env DENO_DIR=/opt/dodian/.deno deno cache /opt/dodian/gameServer/src/mainInstance.js

# Game server (systemd) — substitute arena size + bot count.
sed -e "s/-s 600/-s ${ARENA_SIZE}/" -e "s/--bots 15/--bots ${BOTS}/" \
	/opt/dodian/deploy/dodian-gameserver.service > /etc/systemd/system/dodian-gameserver.service
systemctl daemon-reload
systemctl enable --now dodian-gameserver

# Reverse proxy + HTTPS — substitute the domain.
sed "s/dodian\.org/${DOMAIN}/g" /opt/dodian/deploy/Caddyfile > /etc/caddy/Caddyfile
systemctl reload caddy || systemctl restart caddy

echo "dodian setup complete — set the ${DOMAIN} A record to this droplet's IP if you haven't."
