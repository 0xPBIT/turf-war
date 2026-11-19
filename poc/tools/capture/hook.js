// ===================== capture hook (GAME-90) =====================
// Injected into the game page by tools/capture/capture.mjs at capture time; the shipped
// client never contains it. It runs inside the game's module, so it can reach the
// camera, scene and viewmodel. Everything is exposed as window.__cap.
const CAP = (() => {
  let cam = null, frames = 0, fixedDt = 0, queue = null;
  const realRAF = window.requestAnimationFrame.bind(window);
  // Fixed game time per frame while recording a clip, so motion is smooth however slow the renderer is.
  try { const getDelta = clock.getDelta.bind(clock); clock.getDelta = function () { const d = getDelta(); if (fixedDt) { this.elapsedTime += fixedDt - d; return fixedDt; } return d; }; } catch {}
  window.requestAnimationFrame = cb => { if (queue) { queue.push(cb); return 0; } return realRAF(cb); };
  const st = document.createElement('style');
  // visibility, not display:none: HUD widgets keep their size (the mini map throws at size 0).
  st.textContent = 'html.cap-nohud body > :not([data-cap-game]), html.cap-nohud body > :not([data-cap-game]) *{visibility:hidden!important}';
  document.head.appendChild(st);
  try { renderer.domElement.dataset.capGame = '1'; } catch {}
  const viewmodel = () => { try { return vm; } catch { return null; } };
  const api = {
    // Fixed camera: x, y (eye height, ~1.6 for a standing player), z, yaw, pitch (radians).
    cam(x, y, z, yaw = 0, pitch = 0) { cam = { x, y, z, yaw, pitch }; },
    free() { cam = null; },
    hud(on) { document.documentElement.classList.toggle('cap-nohud', !on); },
    hands(on) { const v = viewmodel(); if (v) v.visible = !!on; },
    get frames() { return frames; },
    get pose() { return { x: camera.position.x, y: camera.position.y, z: camera.position.z, yaw: camera.rotation.y, pitch: camera.rotation.x }; },
    // Clip recording: stepMode(dt) stops the free-running loop; each step() runs exactly one
    // game frame of dt seconds and returns the canvas as a JPEG data URL. stepMode(0) resumes.
    stepMode(dt) { fixedDt = dt; if (dt) { queue = queue || []; } else if (queue) { const q = queue; queue = null; q.forEach(cb => realRAF(cb)); } },
    step() { const q = queue.splice(0); const now = performance.now(); q.forEach(cb => cb(now)); return renderer.domElement.toDataURL('image/jpeg', 0.92); },
    // Run code inside the game's module scope (shots use this for setup, e.g. lighting fires).
    run(src) { return eval(src); },
  };
  window.__cap = api;
  return {
    frame() {
      frames++;
      if (cam) { camera.position.set(cam.x, cam.y, cam.z); camera.rotation.set(cam.pitch, cam.yaw, 0, 'YXZ'); }
    },
  };
})();
