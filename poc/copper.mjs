// Copper wire theft (GAME-91): strip the copper out of a lamppost with pliers.
// Server side. The lamp goes dark and its wiring lies on the sidewalk until the town
// crew fixes it. Every lamp you strip costs the town money and wears your pliers down.
//
// Hooks in server.mjs: initCopper(ctx) once at start, then
//   copper.start(session, lampEntity)  when the player presses E at a lamppost
//   copper.tick(now)                   every physics tick (finishes or cancels strips)
//   copper.meta(entity, objectState)   while building the meta payload
//   copper.playerMeta(player)          per-player fields for the meta payload
//
// Tools live in the pockets, same shape as the lighter (GAME-86) and the shared items
// (GAME-82): save.players[pid].items.pliers = { uses }. Gone at 0 uses. The server pushes
// { t: 'inv', pliers: uses } privately on join and whenever it changes.

export function initCopper(ctx) {
  const { MAP, ACTIONS, save, sessions, addEntity, addDamage, broadcast, posOf } = ctx;
  const A = ACTIONS.lamppost;
  const PLIERS_USES = 3;          // a cheap pair of pliers survives three lamps
  const REACH = 2.2;              // stay this close to the pole while stripping
  const lamps = [];

  for (const l of MAP.lampposts || []) {
    lamps.push(addEntity({ id: l.id, kind: 'fixture', type: 'lamppost', fixedPos: [l.p[0], 0.9, l.p[2]], state: {} }));
  }
  for (const s of MAP.shops || []) {
    addEntity({ id: s.id, kind: 'fixture', type: s.sells === 'pliers' ? 'buy_pliers' : 'shop', fixedPos: s.p, state: {} });
  }

  // ---------- tools ----------
  const items = p => (p.items ||= {});
  // GAME-82's dumpster finds pocket pliers as `true`: that is a fresh pair.
  const usesOf = p => { const v = items(p).pliers; return v === true ? PLIERS_USES : (v && v.uses) || 0; };
  const hasTool = p => usesOf(p) > 0;
  function sendInv(p) {
    const s = sessions.get(p.id);
    if (s && s.ws && s.ws.readyState === 1) s.ws.send(JSON.stringify({ t: 'inv', pliers: usesOf(p) }));
  }
  function giveTool(p, uses = PLIERS_USES) { items(p).pliers = { uses: Math.max(usesOf(p), uses) }; sendInv(p); }
  function useTool(p) {
    const left = usesOf(p) - 1;
    if (left <= 0) items(p).pliers = undefined; else items(p).pliers.uses = left;
    sendInv(p);
    return Math.max(0, left);
  }
  // Private line for one player (shows in their feed); public lines pop over the vagrant.
  function tell(s, text) { if (s.ws && s.ws.readyState === 1) s.ws.send(JSON.stringify({ t: 'fx', kind: 'say', id: s.entity.id, text })); }

  // Buying pliers at Sunny Mart: the "acquire" route. Panhandling pays for it.
  function buy(s, shop) {
    const e = s.entity, p = e.player, price = ACTIONS.buy_pliers.price;
    if (hasTool(p)) return tell(s, 'You already have pliers.');
    if ((p.cash || 0) < price) return tell(s, `Pliers cost $${price}. Go panhandle at the stop sign.`);
    p.cash -= price;
    giveTool(p);
    tell(s, `Bought pliers for $${price}. Good for ${PLIERS_USES} lampposts.`);
  }

  // ---------- stripping ----------
  function start(s, lamp) {
    const e = s.entity, p = e.player, now = Date.now();
    if (lamp.type === 'buy_pliers') return buy(s, lamp);
    if (lamp.type !== 'lamppost') return;
    if (now < (lamp.state.strippedUntil || 0)) return tell(s, 'Somebody already picked this one clean.');
    if (lamp.state.by && lamp.state.by !== e.id) return tell(s, 'Someone is already stripping this one.');
    if (s.strip) return;
    if (!hasTool(p)) return tell(s, 'You need pliers. Dig through a dumpster or buy some at Sunny Mart.');
    const t = e.body.translation();
    s.strip = { lamp, start: now, until: now + A.holdSec * 1000, from: [t.x, t.z] };
    lamp.state.by = e.id;
    broadcast({ t: 'fx', kind: 'strip', phase: 'start', id: e.id, lamp: lamp.id, ms: A.holdSec * 1000 });
  }

  function cancel(s, why) {
    const st = s.strip; if (!st) return;
    st.lamp.state.by = null; s.strip = null;
    broadcast({ t: 'fx', kind: 'strip', phase: 'cancel', id: s.entity.id, lamp: st.lamp.id, why });
  }

  function finish(s, now) {
    const st = s.strip, lamp = st.lamp, e = s.entity, p = e.player;
    s.strip = null; lamp.state.by = null;
    lamp.state.strippedUntil = now + A.repairSec * 1000;
    const left = useTool(p);
    p.cash = (p.cash || 0) + A.cash;
    p.copper = (p.copper || 0) + 1;
    addDamage(p, A.cost, posOf(lamp), A.verb);
    broadcast({ t: 'fx', kind: 'strip', phase: 'done', id: e.id, lamp: lamp.id, cash: A.cash, left });
  }

  function tick(now) {
    for (const s of sessions.values()) {
      const st = s.strip; if (!st) continue;
      if (!s.ws || s.ws.readyState !== 1) { cancel(s, 'left'); continue; }
      const t = s.entity.body.translation(), lp = st.lamp.fixedPos;
      if (Math.hypot(t.x - lp[0], t.z - lp[2]) > REACH + 0.6 || Math.hypot(t.x - st.from[0], t.z - st.from[1]) > 1.0) { cancel(s, 'moved'); continue; }
      if (now >= st.until) finish(s, now);
    }
  }

  function meta(e, o) {
    if (e.type !== 'lamppost') return;
    const now = Date.now();
    if ((e.state.strippedUntil || 0) > now) o.stripped = 1;
    if (e.state.by) o.busy = 1;
  }

  const playerMeta = p => ({ copper: p.copper || 0 });

  return { start, tick, meta, playerMeta, cancel, hasTool, giveTool, useTool, sendInv, lamps };
}
