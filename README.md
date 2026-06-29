# Dodian

A freeform, real-time territory-capture **.io** game: glide with your mouse, loop out
of your land and back to claim the area you enclose, and cut other players' trails
(while staying safe inside your own territory). This monorepo contains the game
client, the Deno game server, and server-management code.

The playable client is a single self-contained file at `client/freeform/index.html`.
The game server is a Deno WebSocket server in `gameServer/`.

## Run locally

1. Install [Deno](https://docs.deno.com/runtime/getting_started/installation/) 2.4.1
   (`deno upgrade --version=2.4.1`, or use [dvm](https://github.com/justjavac/dvm) +
   `dvm use`, which reads [.dvmrc](./.dvmrc)).
2. Clone this repository.
3. Start a game server:
   ```
   deno run -A gameServer/src/mainInstance.js -p 9999 -s 200 --bots 12
   ```
4. Serve the client with any static server:
   ```
   (cd client/freeform && python3 -m http.server 8080)
   ```
5. Open <http://localhost:8080>. To play from another device on your LAN, open
   `http://<your-ip>:8080` there (start the game server with `--hostname 0.0.0.0`).

Run `deno run -A gameServer/src/mainInstance.js --help` for server options
(`-p` port, `-s` arena size, `--bots`, `--hostname`, `-g` gamemode).

## Deploy

See **[deploy/DEPLOY.md](./deploy/DEPLOY.md)** for a one-box production setup: Caddy
with automatic HTTPS serving the client and proxying the WebSocket, the game server
as a systemd service, and a DigitalOcean first-boot startup script
(`deploy/cloud-init.sh`). It also covers scaling to multiple arenas.

## Build a standalone server executable

```
deno task build-gameserver
```
produces `dodianGameServer` in `gameServer/out/`; the included `Dockerfile` builds
and runs it.

## Type-check / tests

```
deno task check                 # type-check
deno test -A gameServer/tests/  # unit tests (geometry, territory, collision)
```
