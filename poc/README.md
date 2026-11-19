# Turf War: persistent town proof of concept (GAME-77)

Throwaway prototype that proves the connection model from the design doc. It is not the start of the real game.

What it shows:

- **Persistent login.** First visit picks a name and gets a token in localStorage; next visit you are the same vagrant.
- **Lie down on logout.** Close the tab and after a short grace period your vagrant lies down where you stood, with a Zzz, as a physics body others can push or drag. It is still there after a server restart.
- **One shared, server-authoritative physics world** (Rapier at 60 Hz): walking, jumping, throwing bottles at windows, cars, crates and cones, lighting trash piles, grabbing and dragging crates, cones and sleeping vagrants.
- **AI traffic** on the server: obeys the 4-way stop, stops for anyone in the street, honks if you stay there.
- **Damage counter and turf.** Every action costs the town money; heat per zone decides who owns the turf.
- **The approved art look (GAME-75).** The client is the look test page with its Blend shader (Ink .85, Paint .45, Retro .75) and detailed models, rebuilt for multiplayer. The town is the look-test corner; `town.json` holds its colliders, windows, piles, props, zones and traffic lanes.
- **Smooth movement.** Your own vagrant is predicted locally with the same numbers the server uses. Each input says how long it was held, the server replays it for exactly that long, and acks it, so corrections are a few centimetres and get blended in. Everyone else is interpolated about 110 ms behind the server clock.

- **Settings menu (GAME-79).** `Esc` or the gear button: mouse and touch sensitivity, invert Y, run toggle, rebindable keys, field of view, graphics quality, render resolution, glow, head bob, FPS meter, volume and HUD toggles. Saved per browser in localStorage (`tw_settings`). Code in `tools/settings.js`.
- **Lighters and fire (GAME-86).** You need a lighter to set anything on fire (trash, the dumpster, trees, bushes, plants). It lives in your pockets (`p.items.lighter = {fuel}`, 10 lights); buy one at Sunny Mart for $5 of panhandling cash, or dig one out of a dumpster. Burning plants char to ash-grey husks, spread fire to plants nearby, and grow back after a few minutes. Server: the lighter section in `server.mjs`, `burnables` and `shops` in `town.json`. Client: `tools/fire-client.js`.

- **Movable props (GAME-87).** Everything loose is a server-simulated physics body: shopping carts, the couch, the mattress, cardboard boxes, trash cans, crates and cones. Walk into them to shove them, `G` to grab and drag (carts by the handle; heavy things slow you down), bottles and cars knock them around. Where they come to rest is saved, so everyone sees the same spot and it survives restarts. Grabbing is animated: other players reach out with both arms and lean in, and your own hand drops the bottle and grips. To make any map prop movable, add a line to `props` in `town.json` (types and their physics are in `PROP_TYPES` in `server.mjs`, meshes in `tools/props.js`); resting props sleep and cost nothing on the wire.
- **Turf mini map (GAME-80).** Round map under the damage counter that turns with you: roads and buildings, turf tagged in spray paint (yours, rivals, contested blocks pulse), heat, nearby vagrants, sleepers, cars, fires and the stop sign. The strip under it names the block you're in, who owns it and the heat split. `M` (rebindable) or a click opens the big town map with a legend. Settings > HUD can hide it or keep it north-up. Turf is mock data (`TURF_MOCK` in `tools/minimap.js`) until the turf system exists; add `?turf=live` to colour blocks from this server's owners. When `town.json` carries `roads`/`walks`/`lots`/`buildings`/`decks` rects it draws the town from those, otherwise the look-test corner.

- **Procedural glass (GAME-84).** Windows shatter from the exact point the bottle hit: a seeded radial + ring fracture (`tools/glass.js`), so every break is different and every player sees the same one. Pieces near the hit fall out as physics shards and settle on the sidewalk, the rest stay cracked in the frame; two more hits knock out more. After `boardSec` the town boards it up with plywood, after `repairSec` it's reglazed (window action in `town.json`). Breaks survive restarts. Any pane can use it: `GLASS.shatter(mesh, { seed, hits: [[u, v, side]] })`, `GLASS.board(mesh)`, `GLASS.restore(mesh)`.

- **Fist fights (GAME-85).** With empty hands a click punches (`V` punches any time). Thrown bottles and punches hit other players and the three street vagrants (Sign Guy Sal, Big Dale, Old Gus in `npcs.json`), who stagger, shout, then throw something back or come fist fight you, and walk home once you're down or gone. Everyone has 100 HP; at 0 you're knocked out for 3.5 s. Taking damage pays you $2 per HP. Server code in `combat.mjs` (`hurt(victim, amount, { by, cause, push })` is the one way to deal damage), client in `tools/fight-client.js`. Set `DEV_TP=1` locally to allow `{t:'tp',x,z}` test teleports.

Rebuild the client after changing the look test or the network layer:

```
python3 tools/build-client.py [path/to/look-test/index.html]   # writes public/index.html
```

`tools/net-client.js` is the multiplayer layer, `tools/settings.js` the settings menu and `tools/net-hud.html` the HUD; the script fails loudly if the look test changes under it.

Capture stills, clips and before/after comparisons of the real game (GAME-90): see `tools/capture/README.md`, e.g. `node tools/capture/capture.mjs compare --name my-change --before origin/claude/project-thread-49r4j8`.

Run it:

```
cd poc
npm install
npm start          # http://localhost:3000
```

Open two browser windows (one private) to see two players. Settings: `PORT`, `GRACE_MS` (default 5000), `HEAT_HALF_LIFE_S` (default 600), `DATA_FILE` (default `data/town-v2.json`).

Shortcuts taken on purpose (the real build follows the design doc): JSON over plain `ws` instead of Colyseus and binary snapshots, a JSON save file instead of Postgres, single-capsule sleepers instead of ragdolls, and the small look-test corner instead of the full GAME-74 map.
