// AGORA v2 — hub en vivo: long-poll de agentes (bloquea hasta que les toca) y
// SSE para las dos interfaces. Es la pieza que hace que esperar no cueste tokens.

import { currentTurn, publicRoom } from '../engine/index.mjs';

export class LiveHub {
  constructor(hall) {
    this.hall = hall;
    this.waiters = new Map();   // code -> Set<{agentId, stamp, since, resolve, timer}>
    this.clients = new Set();   // {code, res, timer}
  }

  stamp(room) {
    return room.status + ':' + (room.status === 'closed' ? 'closed' : room.phase.name);
  }

  deliver(room, agentId, since = 0) {
    return currentTurn(room, agentId, { since, record: true });
  }

  // Despierta a quien ya tiene trabajo y avisa a las interfaces.
  notify(code) {
    const room = this.hall.get(code);
    if (!room) return;
    const set = this.waiters.get(code);
    if (set) {
      for (const w of [...set]) {
        let turn = null;
        try { turn = currentTurn(room, w.agentId, { record: false }); } catch { turn = null; }
        if (!turn || turn.action !== 'wait' || this.stamp(room) !== w.stamp) {
          clearTimeout(w.timer);
          set.delete(w);
          try { w.resolve(this.deliver(room, w.agentId, w.since)); }
          catch { w.resolve(null); }
        }
      }
      if (!set.size) this.waiters.delete(code);
    }
    let payload = null;
    for (const c of this.clients) {
      if (c.code !== code) continue;
      if (!payload) payload = `data: ${JSON.stringify({ type: 'update', room: publicRoom(room) })}\n\n`;
      try { c.res.write(payload); } catch { this.dropClient(c); }
    }
  }

  // La sala dejó de existir (la borró el humano): quien esperaba turno se suelta —no hay nada
  // que esperar— y quien la estaba mirando recibe el aviso, en vez de quedarse con una sala
  // fantasma en pantalla hasta que refresque a mano.
  drop(code) {
    const set = this.waiters.get(code);
    if (set) {
      for (const w of [...set]) {
        clearTimeout(w.timer);
        try { w.resolve(null); } catch { /* el agente ya no está */ }
      }
      this.waiters.delete(code);
    }
    for (const c of this.clients) {
      if (c.code !== code) continue;
      try { c.res.write(`data: ${JSON.stringify({ type: 'deleted', code })}\n\n`); }
      catch { this.dropClient(c); }
    }
  }

  // Persiste si el barrido cambió algo y notifica. Se usa en el reloj global.
  sweepNotify(code) {
    const room = this.hall.get(code);
    if (!room) return null;
    if (room.__changed) this.hall.persist(room);
    this.notify(code);
    return room;
  }

  // Long-poll: responde ya si hay acción; si no, se bloquea hasta el plazo.
  waitForTurn(code, agentId, waitSec, since = 0) {
    const room = this.hall.get(code);
    if (!room) return Promise.resolve(null);
    let probe = null;
    try { probe = currentTurn(room, agentId, { record: false }); } catch { return Promise.resolve(null); }
    const immediate = waitSec <= 0 || probe.action !== 'wait' || room.status === 'closed';
    if (immediate) return Promise.resolve(this.deliver(room, agentId, since));

    return new Promise(resolve => {
      const set = this.waiters.get(code) || new Set();
      this.waiters.set(code, set);
      const deadlineMs = Math.max(0, room.phase.deadline - Date.now() + 150);
      const ms = Math.max(1000, Math.min(waitSec * 1000, deadlineMs));
      const entry = {
        agentId,
        since,
        stamp: this.stamp(room),
        resolve,
        timer: null,
      };
      entry.timer = setTimeout(() => {
        set.delete(entry);
        if (!set.size) this.waiters.delete(code);
        this.sweepNotify(code);
        try { resolve(this.deliver(this.hall.get(code) || room, agentId, since)); }
        catch { resolve(null); }
      }, ms);
      set.add(entry);
    });
  }

  subscribe(code, res, req) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*',
    });
    const client = {
      code,
      res,
      timer: setInterval(() => {
        try { res.write(': ping\n\n'); } catch { this.dropClient(client); }
      }, 25_000),
    };
    this.clients.add(client);
    const room = this.hall.get(code);
    if (room) res.write(`data: ${JSON.stringify({ type: 'update', room: publicRoom(room) })}\n\n`);
    req.on('close', () => this.dropClient(client));
    return client;
  }

  dropClient(client) {
    clearInterval(client.timer);
    this.clients.delete(client);
  }

  stats() {
    return { waiters: [...this.waiters.values()].reduce((s, set) => s + set.size, 0), subscribers: this.clients.size };
  }
}

// Reloj del servidor: sin tráfico, los plazos también deben avanzar.
export function startClock(hall, hub, everyMs = 1000, onTick = null) {
  const timer = setInterval(() => {
    let metas = [];
    try { metas = hall.list(); } catch { metas = []; }
    const loaded = [];
    for (const meta of metas) {
      const room = hall.get(meta.code);
      if (!room) continue;
      loaded.push(room);
      if (room.__changed) hub.sweepNotify(meta.code);
    }
    // Las salas ya cargadas van al callback: así el trabajo de fondo interrumpido
    // (verificaciones, sondeos) puede retomarse sin volver a leer el disco.
    if (onTick) { try { onTick(loaded); } catch { /* un tick no debe tumbar el reloj */ } }
  }, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
