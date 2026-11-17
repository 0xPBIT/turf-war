# Turf War: persistent town proof of concept (GAME-77)

Throwaway prototype that proves the connection model from the design doc. It is not the start of the real game.

What it shows:

- **Persistent login.** First visit picks a name and gets a token in localStorage; next visit you are the same vagrant.
- **Lie down on logout.** Close the tab and after a short grace period your vagrant lies down where you stood, with a Zzz, as a physics body others can push or drag. It is still there after a server restart.
- **One shared, server-authoritative physics world** (Rapier at 60 Hz): walking, jumping, throwing bottles, grabbing and dragging bins, dumpsters and sleeping vagrants.
- **AI traffic** on the server: obeys the traffic light and the 4-way stop, stops for anyone in the street, honks if you stay there.
- **Damage counter and turf.** Every action costs the town money; heat per zone decides who owns the turf.
- **First-person client** in Three.js, with an overview camera on Tab.

Run it:

```
cd poc
npm install
npm start          # http://localhost:3000
```

Open two browser windows (one private) to see two players. Settings: `PORT`, `GRACE_MS` (default 5000), `HEAT_HALF_LIFE_S` (default 600), `DATA_FILE` (default `data/world.json`).

Shortcuts taken on purpose (the real build follows the design doc): JSON over plain `ws` instead of Colyseus and binary snapshots, a JSON save file instead of Postgres, no client-side prediction, single-capsule sleepers instead of ragdolls, and a placeholder map in `map.json` that follows the map contract.
