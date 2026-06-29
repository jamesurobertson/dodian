# Deploying dodian

The simplest live setup: **one small VPS** running the game server + **Caddy** serving
the client and terminating HTTPS/WSS. ~$5/mo, ~15 minutes, one domain.

```
browser ──https──> Caddy (dodian.org) ──┬── static client  (client/freeform)
                                         └── /ws ──> game server (127.0.0.1:8080)
```

## Fast path: automated startup script
Instead of steps 2–5 below, you can have the droplet set itself up on first boot:
1. Push this repo to GitHub (the droplet must be able to `git clone` it — public repo,
   or a token in the URL for a private one).
2. Edit `deploy/cloud-init.sh` (`DOMAIN`, `REPO_URL`, `BRANCH`).
3. When creating the DigitalOcean droplet, paste the whole edited file into the
   **"User data"** field (Advanced options).
4. Boot the droplet, then point the `dodian.org` **A record** at its IP. Caddy keeps
   retrying TLS and goes live within a minute of DNS resolving.

Watch progress on the box with: `tail -f /var/log/dodian-setup.log`.

The manual steps below do the same thing by hand.

## 1. Point the domain at a box
- Get a VPS (Hetzner / DigitalOcean / etc.), Ubuntu 22.04+.
- In your DNS for **dodian.org**, add an **A record** -> the VPS's public IP
  (and an A record for `www` if you want it). Wait for it to propagate.
- Open ports **80** and **443** (and 22 for SSH).

## 2. Install Deno + Caddy on the box
```sh
# Deno
curl -fsSL https://deno.land/install.sh | sh
sudo mv ~/.deno/bin/deno /usr/local/bin/deno

# Caddy
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

## 3. Get the code on the box
```sh
sudo useradd -r -s /usr/sbin/nologin dodian || true
sudo mkdir -p /opt/dodian
sudo git clone https://github.com/jamesurobertson/dodian.git /opt/dodian   # or scp the project there
cd /opt/dodian && git checkout main
sudo chown -R dodian:dodian /opt/dodian
# warm the deno cache so the first run is fast:
sudo -u dodian deno cache gameServer/src/mainInstance.js
```

## 4. Run the game server (systemd)
```sh
sudo cp deploy/dodian-gameserver.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now dodian-gameserver
journalctl -u dodian-gameserver -f      # should print "Listening on http://127.0.0.1:8080/"
```

## 5. Configure Caddy (HTTPS + client + WS proxy)
```sh
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
# edit the domain in /etc/caddy/Caddyfile if not dodian.org
sudo systemctl reload caddy
```
Caddy automatically fetches a Let's Encrypt cert for the domain.

## 6. Done
Open **https://dodian.org**. The client auto-connects to `wss://dodian.org/ws`.

---

## Updating later
```sh
cd /opt/dodian && sudo -u dodian git pull
sudo systemctl restart dodian-gameserver        # server changes
# client changes are static — they're live on the next refresh
```

## When it gets popular (multiple arenas)
One game-server process = one arena (single-threaded loop). To scale:
- Run several game-server processes (one per CPU core) on different internal ports,
  and have Caddy / a small matchmaker route players to a non-full one.
- The repo's `serverManager/` is the coordinator for this (server list + leaderboards).
- Needs: client server-selection + a real control-socket auth token (replace
  `INSECURE_LOCALHOST_SERVERMANAGER_TOKEN`).
- For managed autoscaling instead of a VPS: ship the `Dockerfile` to **Fly.io
  Machines** (start/stop on demand) or **Hathora / Edgegap** (managed game-server
  fleets), and point the client at the allocated instance.

## Alternative: split hosting (no VPS babysitting)
- **Client** -> Cloudflare Pages / Netlify (free, https). Point dodian.org there.
- **Game server** -> Fly.io (builds the Dockerfile, gives you wss). Use a subdomain
  like `play.dodian.org`, and load the client with `#ip=wss://play.dodian.org/`.
