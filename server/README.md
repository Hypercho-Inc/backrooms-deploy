# Self-hosting the THRESHOLD multiplayer server

THRESHOLD can be played solo without a backend. Cooperative play uses a small Node.js room server for:

- room codes, public room discovery, and the four-player waiting room;
- player and shared-world state relaying;
- host-authoritative objective, monster, death, and level events;
- reconnect and host-authority handoff; and
- WebRTC voice negotiation.

The server does **not** render or simulate the full game, serve the production frontend, record voice, or require a database. Audio travels directly between players over WebRTC after negotiation.

```text
Static host (for example, Vercel)  -> game files -> player browsers
Public WebSocket server            <-> room state <-> player browsers
Player browsers                    <-> WebRTC voice <-> player browsers
```

## Requirements

- Node.js `^20.19.0` or `>=22.12.0`
- A persistent public **Web Service** capable of accepting WebSocket upgrades
- HTTPS/WSS termination for an internet deployment
- The same repository revision on the frontend and server

The client and server compare protocol and content fingerprints. Deploying different level or character versions will intentionally prevent room entry instead of allowing inconsistent game worlds.

## Run it locally

From the repository root:

```bash
npm ci
npm run server:multiplayer
```

The default endpoints are:

```text
Health:    http://127.0.0.1:8787/health
WebSocket: ws://127.0.0.1:8787/multiplayer
```

Verify the process in another terminal:

```bash
curl http://127.0.0.1:8787/health
```

A healthy response starts with `{"ok":true,"protocol":6}` and also reports coarse room and player counts.

`npm run dev` starts both the Vite frontend and this room server for local development. The standalone command above starts only the backend.

## Environment variables

The complete copyable template is [`.env.example`](../.env.example).

### Server runtime

| Variable | Default | Purpose |
| --- | --- | --- |
| `MULTIPLAYER_HOST` | `0.0.0.0` | Interface on which the Node server listens. |
| `MULTIPLAYER_PORT` | `8787` | HTTP and WebSocket listening port. |
| `MULTIPLAYER_PATH` | `/multiplayer` | WebSocket upgrade path. |
| `MULTIPLAYER_MAX_PLAYERS` | `4` | Room capacity; accepted values are 2–4. |

Recommended production values:

```env
MULTIPLAYER_HOST=0.0.0.0
MULTIPLAYER_PORT=8787
MULTIPLAYER_PATH=/multiplayer
MULTIPLAYER_MAX_PLAYERS=4
```

Set these in the hosting provider or process manager. The Node server reads the process environment directly; it does not automatically load the root `.env.example` file.

### Frontend build

These variables belong to the Vite frontend deployment, not the Node server:

| Variable | Required? | Purpose |
| --- | --- | --- |
| `VITE_MULTIPLAYER_URL` | Yes, for public co-op | Public `wss://` URL used by every player. |
| `VITE_VOICE_ICE_SERVERS` | Recommended for public voice | JSON array of WebRTC STUN/TURN server definitions. |

Example:

```env
VITE_MULTIPLAYER_URL=wss://rooms.example.com/multiplayer
VITE_VOICE_ICE_SERVERS=[{"urls":"stun:stun.example.com:3478"},{"urls":"turns:turn.example.com:5349","username":"TEMPORARY_USERNAME","credential":"TEMPORARY_CREDENTIAL"}]
```

All `VITE_*` values are bundled into public browser JavaScript. Never place permanent TURN credentials or other secrets in them. Use short-lived TURN credentials or a credential service for production. Redeploy the frontend whenever a Vite environment value changes.

## Deploy on a managed platform

Use a public **Web Service**, not a private service, worker, sandbox, or database. A private service cannot be reached by browsers, and a worker does not expose the inbound HTTP/WebSocket port this server needs.

Configure a provider-agnostic Web Service with:

| Setting | Value |
| --- | --- |
| Source | This GitHub repository |
| Branch | `main` or your release branch |
| Working directory | Repository root |
| Builder | Node.js buildpack |
| Build command | Provider default / leave blank |
| Run command | `npm run server:multiplayer` |
| Public port | `8787` using HTTP |
| Public route | `/` |
| Health check | HTTP `GET /health` on port `8787` |
| Instances | Exactly 1 |

The public route should be `/`, even though the WebSocket endpoint is `/multiplayer`. Some platforms strip a configured route prefix before proxying. Routing the whole domain preserves `/multiplayer` for the Node WebSocket server.

### Koyeb example

1. Create a new App such as `backrooms` and select **Create Web Service**.
2. Choose GitHub, this repository, the `main` branch, and the buildpack builder.
3. Set the run command to `npm run server:multiplayer`.
4. Add the four `MULTIPLAYER_*` runtime variables shown above.
5. Expose port `8787` publicly with protocol **HTTP** and route `/`.
6. Configure an HTTP health check for `/health` on port `8787`.
7. Select one region close to most players and fix scaling at one instance.
8. Deploy and open `https://YOUR-APP.koyeb.app/health`.

Koyeb terminates TLS at its edge, so the client URL is:

```env
VITE_MULTIPLAYER_URL=wss://YOUR-APP.koyeb.app/multiplayer
```

Free services may sleep while idle. Waking a service introduces a cold start, and every sleep, restart, or deployment removes its in-memory rooms. An always-on instance is more dependable for a public demo.

## Connect a separately hosted frontend

The frontend is a static Vite build and can be deployed to Vercel, Netlify, a CDN, or your own web server:

```bash
npm ci
npm run build
```

Set `VITE_MULTIPLAYER_URL` in the frontend host **before** building. The output is written to `dist/`.

For Vercel:

1. Import this repository and use `npm run build` with output directory `dist`.
2. Add `VITE_MULTIPLAYER_URL=wss://YOUR-BACKEND/multiplayer` to the Production environment.
3. Optionally add `VITE_VOICE_ICE_SERVERS` for public voice.
4. Redeploy the frontend.

Every player who should see and join the same rooms must use the same `VITE_MULTIPLAYER_URL`. Separate server deployments have separate room directories.

## Automated deployment mirror

The production repositories use a one-way, commit-preserving deployment flow:

```text
duolahypercho/backrooms:main -> Vercel
                             -> Hypercho-Inc/backrooms-deploy:main -> Koyeb
```

The copy of [the deployment mirror workflow](../.github/workflows/sync-deployment-mirror.yml) in `Hypercho-Inc/backrooms-deploy` checks canonical `main` every five minutes and fast-forwards the deployment repository with its short-lived, repository-scoped GitHub token. Vercel deploys canonical `main` directly while Koyeb auto-deploys the mirrored `main`, so both services converge on the same commit without storing a cross-repository credential.

Treat the deployment repository as generated and do not commit to it directly. If it diverges, the workflow stops instead of overwriting its commits; reconcile the branch manually and rerun the workflow from deployment `main`.

## Run behind your own reverse proxy

On a VPS, keep the Node process alive with systemd, another process manager, or a container supervisor. Terminate TLS at a reverse proxy and forward WebSocket upgrades without rewriting the path.

Minimal Nginx routing:

```nginx
server {
    listen 443 ssl;
    server_name rooms.example.com;

    # Configure your TLS certificate here.

    location = /health {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
    }

    location /multiplayer {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 75s;
    }
}
```

When the proxy and Node process share a machine, you may bind `MULTIPLAYER_HOST=127.0.0.1` instead of exposing port `8787` directly. The public game must still use `wss://rooms.example.com/multiplayer`.

## Scaling and persistence

Rooms currently live in one Node.js process and are deliberately ephemeral:

- Run exactly **one instance** in one region.
- A restart or deployment removes all active rooms.
- Horizontal autoscaling will split players across separate room maps and must remain disabled.
- Increase the single instance size before considering horizontal scaling.

Running multiple instances safely requires a shared room store, pub/sub fan-out, distributed presence, and coordinated host authority. Those components are not part of the current server.

No account or database is required for the existing guest-room experience. Room codes are invitations, not authentication credentials; use unlisted rooms only as lightweight privacy, not access control.

## Public voice chat

The Node server carries only WebRTC offer, answer, candidate, ready, and hang-up messages. Microphone audio does not pass through this server.

Direct ICE candidates are often enough for LAN testing. Public users may be behind NATs that require STUN and, in some cases, a TURN relay. Configure the frontend's `VITE_VOICE_ICE_SERVERS` value with your chosen provider. If gameplay works but voice never connects between particular networks, missing TURN connectivity is the most likely cause.

## Operational checklist

Before sharing a public URL:

- [ ] `npm test`, `npm run typecheck`, and `npm run validate:content` pass.
- [ ] The backend `/health` endpoint returns `ok: true` over HTTPS.
- [ ] The frontend uses the matching `wss://.../multiplayer` URL.
- [ ] Frontend and backend deploy the same game revision.
- [ ] Scaling is fixed at one backend instance.
- [ ] TLS certificates are valid and automatically renewed.
- [ ] WebSocket upgrades are allowed by the proxy or hosting platform.
- [ ] Connection and request limits exist at the edge.
- [ ] Public voice has been tested across different networks.
- [ ] A four-player room has completed a real cross-device session.

## Troubleshooting

### The health endpoint works, but the WebSocket returns 404

Confirm that `MULTIPLAYER_PATH` and the frontend URL both end in `/multiplayer`. Route the provider domain from `/` rather than mounting the service at `/multiplayer`, which may strip the required prefix.

### The browser blocks the connection

An HTTPS frontend must use `wss://`, not `ws://`. Confirm that the service is public, its TLS certificate is valid, and its proxy supports WebSocket upgrades.

### The server reports incompatible content

Deploy the same Git commit to both frontend and backend, then rebuild the frontend. Protocol, levels, characters, and their versions are fingerprinted intentionally.

### Rooms disappear

The process restarted, redeployed, crashed, or scaled to zero. This is expected while rooms remain in memory. Use one always-on instance for a dependable demo.

### Gameplay works, but voice does not

Serve the page over HTTPS, confirm microphone permission, and configure STUN/TURN through `VITE_VOICE_ICE_SERVERS`. Some network pairs cannot establish direct media without TURN.
