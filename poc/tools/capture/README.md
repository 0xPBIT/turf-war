# In-game capture tool (GAME-90)

Records stills and short clips of the **real game** (same client, same Blend shader, same
server) from fixed camera shots, so a change can be reviewed and shown as a matched
before/after pair. Runs headless in the cloud container; no GPU needed.

## Quick use

```
cd poc && npm install                                     # once

node tools/capture/capture.mjs list                       # the named camera shots
node tools/capture/capture.mjs --name my-change           # stills + clips of your working tree
node tools/capture/capture.mjs --name my-change store stop  # only these shots
node tools/capture/capture.mjs --name my-change --at 4,1.6,1.6,0.12,0.1   # an ad hoc camera

# before/after: BEFORE = the deploy branch, AFTER = your working tree (or --after <ref>)
node tools/capture/capture.mjs compare --name my-change --before origin/claude/project-thread-49r4j8
```

Output goes to `/mnt/project-files/captures/<name>/` (or `poc/captures/` when that folder does
not exist):

- `shoot`: `<label>/<shot>.png` stills and `<label>/<shot>.mp4` clips (+ `<shot>.first.jpg`).
  The label is `working-tree`, `<ref>@<sha>`, or the URL host.
- `compare`: `before/`, `after/`, and `compare/<shot>.png` / `compare/<shot>.mp4` side by side
  with BEFORE / AFTER captions. Attach the `compare/` files in chat.

## Options

| option | meaning |
| --- | --- |
| `--ref <git-ref>` | capture that commit instead of the working tree (temp git worktree + its own server) |
| `--url <url>` | capture a running server, e.g. `https://turf-war-poc.onrender.com`. Look only: the WebSocket is blocked so no "Camera" vagrant is left asleep in the live town (no cars or players then). `--join` connects anyway |
| `--before <ref>` / `--after <ref>` | compare targets (after defaults to the working tree) |
| `--name`, `--out <dir>`, `--label` | where output goes |
| `--size 1280x720` | viewport (stills and clips) |
| `--fps 24` | clip frame rate; clips are rendered frame by frame, so lower fps = faster capture |
| `--settle 4` | seconds to wait after joining before the first shot |
| `--hud` / `--hands` | keep the HUD (stills only) / first-person hands (both hidden by default) |
| `--no-clips` | shots with a path become a still of their first keyframe |

## How it works

- Every run starts its own `server.mjs` on a free port with a **fresh save file**, so both
  sides of a comparison begin from the same world. Your capture player joins as "Camera".
- `hook.js` is injected into the page at load time (Playwright rewrites `index.html`); the
  shipped client is untouched, which is why the hook also works on old commits. It exposes
  `window.__cap`: `cam(x,y,z,yaw,pitch)`, `free()`, `hud(bool)`, `hands(bool)`, `pose`,
  `run(js)` (runs inside the game module), and `stepMode` / `step` for clips.
- **Stills** wait a few rendered frames at the shot's camera, then screenshot.
- **Clips are photo mode**: the local server is paused (SIGSTOP) so cars and players hold
  still, the camera follows a smooth Catmull-Rom path, and game time advances exactly 1/fps
  per frame, so fire, smoke, clouds and bubbles still animate smoothly. ffmpeg encodes H.264.
- Headless rendering is slow (about 1 frame/s at 1280x720 in the cloud container): the page
  takes ~40 s to load and compile shaders, a still takes a few seconds, a 6 s clip at 24 fps
  takes ~3 min. Use `--fps 12` or a smaller `--size` while iterating.

## Shots (`shots.json`)

`cam: [x, y, z, yaw, pitch]` (y 1.6 is standing eye height; yaw 0 looks toward -z, positive yaw
turns toward -x; pitch is radians up). `path` is a list of such keyframes played over
`seconds`. `optional: true` shots only run when named. `setup` is JS run inside the game
module before the shot (e.g. to light a fire or open a menu); `wait` adds seconds before a still.

Add a shot for whatever you change and keep existing names stable so pairs line up. To find
a pose, walk there in a capture and read `__cap.pose`, or try candidates with `--at`.

## Known limits

- AI traffic is server-driven, so cars are not in the same place in before and after.
  Shots sit on sidewalks to keep cars out of the foreground.
- If a change renames `camera.rotation.set(pitch,yaw,0,'YXZ');` or the final `tick();</script>`
  in the client, update the anchors in `inject()` in `capture.mjs`; the tool fails loudly.

## Hands check (GAME-98)

`node tools/capture/hands-check.mjs <poc dir> <out dir>` shoots the first-person hands at the
store in five states: idle, the panhandle and warm clips, knocked out, and ragdolled by a car.
It fakes the server's `ko` / `hit` messages for your own player and steps game time with the
hook, so it is a quick way to check that only one set of hands is ever on screen. Run it on a
`git worktree` of the deploy branch for the "before" side. `ONLY=ko` shoots just the knockout.
