# THRESHOLD

A first-person browser horror game built with Vite, React, TypeScript, Tailwind CSS, and Three.js. The default experience is an endless, chunk-streamed data-center labyrinth seen through a deteriorating VHS camcorder. A separate 30-chapter survival campaign remains available with procedural Backrooms levels, objectives, multiplayer rooms, proximity voice, and a persistent animated hunter.

Source repository: [duolahypercho/backrooms](https://github.com/duolahypercho/backrooms)

## Architecture

- React and TypeScript render the application shell: lobby, waiting room, HUD, controls, and accessibility structure.
- The existing imperative Three.js runtime owns procedural generation, rendering, lighting, animation, AI, and the frame loop.
- Tailwind CSS is available for new interface work; the bespoke stylesheet remains responsible for the cinematic horror treatment.
- React mounts the complete DOM contract before dynamically starting the Three.js runtime, keeping the game engine independent from UI re-renders.

## Endless data center

Opening `/` launches **SITE ∞**, an exploration-only mode with no exit, objectives, combat, monster, death state, or finite map edge. Use `?endless=1&seed=1234` to share a deterministic layout; use `?campaign=1&level=0` to enter the original campaign.

- Signed global cell coordinates generate topology and content without storing a world extent. Shared edges are canonical, reload order does not change a sector, and guaranteed cross-aisles plus divider gates keep the infinite grid connected.
- A bounded chunk manager keeps only the nearby 3×3 mobile or 5×5 desktop sector window alive. Rendered geometry shifts around a floating origin while global coordinates and sector identities remain stable.
- Long server aisles are interrupted by empty maintenance bays, abandoned desks and chairs, cabinets, floor cables, vents, broken fixtures, and rare warm-lit rooms.
- Rack faces carry deterministic green, red, blue, and cyan LEDs, including independently blinking indicators. Fluorescent cohorts remain steady, flicker, fail, or glow warm while a local light pool keeps darkness readable.
- Persistent scanlines, grain, rolling tracking, chromatic slips, dropout bands, `REC`, timestamp, timecode, and sector readouts create the camcorder presentation during play—not only on menus.
- The sound engine layers electrical room tone, ventilation, server rotors, fluorescent ballast, hard-drive seeks, and footsteps. A capped nearest-source pool uses HRTF panning and distance gain so machinery becomes clearer as the player approaches it.

## Chapters

- **Levels 0–5:** The Lobby, Maintenance, Lower Tunnels, Hotel Corridors, Server Farm, and Cold Storage.
- **Levels 6–13:** Abandoned Mall, Hospital Ward, Parking Structure, School Halls, Office Atrium, Subway Service, Industrial Laundry, and Empty Supermarket.
- **Levels 14–21:** Indoor Pool, Movie Theater, Research Lab, Apartment Corridors, Freight Depot, Archive Stacks, Greenhouse, and Data Center Annex.
- **Levels 22–29:** Airport Concourse, Museum Storage, Hotel Basement, Power Substation, Flooded Station, Snowbound Resort, Concrete Megastructure, and Threshold Core.

The campaign descends continuously from Level 0 through Level 29. The Threshold Core closes the loop and returns survivors to Level 0 for a new seeded run.

Each chapter has its own creature silhouette, motion, senses, sounds, hunt rhythm, and recovery window. The creature sees open sightlines, notices carried light, hears movement and loud interactions, searches your last known location, and can be escaped by breaking line of sight and disappearing into a genuinely dark area.

## Modular worlds and characters

Levels and multiplayer characters are auto-discovered content plugins. Add either `src/levels/<slug>/level.js` or `src/levels/<slug>.level.js` and it joins the campaign automatically; add the matching character form under `src/characters/` and it joins the deterministic avatar catalog. There is no central registry to edit. See [AGENTS.md](AGENTS.md), [the level guide](src/levels/README.md), and [the character guide](src/characters/README.md).

Every run uses a shared seed to vary maze topology, prop clusters and colors, broken fixtures, objective/archive locations, rare abandoned scenes, collapsed non-graphic wanderers, chair piles, black motes, audio events, presentation glitches, and monster timing. Multiplayer fingerprints the complete level catalog, character IDs and versions, and shared-world algorithm revision; incompatible builds are rejected before a player can create or join a room.

## Survival loop

- The flashlight has a campaign-persistent battery. Turn it off to conserve charge; an empty light slowly recovers only a small emergency reserve.
- Darkness is useful. Under a failed fixture, switch the light off, stay quiet, and hold still until the HUD confirms **UNSEEN**. Moving, making noise, or being illuminated exposes you again.
- `Q` fires a short camera flash. It reveals the room but consumes 28–32% charge, makes a loud noise, and can make the creature look directly at you.
- Three optional archive recordings are hidden in every chapter. Playing one restores some flashlight charge and reveals a fragment of the facility's story.
- Fuses and valves must be held to completion. Repairs become louder as they progress, creating a risk-reward choice during a hunt.
- Fear now follows local danger rather than a timer. It rises through pursuit, darkness, isolation, and low charge, then recovers in reliable light or beside a teammate.

## Run locally

Requires Node.js `^20.19.0` or `>=22.12.0`.

```bash
npm install
npm run dev
```

Open `http://127.0.0.1:5173/`, select **BEGIN RECORDING**, and allow pointer lock. The development command starts both the game and its room server. Select **PLAY 30-LEVEL CAMPAIGN** on the landing screen for the survival game.

## Cooperative multiplayer

1. Select **HOST**, choose a callsign, and choose **PUBLIC** or **UNLISTED**.
2. Select **OPEN ROOM**, then use **SHARE INVITE** to send a direct join link (or share the five-character code).
3. Other players can select **ROOMS** and choose a public signal, or select **JOIN** and enter any room code directly.
4. In the four-player assembly room, choose a suit and select **READY UP**. When every connected survivor is ready, the host can select **START RUN**; each player then enters the level.

The room directory shows every public, occupied room on the connected multiplayer server, up to a denial-of-service-safe cap of 50 entries. It exposes only the room code, level, phase, connected player count, capacity, and joinability—never player names, IDs, positions, world seeds, objectives, monster state, or reconnect tokens. Unlisted rooms remain reachable to anyone who has their code; they are unlisted, not password-protected.

Rooms synchronize the campaign seed, maze layout, players, held objectives, shared archives, camera flashes, monster recovery, deaths, and level transitions. The active host owns the monster simulation and validates proximity, interaction duration, and flash cooldowns. Authority moves automatically if that player pauses, leaves, dies, or backgrounds the game.

### Voice chat

After joining a room, select **VOICE OFF** in the co-op HUD to grant microphone access and connect to opted-in teammates. **MIC LIVE** mutes or unmutes without leaving voice; selecting **VOICE ON** releases the microphone completely. Voice is spatially panned and gently attenuated using teammate positions for a more immersive in-level soundscape.

Audio travels peer-to-peer over WebRTC. The room server validates and relays only short-lived connection negotiation messages; it does not receive, record, or store the conversation. Voice never requests the microphone automatically, stops on room exit or page navigation, and pauses the local track while the tab is hidden.

For another device on the same network, everyone should open the `Network` address printed by `npm run dev`. Open that network address before copying an invite so the link contains a reachable host address. Local firewalls must allow ports `5173` and `8787`.

The default room service supports local and LAN play at `<page-host>:8787/multiplayer`, using `ws://` from HTTP pages and `wss://` from HTTPS pages to avoid mixed-content blocking. On a non-local HTTPS deployment, the client automatically falls back to the shipped room service at `wss://painful-jemmy-duolahypercho-f5a93587.koyeb.app/multiplayer`, so Vercel co-op still works when `VITE_MULTIPLAYER_URL` is omitted. Set `VITE_MULTIPLAYER_URL` at build time to override that fallback with another public `wss://` service; the explicit environment value always wins. All players browsing the same room list must connect to the same WebSocket service; separate self-hosted servers have separate directories.

The server accepts `MULTIPLAYER_HOST`, `MULTIPLAYER_PORT`, `MULTIPLAYER_PATH`, and `MULTIPLAYER_MAX_PLAYERS` environment variables. It defaults to `0.0.0.0`, port `8787`, path `/multiplayer`, and four players per room. The capacity can be lowered to two or three but is capped at four. Rooms are held in memory and disappear when the server restarts. For an internet deployment, terminate TLS at a reverse proxy, forward the configured WebSocket path, use `wss://`, apply connection limits, and do not treat room codes as authentication.

Voice is opt-in per player (`VOICE OFF` → grant mic → `VOICE ON`). Both players must enable it. The client falls back to public STUN when `VITE_VOICE_ICE_SERVERS` is empty; for stubborn NATs serve over HTTPS/WSS and add TURN entries. Do not embed permanent TURN secrets in a public client build. Room text chat uses Enter while in a co-op room (server-stamped, rate-limited). WebRTC peers can receive network-address metadata during connection setup, and the four-player mesh can still be demanding on mobile devices.

### Self-hosting

See the [multiplayer server self-hosting guide](server/README.md) for a copyable environment template, local verification, managed Web Service and Koyeb configuration, Vercel wiring, reverse-proxy setup, voice requirements, scaling limitations, security guidance, and troubleshooting.

## Controls

- `WASD` or arrow keys: move
- Mouse: look
- `Shift`: run
- `Ctrl` or `C`: crouch
- `F`: toggle flashlight
- `Esc`: pause and release the mouse

Campaign-only controls:

- `Q`: use a loud, battery-hungry camera flash
- Hold `E`: repair a fuse or valve
- `E`: play an archive, check a lock, or open the EXIT
- `Enter`: open room chat (co-op)

Touch devices use a movement pad, right-side swipe look, run and crouch controls, and a flashlight button. Campaign mode also exposes flash and contextual interaction controls. Touch targets reflow for small phones, and sound/voice controls remain usable during play.

The game honors the operating system's **Reduce Motion** preference by disabling automatic blackout flicker and sharply reducing camera-flash intensity. The normal presentation contains flashing lights.

## Production build

```bash
npm run build
npm run validate:content
npm test
npm run preview
npm run server:multiplayer
```

The production output is written to `dist/`. Run the preview and multiplayer commands in separate terminals.
