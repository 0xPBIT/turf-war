// ===================== player settings (GAME-79) =====================
// Esc (or the gear button) opens the menu. Everything is saved per browser in localStorage.
// Runs inside the look-test module before NET, so tick() and NET can read SET.
const SET = (() => {
  const KEY = 'tw_settings';
  const BIND_ACTIONS = [
    ['fwd', 'Walk forward', 'KeyW'], ['back', 'Walk back', 'KeyS'], ['left', 'Strafe left', 'KeyA'], ['right', 'Strafe right', 'KeyD'],
    ['jump', 'Jump', 'Space'], ['run', 'Run', 'ShiftLeft'], ['act', 'Do the thing', 'KeyE'], ['grab', 'Grab or drag', 'KeyG'],
    ['map', 'Big town map', 'KeyM'],
  ];
  // Arrow keys and the right-hand Shift always work too, whatever the bindings say.
  const ALT = { fwd: 'ArrowUp', back: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', run: 'ShiftRight' };
  const DEFAULTS = {
    sens: 1, invertY: false, touchSens: 1, toggleRun: false,
    fov: 72, bob: 1, quality: 'high', scale: 1, bloom: true, fps: false,
    vol: .8,
    help: true, board: true, xhair: true, tags: true, minimap: true, mapRotate: true,
    binds: Object.fromEntries(BIND_ACTIONS.map(([k, , c]) => [k, c])),
  };
  const s = structuredClone(DEFAULTS);
  try { const saved = JSON.parse(localStorage.getItem(KEY) || '{}'); Object.assign(s, saved, { binds: { ...DEFAULTS.binds, ...(saved.binds || {}) } }); } catch {}
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {} };

  const el = id => document.getElementById(id);
  const keyName = c => !c ? '(none)' : c.startsWith('Key') ? c.slice(3) : c.startsWith('Digit') ? c.slice(5)
    : ({ Space: 'Space', ShiftLeft: 'Left Shift', ShiftRight: 'Right Shift', ControlLeft: 'Left Ctrl', ControlRight: 'Right Ctrl', AltLeft: 'Left Alt', AltRight: 'Right Alt',
      ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Backquote: '`', Tab: 'Tab', CapsLock: 'Caps Lock' })[c] || c;

  // ---------- applying ----------
  const dpr0 = Math.min(devicePixelRatio, 2);
  let runLatched = false;
  function applyVideo() {
    camera.fov = s.fov; camera.updateProjectionMatrix();
    const pr = dpr0 * s.scale * (s.quality === 'low' ? .75 : 1);
    if (Math.abs(renderer.getPixelRatio() - pr) > 1e-3) {
      renderer.setPixelRatio(pr); stylePass.uniforms.dpr.value = pr;
      dispatchEvent(new Event('resize'));            // resizes the composer and the ink buffer
    }
    const shadows = s.quality !== 'low', size = s.quality === 'high' ? 2048 : 1024;
    if (sunLight.castShadow !== shadows || sunLight.shadow.mapSize.x !== size) {
      sunLight.castShadow = shadows; renderer.shadowMap.enabled = shadows;
      sunLight.shadow.mapSize.set(size, size); if (sunLight.shadow.map) { sunLight.shadow.map.dispose(); sunLight.shadow.map = null; }
      scene.traverse(o => { if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => { m.needsUpdate = true; }); });
    }
    bloom.enabled = s.bloom && bloom.strength > .005;
    el('fpsMeter').style.display = s.fps ? 'block' : 'none';
  }
  function applyHud() {
    const show = (id, on) => { const e = el(id); if (e) e.style.visibility = on ? '' : 'hidden'; };
    show('help', s.help); show('board', s.board); show('xh', s.xhair);
    el('help').innerHTML = `Click to look around · <kbd>${keyName(s.binds.fwd)}${keyName(s.binds.left)}${keyName(s.binds.back)}${keyName(s.binds.right)}</kbd> walk · <kbd>${keyName(s.binds.run)}</kbd> run${s.toggleRun ? ' (toggle)' : ''} · <kbd>${keyName(s.binds.jump)}</kbd> jump<br>Click throws a bottle · <kbd>${keyName(s.binds.act)}</kbd> do the thing · <kbd>${keyName(s.binds.grab)}</kbd> grab or drag · <kbd>${keyName(s.binds.map)}</kbd> map · <kbd>Esc</kbd> settings<br>Close the tab and your vagrant lies down right where you are.`;
  }
  function applyAll() { applyVideo(); applyHud(); }

  // ---------- input helpers used by tick() and NET ----------
  const down = a => keys.has(s.binds[a]) || (ALT[a] ? keys.has(ALT[a]) : false);
  const running = () => s.toggleRun ? runLatched : down('run');
  const isBind = (a, code) => code === s.binds[a] || code === ALT[a];
  const lookMouse = (dx, dy) => { const k = .0022 * s.sens; yaw -= dx * k; pitch = Math.max(-1.45, Math.min(1.45, pitch - dy * k * (s.invertY ? -1 : 1))); };
  const lookDrag = (dx, dy, touch) => { const k = (touch ? .006 * s.touchSens : .004 * s.sens); yaw -= dx * k; pitch = Math.max(-1.2, Math.min(1.2, pitch - dy * k * (s.invertY ? -1 : 1))); };
  const bob = () => s.bob;
  const vol = () => s.vol;
  const tags = () => s.tags;

  // ---------- menu ----------
  const menu = el('settings');
  let open = false, rebinding = null, openedAt = 0;
  const isOpen = () => open;
  function openMenu() {
    if (open) return; open = true; openedAt = performance.now(); keys.clear(); runLatched = false;
    menu.style.display = 'grid'; el('gear').style.display = 'none';
    if (document.pointerLockElement) document.exitPointerLock();
  }
  function closeMenu(relock) {
    if (!open) return; open = false; rebinding = null; renderBinds();
    menu.style.display = 'none'; el('gear').style.display = '';
    if (relock && matchMedia('(pointer:fine)').matches && getComputedStyle(el('login')).display === 'none') { const p = canvas.requestPointerLock?.(); p?.catch?.(() => {}); }
  }
  // Esc while playing: the browser drops pointer lock and swallows the key, so open on lock loss.
  let lockedAt = 0;
  document.addEventListener('pointerlockchange', () => {
    if (document.pointerLockElement === canvas) lockedAt = performance.now();
    else if (!open && lockedAt) openMenu();
  });
  // Runs before the game's own key handlers (capture phase on window).
  addEventListener('keydown', e => {
    if (rebinding) {
      e.preventDefault(); e.stopImmediatePropagation();
      if (e.code !== 'Escape') {
        for (const k in s.binds) if (s.binds[k] === e.code) s.binds[k] = s.binds[rebinding];   // swap on clash
        s.binds[rebinding] = e.code; save(); applyHud();
      }
      rebinding = null; renderBinds(); return;
    }
    if (e.code === 'Escape') {
      e.preventDefault();
      if (!open) openMenu(); else if (performance.now() - openedAt > 300) closeMenu(true);   // same Esc that dropped the lock
      return;
    }
    if (open) { if (e.target.tagName !== 'INPUT') e.stopImmediatePropagation(); return; }
    if (s.toggleRun && !e.repeat && isBind('run', e.code)) runLatched = !runLatched;
  }, true);

  // ---------- building the panel ----------
  const TABS = {
    controls: [
      ['range', 'sens', 'Mouse sensitivity', .1, 4, .05, v => v.toFixed(2) + '×'],
      ['check', 'invertY', 'Invert mouse Y'],
      ['range', 'touchSens', 'Touch look sensitivity', .2, 3, .05, v => v.toFixed(2) + '×'],
      ['check', 'toggleRun', 'Run is a toggle (tap to run, tap to walk)'],
      ['binds'],
    ],
    video: [
      ['range', 'fov', 'Field of view', 55, 110, 1, v => v + '°'],
      ['select', 'quality', 'Graphics quality', [['high', 'High'], ['medium', 'Medium (smaller shadows)'], ['low', 'Low (no shadows, lower res)']]],
      ['range', 'scale', 'Render resolution', .5, 1, .05, v => Math.round(v * 100) + '%'],
      ['check', 'bloom', 'Glow (bloom)'],
      ['range', 'bob', 'Head bob', 0, 1.5, .05, v => Math.round(v * 100) + '%'],
      ['check', 'fps', 'Show FPS'],
    ],
    audio: [
      ['range', 'vol', 'Volume', 0, 1, .01, v => Math.round(v * 100) + '%'],
    ],
    hud: [
      ['check', 'xhair', 'Crosshair'], ['check', 'tags', 'Name tags over vagrants'],
      ['check', 'board', 'Vagrants scoreboard'], ['check', 'help', 'Controls hint'],
      ['check', 'minimap', 'Mini map'], ['check', 'mapRotate', 'Mini map turns with you'],
    ],
  };
  function row(spec) {
    const [type, k, label] = spec, d = document.createElement('div'); d.className = 'srow';
    if (type === 'range') {
      const [, , , min, max, step, fmt] = spec;
      d.innerHTML = `<label for="s_${k}">${label}</label><input type="range" id="s_${k}" min="${min}" max="${max}" step="${step}"><output></output>`;
      const i = d.querySelector('input'), o = d.querySelector('output');
      const show = () => { o.textContent = fmt(+i.value); };
      i.value = s[k]; show();
      i.oninput = () => { s[k] = +i.value; show(); save(); applyAll(); };
      d.sync = () => { i.value = s[k]; show(); };
    } else if (type === 'check') {
      d.classList.add('chk'); d.innerHTML = `<label><input type="checkbox" id="s_${k}"> ${label}</label>`;
      const i = d.querySelector('input'); i.checked = s[k];
      i.onchange = () => { s[k] = i.checked; save(); applyAll(); };
      d.sync = () => { i.checked = s[k]; };
    } else if (type === 'select') {
      d.innerHTML = `<label for="s_${k}">${label}</label><select id="s_${k}">${spec[3].map(([v, n]) => `<option value="${v}">${n}</option>`).join('')}</select>`;
      const i = d.querySelector('select'); i.value = s[k];
      i.onchange = () => { s[k] = i.value; save(); applyAll(); };
      d.sync = () => { i.value = s[k]; };
    } else if (type === 'binds') {
      d.className = 'binds'; d.id = 'bindList';
    }
    return d;
  }
  function renderBinds() {
    const box = el('bindList'); if (!box) return;
    box.innerHTML = '<h4>Keys <small>click one, then press the new key (Esc cancels)</small></h4>' + BIND_ACTIONS.map(([k, label]) =>
      `<div class="brow"><span>${label}</span><button type="button" data-b="${k}" class="${rebinding === k ? 'wait' : ''}">${rebinding === k ? 'press a key…' : keyName(s.binds[k])}</button></div>`).join('');
    box.querySelectorAll('button').forEach(b => { b.onclick = () => { rebinding = rebinding === b.dataset.b ? null : b.dataset.b; renderBinds(); }; });
  }
  const rows = [];
  for (const [tab, specs] of Object.entries(TABS)) {
    const pane = el('sp_' + tab);
    for (const spec of specs) { const r = row(spec); pane.appendChild(r); rows.push(r); }
  }
  renderBinds();
  menu.querySelectorAll('.stabs button').forEach(b => b.onclick = () => {
    menu.querySelectorAll('.stabs button').forEach(x => x.classList.toggle('on', x === b));
    menu.querySelectorAll('.spane').forEach(p => p.hidden = p.id !== 'sp_' + b.dataset.t);
  });
  el('sResume').onclick = () => closeMenu(true);
  el('sReset').onclick = () => { const binds = { ...DEFAULTS.binds }; Object.assign(s, structuredClone(DEFAULTS), { binds }); save(); rows.forEach(r => r.sync?.()); renderBinds(); applyAll(); };
  el('gear').onclick = e => { e.stopPropagation(); openMenu(); };
  el('gear').addEventListener('pointerdown', e => e.stopPropagation());
  menu.addEventListener('pointerdown', e => { e.stopPropagation(); if (e.target === menu) closeMenu(false); });

  // ---------- FPS meter ----------
  let fN = 0, fT = performance.now();
  (function fpsLoop() { fN++; const n = performance.now(); if (n - fT > 500) { el('fpsMeter').textContent = Math.round(fN * 1000 / (n - fT)) + ' fps'; fN = 0; fT = n; } requestAnimationFrame(fpsLoop); })();

  applyAll();
  window.__set = { s, open: openMenu, close: closeMenu, get look() { return [+yaw.toFixed(3), +pitch.toFixed(3)]; } };
  return { down, running, isBind, lookMouse, lookDrag, bob, vol, tags, isOpen, opt: k => s[k] };
})();
