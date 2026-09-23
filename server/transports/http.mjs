// AGORA v2 — transporte HTTP: API para agentes, SSE para las interfaces, panel
// estático y administración. Sin dependencias.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  Hall, DebateError, HTTP_STATUS, CAPS, PHASE_ORDER, ROLES, CAPABILITIES,
  createRoom, joinRoom, log, authAgent, applyMove, publicRoom, currentTurn, agentState,
  sweep, finishRoom, closeRoom, exportMarkdown, addPoint, markAbsent, maybeAdvance, rosterSummary,
  attachRepo, attachScaffold, baselineInBackground, repoIndex, readRepoFile, searchRepo, workDiff,
  repoSummary, setWorkNotifier, recordServed, recordCost, DEFAULT_SETTINGS,
  recoverInterruptedWork, pushBranch, revertItem, reapplyItem, refreshFrozenResult,
  healFrozenResults, setResultRefresher, setVerifyCommand, workspaceDirFor, nameOf,
  roomConfig, roomInputFromConfig, templateFromConfig, deliveryOf,
  previewEntry, previewFile, previewHeaders, visualState, setServerBase,
  recordHumanReview, reopenForChanges, humanBrief, humanReviewReport,
} from '../engine/index.mjs';
import { hasRecentSignal } from '../engine/recovery.mjs';
import { LiveHub, startClock } from './live.mjs';
import { manualText, bootstrapText, snippetsFor, joinPrompt, MAX_WAIT_SEC } from '../snippets.mjs';
import { listTemplates, getTemplate, roomInputFromTemplate, saveTemplate } from '../templates.mjs';
import { TournamentManager } from '../tournament.mjs';
import { log as reg } from '../log.mjs';
import { createMemory, memoryConfigFromEnv } from '../memory.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

export function createAgora({ dataDir, appDistDir, clockMs = 1000, memory = undefined } = {}) {
  const hall = new Hall(dataDir, { sweep });

  // Memoria durable (opcional): con un repo configurado, TODO lo que se guarda en disco sale
  // también del disco — es lo que hace que el trabajo vuelva cuando el host borra la carpeta
  // (dormir, reiniciar, desplegar). Sin configuración es una pieza inerte: nada cambia.
  const mem = createMemory({
    dataDir,
    config: memory === false ? null : (memory || memoryConfigFromEnv()),
    logger: reg,
  });
  hall.onPersist = room => mem.touch(room);
  const hub = new LiveHub(hall);
  const tournaments = new TournamentManager({ hall, dir: dataDir });
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dist = appDistDir || path.join(here, '..', '..', 'app', 'dist');

  // ------------------------------------------------------------- registro de la sala
  // Lo que el panel ve, el registro lo cuenta: cada cambio de fase, cada cierre y —cuando
  // nadie mueve nada— el atasco con nombre y apellidos («fase work, 4 min sin actividad,
  // esperando a MuseSpark desde hace 3 min»). Sin esto, una sala que no avanza solo se puede
  // describir de memoria; con esto, se puede leer.
  const lastPhase = new Map();   // code -> { status, phase, at }
  const lastTouch = new Map();   // code -> ms del último movimiento o cambio
  const stallLogged = new Map(); // code -> ms del último latido escrito

  function touch(code, at = Date.now()) { lastTouch.set(code, at); }

  // Cómo terminó la sala, en una línea: es la respuesta a «¿esta tarea se entregó?» sin abrir
  // el panel ni leer el archivo de la sala.
  function closedFields(room) {
    const r = room.result || {};
    return {
      outcome: r.outcome || 'closed',
      reason: r.reason || '',
      winner: r.winner?.title || null,
      consensus: r.consensus?.global ?? null,
      integrated: r.stats?.integrated ?? null,
      workItems: r.stats?.workItems ?? null,
      durationMin: r.stats?.durationMin ?? null,
      checksum: r.checksum || null,
      deliveryKind: r.delivery?.kind || null,
    };
  }

  function logRoomProgress(room) {
    const prev = lastPhase.get(room.code);
    const now = { status: room.status, phase: room.phase?.name || '?', at: Date.now() };
    if (!prev) {
      // Primera vez que este proceso ve la sala. Si ya venía cerrada (se cerró mientras el
      // servidor estaba caído, o antes de arrancar) eso también es noticia: se deja dicho una
      // vez, en vez de perderse por no tener un estado anterior con el que comparar.
      lastPhase.set(room.code, now);
      // Una sala que ya venía cerrada es noticia si se cerró hace poco (mientras el servidor
      // estaba caído o dormido). Un archivo viejo no: eso solo llenaría el registro de un
      // inventario que nadie lee.
      const closedAt = Number(room.result?.closedAt || room.closedAt || 0);
      if (room.status === 'closed' && closedAt && Date.now() - closedAt < 6 * 3600 * 1000) {
        reg.info('room.seen_closed', { room: room.code, to: now.phase, closedAgoMin: Math.round((Date.now() - closedAt) / 60000), ...closedFields(room) });
      }
      return;
    }
    if (prev.phase === now.phase && prev.status === now.status) return;
    const forSec = Math.round((now.at - prev.at) / 1000);
    lastPhase.set(room.code, now);
    const base = {
      room: room.code,
      from: prev.phase,
      to: now.phase,
      forSec,
      agents: Object.values(room.agents || {}).filter(a => a.status === 'active').length,
      agenda: (room.agenda || []).length,
    };
    if (room.status === 'closed') {
      reg.info('room.closed', { ...base, ...closedFields(room) });
      return;
    }
    reg.info('phase.enter', base);
  }

  // El aviso a las interfaces es el único punto por el que pasan TODOS los cambios de sala
  // (movimientos, trabajo de fondo, reloj). Se aprovecha para dejar constancia y para saber
  // desde cuándo la sala está quieta.
  const rawNotify = hub.notify.bind(hub);
  hub.notify = code => {
    try {
      const room = hall.get(code);
      if (room) { logRoomProgress(room); touch(code); }
    } catch { /* el registro no puede impedir un aviso */ }
    return rawNotify(code);
  };

  // Qué se encontró este proceso al arrancar, en UNA línea: si el host durmió, reinició o
  // redesplegó, el estado en disco se fue con él, y esta es la cuenta de lo que sobrevivió.
  // Las salas abiertas se nombran (son las que continúan); las cerradas solo se cuentan.
  try {
    const abiertas = [];
    let cerradas = 0;
    for (const meta of hall.list()) {
      const room = hall.get(meta.code);
      if (!room) continue;
      logRoomProgress(room);
      if (room.status === 'closed') { cerradas += 1; continue; }
      const agents = Object.values(room.agents || {});
      abiertas.push({
        room: room.code,
        phase: room.phase.name,
        deadlineInSec: Math.max(0, Math.round((room.phase.deadline - Date.now()) / 1000)),
        present: agents.filter(a => a.status === 'active').length,
        workItems: (room.work?.items || []).length,
      });
    }
    reg.info('server.rooms', {
      total: abiertas.length + cerradas,
      open: abiertas.length,
      closed: cerradas,
      openRooms: abiertas.slice(0, 8),
      moreOpen: Math.max(0, abiertas.length - 8),
    });
  } catch { /* un listado ilegible no debe impedir arrancar */ }

  // El trabajo de fondo (clonar, verificar, commitear) tiene que persistir y
  // avisar al panel igual que un movimiento: un único gancho para todo.
  setWorkNotifier(room => {
    try {
      // El trabajo asíncrono (verificar y commitear) también cierra el debate
      // cuando ya no queda nada por hacer, igual que un movimiento cualquiera.
      if (room.status !== 'closed') maybeAdvance(room);
      hall.persist(room);
      hub.notify(room.code);
    } catch { /* la sala pudo desaparecer */ }
  });

  // Coherencia al arrancar: un informe congelado que se contradice con el trabajo real
  // (una mejora deshecha, o una verificación que terminó después de congelarse) se
  // recalcula, para que el panel no cuente lo que ya no pasó.
  const healedOnBoot = healFrozenResults(hall);
  if (healedOnBoot.length) {
    console.log(`  ${healedOnBoot.length === 1 ? '1 informe congelado recalculado' : `${healedOnBoot.length} informes congelados recalculados`} al arrancar: ${healedOnBoot.join(', ')}.`);
  }

  // Deshacer una mejora y su verificación posterior cambian lo que el informe congelado
  // contaba: aquí se recalcula, para que el resultado no siga diciendo «integrada» ni
  // «verificando» cuando ya no es cierto.
  setResultRefresher(refreshFrozenResult);

  // El sondeo de línea base cambia lo que el informe cuenta de la verificación (y si la
  // suite ya venía en rojo): al terminar se recalcula el informe congelado si existe, se
  // persiste y se avisa. Un único camino para los tres sitios que lo lanzan.
  function runBaselineNow(room) {
    return baselineInBackground(room, r => {
      try { if (r.result) refreshFrozenResult(r); } catch { /* el informe no debe tumbar el sondeo */ }
      hall.persist(r);
      hub.notify(r.code);
    });
  }

  // Adjuntar el repo nunca tumba la creación de la sala: si el clon falla, la sala
  // sigue existiendo como debate normal y el motivo se devuelve tal cual.
  async function attachRepoOrWarn(room, repoInput) {
    const input = repoInput && typeof repoInput === 'object' ? repoInput : { path: repoInput };
    const defaults = DEFAULT_SETTINGS.repo || {};
    try {
      await attachRepo(room, {
        dataDir,
        source: input.path || input.url || input.source || input.value,
        ref: input.ref || input.branch || null,
        verify: input.verify ?? input.verifyCommand ?? defaults.verifyCommand ?? '',
        verifyTimeoutMs: input.verifyTimeoutMs ?? defaults.verifyTimeoutMs,
        baseline: input.baseline !== false && defaults.baseline !== false,
        pushTo: input.pushTo ?? input.push ?? null,
      });
      room.artifacts.deliveryWarning = null;
      runBaselineNow(room);
      return null;
    } catch (err) {
      const motivo = err?.message || 'No se pudo adjuntar el repositorio.';
      room.artifacts.deliveryWarning = motivo;
      log(room, null, 'phase',
        `No se pudo preparar el repositorio (${motivo}). La sala no tiene dónde escribir código: ` +
        'corrige el repositorio o reabre con un proyecto nuevo antes de conectar harnesses.');
      return motivo;
    }
  }

  // Sin repo, una sala que NO es de solo planificación trabaja en un proyecto nuevo: se crea en
  // su espacio de trabajo, con git dentro, para que el plan ganador acabe en archivos. Si git no
  // está o el proyecto no se puede preparar, la sala sigue viva pero se dice en voz alta: el
  // resultado será un plan y el humano tiene que saber por qué.
  async function attachScaffoldOrWarn(room) {
    const defaults = DEFAULT_SETTINGS.repo || {};
    try {
      await attachScaffold(room, {
        dataDir,
        // La verificación puede venir declarada en las reglas de la sala aunque no haya repo:
        // un proyecto nuevo también se comprueba (p. ej. «node check.mjs» que escriben ellos).
        verify: room.settings?.repo?.verifyCommand || defaults.verifyCommand || '',
        verifyTimeoutMs: room.settings?.repo?.verifyTimeoutMs ?? defaults.verifyTimeoutMs,
      });
      runBaselineNow(room);
      return null;
    } catch (err) {
      const motivo = err?.message || 'No se pudo preparar un proyecto nuevo.';
      room.artifacts.deliveryWarning = motivo;
      log(room, null, 'phase',
        `No se pudo preparar el proyecto nuevo (${motivo}). La sala no tiene dónde escribir código: ` +
        'seguirá el debate y el resultado será un plan.');
      return motivo;
    }
  }

  // El código de un repo privado no sale de aquí sin credenciales: token de agente
  // (que además paga su coste) o el token de administración del panel.
  function authorizeRepo(room, u) {
    const adminTok = u.searchParams.get('admin') || '';
    if (adminTok && adminTok === room.adminToken) return { ok: true, agentId: null };
    const aid = u.searchParams.get('agent') || '';
    const tk = u.searchParams.get('token') || '';
    if (aid && tk) {
      try { authAgent(room, aid, tk); return { ok: true, agentId: aid }; }
      catch { return { ok: false, status: 401, message: 'agentId o token inválido.' }; }
    }
    return {
      ok: false,
      status: 401,
      message: 'La lectura del repo requiere credenciales: ?agent=…&token=… si eres agente, o ?admin=… desde el panel.',
    };
  }

  // Leer código no es gratis para nadie: se contabiliza como coste del agente que
  // lo pidió, para que el presupuesto de la sala refleje también la auditoría.
  function recordRepoRead(room, agentId, payload) {
    try {
      const chars = recordServed(room, agentId, JSON.stringify(payload));
      recordCost(room, agentId, 'repo-read', chars);
    } catch { /* el coste nunca debe impedir leer */ }
  }

  const server = http.createServer((req, res) => {
    // Cada petición queda registrada con su duración, su resultado y quién la hizo. Es lo que
    // permite reconstruir después qué hizo cada harness y qué contestó el servidor.
    const started = Date.now();
    const u = safeUrl(req.url);
    const info = describeRequest(req.method, u);
    let logged = false;
    const finish = () => {
      if (logged) return;
      logged = true;
      const ms = Date.now() - started;
      const status = res.statusCode || 0;
      const fields = {
        m: req.method,
        path: info.path,
        status,
        ms,
        ...(info.room ? { room: info.room } : null),
        ...(info.agent || req.__logAgent ? { agent: info.agent || req.__logAgent } : null),
        ...(info.query ? { q: info.query } : null),
        from: clientOf(req),
      };
      if (status >= 500) reg.error('http.req', fields);
      else if (status >= 400) reg.warn('http.req', fields);
      else if (info.agentFacing || req.method !== 'GET' || ms >= 3000) {
        reg.info('http.req', ms >= 3000 ? { ...fields, slow: true } : fields);
      } else reg.debug('http.req', fields);
    };
    res.on('finish', finish);
    res.on('close', finish);
    route(req, res).catch(err => {
      try {
        reg.error('http.err', {
          m: req.method,
          path: info.path,
          ...(info.room ? { room: info.room } : null),
          ...(info.agent ? { agent: info.agent } : null),
          error: err?.code || 'internal',
          message: err?.message || String(err),
        });
      } catch { /* el registro nunca tapa el error */ }
      try { httpError(res, err); } catch { /* socket muerto */ }
    });
  });

  // El reloj avanza plazos, hace progresar los torneos y reanuda el trabajo de fondo
  // que un reinicio dejó a medias: una verificación o un sondeo de línea base cortados
  // volverían a correr sobre el mismo árbol, y hasta entonces la sala no avanzaba.
  const stopClock = startClock(hall, hub, clockMs, rooms => {
    tournaments.tick();
    for (const room of rooms) {
      try { recoverInterruptedWork(room); } catch { /* una sala rota no debe parar el reloj */ }
    }
    // Latido de atasco, como mucho una línea por minuto y sala: quién tiene la pelota, cuánto
    // lleva la fase sin moverse y cuánto queda de plazo. Es la respuesta escrita a «no avanza».
    for (const room of rooms) {
      try {
        if (room.status === 'closed') continue;
        // Primera vez que se ve esta sala en este proceso: se toma el arranque como referencia.
        // Si no, toda sala cargada de disco se anunciaría como atascada en el primer latido.
        if (!lastTouch.has(room.code)) { lastTouch.set(room.code, Date.now()); continue; }
        const idle = Date.now() - (lastTouch.get(room.code) || 0);
        if (idle < 60_000) continue;
        if (Date.now() - (stallLogged.get(room.code) || 0) < 60_000) continue;
        stallLogged.set(room.code, Date.now());
        const phaseAt = lastPhase.get(room.code)?.at || Date.now();
        const agents = Object.values(room.agents || {});
        const awaiting = agents
          .filter(a => a.awaiting && a.awaiting.phase === room.phase.name)
          .map(a => ({
            name: a.name,
            action: a.awaiting.action,
            sec: Math.round((Date.now() - a.awaiting.since) / 1000),
          }))
          .slice(0, 6);
        reg.info('room.stall', {
          room: room.code,
          phase: room.phase.name,
          status: room.status,
          idleSec: Math.round(idle / 1000),
          phaseSec: Math.round((Date.now() - phaseAt) / 1000),
          deadlineInSec: Math.max(0, Math.round((room.phase.deadline - Date.now()) / 1000)),
          present: agents.filter(a => a.status === 'active').length,
          absent: agents.filter(a => a.status === 'absent').length,
          seat: room.settings?.minAgents ?? null,
          awaiting,
        });
      } catch { /* un latido fallido no puede parar el reloj */ }
    }
  });

  async function route(req, res) {
    const u = new URL(req.url, 'http://local');
    const p = u.pathname.replace(/\/+$/, '') || '/';
    const m = req.method;
    const base = `${protoOf(req)}://${req.headers.host || 'localhost'}`;

    if (m === 'OPTIONS') { send(res, 204, ''); return; }

    // ---------------------------------------------------------- documentos
    if (m === 'GET' && p === '/manual') { send(res, 200, manualText(), 'text/markdown; charset=utf-8'); return; }
    if (m === 'GET' && p === '/api/health') {
      sendJSON(res, 200, {
        ok: true,
        rooms: hall.list().length,
        ...hub.stats(),
        // La memoria, a la vista: cuándo se publicó por última vez y si quedó algo pendiente.
        ...(mem.enabled ? { memory: mem.status() } : null),
        uptimeSec: Math.round(process.uptime()),
      });
      return;
    }
    // El registro, legible desde fuera: ?level=warn, ?room=CODE, ?ev=room. y ?limit=N.
    // Solo devuelve lo que ya es público en el panel (códigos, agentes, fases, errores):
    // los tokens se tachan al escribir, no aquí. Sirve para revisar qué pasó en una sala
    // sin depender de la consola del host ni de que la instancia siga despierta.
    if (m === 'GET' && p === '/api/logs') {
      sendJSON(res, 200, {
        ok: true,
        stats: reg.stats(),
        uptimeSec: Math.round(process.uptime()),
        events: reg.recent({
          limit: parseInt(u.searchParams.get('limit') || '200', 10) || 200,
          level: u.searchParams.get('level'),
          room: u.searchParams.get('room'),
          ev: u.searchParams.get('ev'),
        }),
      });
      return;
    }
    if (m === 'GET' && p === '/favicon.ico') { send(res, 204, ''); return; }

    // panel: cualquier ruta que no sea de la API se resuelve con la SPA
    if (m === 'GET' && !p.startsWith('/api/') && !p.startsWith('/r/') && p !== '/manual') {
      serveApp(res, dist, p);
      return;
    }

    // bootstrap de sala: texto para agentes, panel HTML para navegadores
    const roomLink = p.match(/^\/r\/([a-z0-9]{4,12})$/i);
    if (m === 'GET' && roomLink) {
      const room = hall.get(roomLink[1]);
      if (!room) { send(res, 404, 'Sala no encontrada: ' + roomLink[1], 'text/plain; charset=utf-8'); return; }
      const acceptsHtml = (req.headers.accept || '').includes('text/html');
      if (acceptsHtml) { serveApp(res, dist, '/'); return; }
      send(res, 200, bootstrapText(room, base), 'text/plain; charset=utf-8');
      return;
    }

    // ---------------------------------------------------------- hall
    if (m === 'GET' && p === '/api/hall') { sendJSON(res, 200, { ok: true, rooms: hall.list() }); return; }

    if (m === 'GET' && p === '/api/meta') {
      // Catálogo de LENTES opcionales (no hay reparto de roles): un agente puede
      // declarar una, o ninguna y debatir como su harness. Se mantiene «roles»
      // como alias por compatibilidad con clientes antiguos.
      const lenses = Object.fromEntries(Object.entries(ROLES).map(([k, v]) => [k, { label: v.label, lens: v.lens, caps: v.caps }]));
      sendJSON(res, 200, {
        ok: true,
        phases: PHASE_ORDER,
        caps: CAPS,
        lenses,
        roles: lenses,
        capabilities: CAPABILITIES,
      });
      return;
    }

    if (m === 'GET' && p === '/api/templates') { sendJSON(res, 200, { ok: true, templates: listTemplates() }); return; }

    if (m === 'GET' && p === '/api/agents') {
      const seen = new Map();
      for (const meta of hall.list()) {
        const room = hall.get(meta.code);
        if (!room) continue;
        // Una sola fuente de verdad para «¿está trabajando?»: el MISMO roster que ve la sala.
        // Antes esta lista medía el silencio con su propio umbral de dos minutos y volvía a
        // declarar inactivo a quien estaba escribiendo un parche: dos verdades distintas para el
        // mismo agente, según la pantalla.
        const roster = new Map(rosterSummary(room).map(member => [member.id, member]));
        for (const id of room.order) {
          const a = room.agents[id];
          const member = roster.get(id) || {};
          const key = `${a.name}|${a.harness}|${a.role || ''}`;
          const prev = seen.get(key);
          const lastSeenAt = Math.max(prev?.lastSeenAt || 0, a.lastSeenAt || 0);
          const holding = member.holding || null;
          const entry = {
            name: a.name, model: a.model, harness: a.harness, role: a.role || null,
            capabilities: a.capabilities || [], lastSeenAt,
            status: a.status || 'active',
            // En línea si lo está en alguna sala: sostener trabajo cuenta como señal.
            online: (prev?.online || false) || !!member.online,
            // Y qué tiene en la mano, para poder decir «trabajando en w1» y no solo «en línea».
            holding: holding || prev?.holding || null,
            rooms: [...(prev?.rooms || []), meta.code],
            debates: (prev?.debates || 0) + 1,
          };
          seen.set(key, entry);
        }
      }
      const agents = [...seen.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt).slice(0, 200);
      sendJSON(res, 200, { ok: true, agents });
      return;
    }

    if (m === 'GET' && p === '/api/snippets') {
      const harness = u.searchParams.get('harness') || 'generic';
      const code = (u.searchParams.get('room') || '').toLowerCase();
      const room = code ? hall.get(code) : null;
      if (!room) { sendJSON(res, 404, { ok: false, error: 'not_found', message: 'Sala no encontrada: ' + code }); return; }
      sendJSON(res, 200, { ok: true, ...snippetsFor(harness, { room, base }) });
      return;
    }

    // ---------------------------------------------------------- torneos
    if (m === 'GET' && p === '/api/tournaments') {
      sendJSON(res, 200, { ok: true, tournaments: tournaments.list().map(t => tournaments.view(t)) });
      return;
    }
    if (m === 'POST' && p === '/api/tournaments') {
      const b = await readJSON(req);
      const tpl = b.template ? getTemplate(b.template) : null;
      const input = tpl ? roomInputFromTemplate(tpl, b) : b;
      const t = tournaments.create({
        task: b.task || input.task,
        title: input.title || b.title,
        context: b.context ?? input.context,
        criteria: b.criteria ?? input.criteria,
        agenda: b.agenda || input.agenda || [],
        settings: { ...(input.settings || {}), ...(b.settings || {}) },
        angles: b.angles || 3,
        createdBy: b.createdBy || 'humano',
        repo: b.repo || null,
      });
      // Cada ángulo trabaja sobre su propio clon del mismo proyecto: se adjunta aquí,
      // antes de que nadie entre, para que la auditoría del código sea posible desde el
      // primer turno. Si un clon falla, esa sala sigue como debate normal y se avisa.
      const repoWarnings = [];
      if (t.repo) {
        for (const entry of t.rooms.filter(r => r.needsRepo)) {
          const room = hall.get(entry.code);
          if (!room) continue;
          const warning = await attachRepoOrWarn(room, t.repo);
          if (warning) repoWarnings.push({ code: room.code, warning });
          hall.persist(room);
        }
      }
      for (const r of t.rooms) hub.sweepNotify(r.code);
      sendJSON(res, 200, {
        ok: true, id: t.id, rooms: t.rooms.map(r => ({ code: r.code, angle: r.angle, url: `${base}/r/${r.code}` })),
        repo: tournaments.view(t).repo,
        repoWarnings,
        adminToken: t.adminToken,
      });
      return;
    }
    const tourMatch = p.match(/^\/api\/tournaments\/(t[a-z0-9]{8,14})$/i);
    if (m === 'GET' && tourMatch) {
      const t = tournaments.get(tourMatch[1]);
      if (!t) { sendJSON(res, 404, { ok: false, error: 'not_found', message: 'Torneo no encontrado' }); return; }
      sendJSON(res, 200, { ok: true, tournament: tournaments.view(t) });
      return;
    }

    // ---------------------------------------------------------- crear sala
    if (m === 'POST' && p === '/api/rooms') {
      const b = await readJSON(req);
      // `from`: reabrir una sala con la configuración de otra. Lo que venga en el cuerpo
      // manda; lo que no, se hereda de la sala de origen (tarea, contexto, criterios,
      // agenda, reglas y repo). Así una configuración que ya funcionó no se vuelve a
      // escribir a mano ni se pierde al cerrarse la sala.
      const origin = b.from ? hall.get(String(b.from).toLowerCase()) : null;
      if (b.from && !origin) {
        sendJSON(res, 404, { ok: false, error: 'not_found', message: `Sala de origen no encontrada: ${b.from}` });
        return;
      }
      const seed = origin ? roomInputFromConfig(roomConfig(origin)) : {};
      const merged = { ...seed, ...b };
      // Las reglas se fusionan, no se sustituyen: enviar solo `consensusThreshold` con `from`
      // no puede borrar el idioma, la participación ni el ritmo que traía la sala de origen.
      if (seed.settings && b.settings) merged.settings = { ...seed.settings, ...b.settings };
      const tpl = merged.template ? getTemplate(merged.template) : null;
      const input = tpl ? roomInputFromTemplate(tpl, merged) : merged;
      const room = hall.create({
        title: input.title,
        task: input.task,
        context: input.context,
        criteria: input.criteria,
        agenda: input.agenda,
        template: input.template || null,
        settings: { ...(input.settings || {}), ...(b.settings || {}) },
        createdBy: b.createdBy || 'humano',
        tournament: b.tournament || null,
      });
      // Repo opcional: la sala puede nacer con un proyecto para evaluar y mejorar. Al
      // reabrir con la configuración de otra sala se hereda su repo, salvo que el cuerpo
      // diga otra cosa: `repo: null` explícito significa «esta vez sin repo».
      const repoInput = 'repo' in b ? b.repo : (origin ? seed.repo : null);
      // Entrega: con repo se mejora ese repo; sin repo y sin «solo planificación», la sala crea su
      // propio proyecto y trabaja en él. Una sala solo se queda en plan si el humano lo pidió.
      let repoWarning = null;
      if (repoInput) repoWarning = await attachRepoOrWarn(room, repoInput);
      else if (!room.settings.planOnly) repoWarning = await attachScaffoldOrWarn(room);
      hall.persist(room);
      hub.notify(room.code);
      reg.info('room.create', {
        room: room.code,
        title: room.title,
        task: room.task,
        by: room.createdBy,
        from: origin ? origin.code : null,
        settings: {
          minAgents: room.settings.minAgents,
          expectedAgents: room.settings.expectedAgents,
          planOnly: !!room.settings.planOnly,
          extraordinary: !!room.settings.extraordinary,
          maxDurationMs: room.settings.maxDurationMs,
          consensusThreshold: room.settings.consensusThreshold,
        },
        agenda: room.agenda.map(p => p.label),
        repo: repoSummary(room)?.source || (room.repo?.greenfield ? 'proyecto nuevo' : null),
        repoWarning,
        delivery: deliveryOf(room).kind,
      });
      sendJSON(res, 200, {
        ok: true,
        code: room.code,
        from: origin ? origin.code : null,
        url: `${base}/r/${room.code}`,
        agentUrl: `${base}/r/${room.code}`,
        panelUrl: `${base}/#/d/${room.code}`,
        adminToken: room.adminToken,
        bootstrap: bootstrapText(room, base),
        joinPrompt: joinPrompt(room, base),
        agenda: room.agenda.map(p => ({ id: p.id, label: p.label, options: p.options.map(o => o.label) })),
        repo: repoSummary(room),
        repoWarning,
        // Qué se llevará la sala: código o solo el plan. Se dice al crearla, para que nadie
        // descubra al final que el debate no tenía dónde escribir.
        delivery: deliveryOf(room),
      });
      return;
    }

    // ---------------------------------------------------------- previsualización
    // Lo que los agentes están construyendo, tal cual: el árbol de trabajo de la sala servido en
    // SOLO LECTURA para que el panel lo cargue en un iframe con sandbox. Va antes del matcher
    // genérico de sala porque necesita rutas con subcarpetas y con extensión (preview/src/x.js).
    const prev = p.match(/^\/api\/rooms\/([a-z0-9]{4,12})\/preview(?:\/(.*))?$/i);
    if (m === 'GET' && prev) {
      const prevRoom = hall.get(prev[1]);
      if (!prevRoom) { sendJSON(res, 404, { ok: false, error: 'not_found', message: `Sala no encontrada: ${prev[1]}` }); return; }
      const rel = prev[2] ? decodeURIComponent(prev[2]) : '';
      if (!rel) { sendJSON(res, 200, { ok: true, preview: previewEntry(prevRoom) }); return; }
      const file = previewFile(prevRoom, rel);
      if (file.status !== 200) { sendJSON(res, file.status, { ok: false, error: 'preview', message: file.error }); return; }
      // El origen del propio servidor entra en la política de la página: un iframe con origen opaco
      // no puede casar `'self'`, y sin esto sus módulos e imágenes se quedan por el camino.
      send(res, 200, file.body, file.mime, previewHeaders(file.rel, originOf(req)));
      return;
    }

    // ---------------------------------------------------------- evidencia visual
    // Las capturas que el servidor sacó del artefacto, servidas tal cual (son la prueba) más el
    // índice de lo que cada una retrata. En solo lectura y sin token: el panel las muestra como
    // imágenes y un `<img>` no puede llevar cabeceras. Solo se sirve lo que está REGISTRADO en el
    // índice de la sala: nada de rutas arbitrarias.
    const vis = p.match(/^\/api\/rooms\/([a-z0-9]{4,12})\/visual(?:\/(.+))?$/i);
    if (m === 'GET' && vis) {
      const visRoom = hall.get(vis[1]);
      if (!visRoom) { sendJSON(res, 404, { ok: false, error: 'not_found', message: `Sala no encontrada: ${vis[1]}` }); return; }
      const rel = vis[2] ? decodeURIComponent(vis[2]) : '';
      const state = visualState(visRoom);
      if (!rel) { sendJSON(res, 200, { ok: true, visual: state }); return; }
      const shot = (state.shots || []).find(s => s.id === rel);
      if (!shot?.file) { sendJSON(res, 404, { ok: false, error: 'not_found', message: `Captura desconocida: ${rel}` }); return; }
      // La carpeta de capturas está registrada en el propio índice; solo se sirve un archivo de
      // dentro de ella, y solo si es una toma registrada (nada de rutas arbitrarias).
      const base = state.dir ? path.resolve(state.dir) : null;
      const abs = base && shot.file ? path.resolve(base, path.basename(shot.file)) : null;
      if (!abs || !abs.startsWith(base + path.sep)) {
        sendJSON(res, 403, { ok: false, error: 'forbidden', message: 'La captura no vive en la carpeta de capturas de la sala.' });
        return;
      }
      try { send(res, 200, fs.readFileSync(abs), 'image/png'); }
      catch { sendJSON(res, 404, { ok: false, error: 'not_found', message: `El archivo de la captura ${rel} ya no está en disco.` }); }
      return;
    }

    // ---------------------------------------------------------- sala
    const api = p.match(/^\/api\/rooms\/([a-z0-9]{4,12})(\/[a-z.]+)?$/i);
    if (!api) { sendJSON(res, 404, { ok: false, error: 'not_found', message: 'Ruta desconocida. Empieza en / o /manual' }); return; }
    const code = api[1].toLowerCase();
    const sub = api[2] || '';
    const room = hall.get(code);
    if (!room) { sendJSON(res, 404, { ok: false, error: 'not_found', message: 'Sala no encontrada: ' + code }); return; }
    if (room.__changed) { hall.persist(room); hub.notify(code); }

    if (m === 'GET' && sub === '/public') { sendJSON(res, 200, { ok: true, room: publicRoom(room) }); return; }
    if (m === 'GET' && sub === '/bootstrap') { send(res, 200, bootstrapText(room, base), 'text/plain; charset=utf-8'); return; }
    if (m === 'GET' && sub === '/export.md') {
      send(res, 200, exportMarkdown(room), 'text/markdown; charset=utf-8');
      return;
    }

    // Configuración portable de la sala: qué se preguntó, con qué contexto y criterios, con
    // qué agenda, con qué reglas y con qué repo, más el prompt listo para pegar en un agente.
    // Es lo que el panel muestra entero y lo que permite reabrir una sala igual que esta.
    if (m === 'GET' && sub === '/config') {
      sendJSON(res, 200, {
        ok: true,
        config: {
          ...roomConfig(room),
          prompt: bootstrapText(room, base),
          joinPrompt: joinPrompt(room, base),
        },
      });
      return;
    }

    // Guardar esta sala como plantilla reutilizable: aparece en la sección Plantillas y se
    // reabre con un clic. Escribe en AGORA_TEMPLATES (por defecto templates/), requiere el
    // token de administración de la sala y no pisa una plantilla existente salvo `overwrite`.
    if (m === 'POST' && sub === '/template') {
      const b = await readJSON(req);
      if (!b.adminToken || b.adminToken !== room.adminToken) throw new DebateError('unauthorized', 'adminToken inválido');
      const saved = saveTemplate(
        templateFromConfig(roomConfig(room), {
          id: b.id || null, name: b.name || null, description: b.description || null, icon: b.icon || null,
        }),
        { overwrite: !!b.overwrite },
      );
      sendJSON(res, 200, { ok: true, template: saved, templates: listTemplates({ fresh: true }) });
      return;
    }

    // ---------------------------------------------------------- repo y trabajo
    // Lectura del repo para los agentes (y para el panel con el token de admin).
    if (m === 'GET' && (sub === '/repo' || sub === '/work.diff' || sub === '/work.patch')) {
      const access = authorizeRepo(room, u);
      if (!access.ok) { sendJSON(res, access.status, { ok: false, error: 'unauthorized', message: access.message }); return; }
      if (!room.repo) { sendJSON(res, 404, { ok: false, error: 'no_repo', message: 'Esta sala no tiene repositorio adjunto.' }); return; }
      if (sub === '/work.diff' || sub === '/work.patch') {
        const diff = workDiff(room);
        const body = sub === '/work.diff'
          ? diff
          : `From ${room.repo.baseCommit} Mon Sep 17 00:00:00 2001\nSubject: [agora ${room.code}] ${room.title}\n\n${diff}`;
        send(res, 200, body || '# sin cambios: el debate no llegó a integrar ningún parche\n', 'text/plain; charset=utf-8');
        return;
      }
      const pathParam = u.searchParams.get('path');
      const query = u.searchParams.get('q');
      const charged = access.agentId || null;
      let payload;
      if (query) payload = { kind: 'search', ...searchRepo(room, query, { regex: u.searchParams.get('regex') === '1' }) };
      else if (pathParam) {
        payload = {
          kind: 'file',
          ...readRepoFile(room, pathParam, {
            from: parseInt(u.searchParams.get('from') || '1', 10) || 1,
            lines: parseInt(u.searchParams.get('lines') || '500', 10) || 500,
          }),
        };
      } else payload = { kind: 'index', ...repoIndex(room) };
      if (charged) recordRepoRead(room, charged, payload);
      if (room.__changed) { hall.persist(room); hub.notify(room.code); }
      sendJSON(res, 200, { ok: true, ...payload });
      return;
    }

    if (m === 'POST' && sub === '/join') {
      const b = await readJSON(req);
      const out = joinRoom(room, b);
      hall.persist(room);
      hub.notify(code);
      const who = room.agents[out.agentId] || {};
      reg.info('agent.join', {
        room: code,
        agent: out.agentId,
        name: who.name || b.name || null,
        harness: who.harness || b.harness || null,
        model: who.model || b.model || null,
        role: who.role || b.role || null,
        circle: Object.values(room.agents).filter(a => a.status === 'active').length,
        seat: room.settings?.minAgents ?? null,
        expected: room.settings?.expectedAgents ?? null,
        phase: room.phase.name,
        from: clientOf(req),
      });
      const turn = currentTurn(room, out.agentId);
      sendJSON(res, 200, {
        ok: true,
        ...out,
        phase: room.status,
        briefing: bootstrapText(room, base),
        turn,
      });
      return;
    }

    const agentId = u.searchParams.get('agent') || '';
    const tok = u.searchParams.get('token') || '';
    if (m === 'POST' && sub === '/heartbeat') {
      const b = await readJSON(req);
      const a = authAgent(room, b.agentId, b.token);
      hall.persist(room);
      hub.notify(code);
      sendJSON(res, 200, { ok: true, lastSeenAt: a.lastSeenAt, status: room.status });
      return;
    }
    if (['/turn', '/state', '/result'].includes(sub)) authAgent(room, agentId, tok);

    if (m === 'GET' && sub === '/turn') {
      const waitSec = Math.min(MAX_WAIT_SEC, Math.max(0, parseInt(u.searchParams.get('wait') || '0', 10) || 0));
      const since = Math.max(0, parseInt(u.searchParams.get('since') || '0', 10) || 0);
      const pollStarted = Date.now();
      const turn = await hub.waitForTurn(code, agentId, waitSec, since);
      if (!turn) { sendJSON(res, 404, { ok: false, error: 'not_found', message: 'Sala no encontrada' }); return; }
      const waitedMs = Date.now() - pollStarted;
      const turnAgent = room.agents[agentId] || {};
      if (turn.action === 'wait' || turn.action === 'done') {
        reg.debug('agent.turn_wait', {
          room: code, agent: agentId, name: turnAgent.name || null,
          askedSec: waitSec, waitedMs, phase: room.phase.name, action: turn.action,
        });
      } else {
        reg.info('agent.turn', {
          room: code, agent: agentId, name: turnAgent.name || null,
          action: turn.action, phase: room.phase.name, askedSec: waitSec, waitedMs,
        });
      }
      if (room.__changed) hall.persist(room);
      sendJSON(res, 200, { ok: true, turn });
      return;
    }

    if (m === 'GET' && sub === '/state') {
      const since = parseInt(u.searchParams.get('since') || '0', 10) || 0;
      sendJSON(res, 200, { ok: true, state: agentState(room, agentId, since) });
      return;
    }

    if (m === 'GET' && sub === '/result') {
      if (room.status !== 'closed') {
        // Una sala reabierta por el humano no vuelve a parecer «sin resultado»: se sirve la última
        // entrega congelada, con lo que el humano pidió, para que quien reentre sepa por qué trabaja.
        const reabierta = room.result && (room.artifacts.humanRounds || 0) > 0
          ? { by: 'humano', requests: humanReviewReport(room)?.open || [] }
          : null;
        sendJSON(res, 200, {
          ok: true, closed: false, phase: room.phase.name,
          deadlineInSec: Math.max(0, Math.round((room.phase.deadline - Date.now()) / 1000)),
          ...(reabierta ? { reopened: reabierta, previous: room.result } : null),
        });
        return;
      }
      sendJSON(res, 200, { ok: true, closed: true, result: room.result, human: humanBrief(room) });
      return;
    }

    if (m === 'POST' && sub === '/move') {
      const b = await readJSON(req);
      const aid = b.agentId || agentId;
      const tk = b.token || tok;
      if (!aid || !tk) throw new DebateError('unauthorized', 'Faltan agentId/token');
      authAgent(room, aid, tk);
      const moveStarted = Date.now();
      const phaseBefore = room.phase.name;
      req.__logAgent = aid;
      const out = applyMove(room, aid, {
        kind: b.kind, payload: b.payload, idempotencyKey: b.idempotencyKey || req.headers['idempotency-key'],
      });
      hall.persist(room);
      hub.notify(code);
      const moveAgent = room.agents[aid] || {};
      reg.info('agent.move', {
        room: code,
        agent: aid,
        name: moveAgent.name || null,
        kind: b.kind || null,
        // La fase en la que se pidió el movimiento y en la que quedó la sala: sin las dos, un
        // «pass» que cerró el encuadre parecería un movimiento hecho en la fase siguiente.
        phase: phaseBefore,
        nowPhase: room.phase.name,
        ms: Date.now() - moveStarted,
        replayed: !!out.replayed,
        warnings: (out.warnings || []).length,
        ...(b.kind === 'work-patch' || b.kind === 'work-review' ? { item: b.payload?.id || b.payload?.itemId || null } : null),
      });
      const turn = currentTurn(room, aid);
      sendJSON(res, 200, { ok: true, warnings: out.warnings || [], replayed: !!out.replayed, turn });
      return;
    }

    if (m === 'POST' && sub === '/admin') {
      const b = await readJSON(req);
      if (b.adminToken !== room.adminToken) throw new DebateError('unauthorized', 'adminToken inválido');
      // El humano también mueve la sala: sus órdenes se registran como cualquier movimiento.
      reg.info('room.admin', { room: code, op: b.op || null, phase: room.phase.name, from: clientOf(req) });
      if (b.op === 'advance' && room.status === 'debate') {
        // Orden del humano: avanza ya, sin prórrogas por actividad de los agentes.
        room.phase.deadline = Date.now() - 1;
        sweep(room, { force: true });
      } else if (b.op === 'close' && room.status !== 'closed') {
        const live = Object.values(room.artifacts.proposals).filter(p => !p.conceded);
        if (live.length) finishRoom(room, live[0].id);
        else closeRoom(room, 'expired', 'Cerrada por el administrador.');
      } else if (b.op === 'delete') {
        // Borrar un trabajo es definitivo: se lleva la sala, su registro, su repo de trabajo y su
        // copia en la memoria durable. Por eso no basta un clic: se pide el código de la sala como
        // confirmación, y se respeta a quien está dentro (un agente con señal reciente).
        if (String(b.confirm || '').toLowerCase() !== code) {
          throw new DebateError('bad_payload', `Para borrar definitivamente escribe el código de la sala (${code}).`);
        }
        const inside = (room.order || []).filter(id => hasRecentSignal(room, id));
        if (inside.length && !b.force) {
          const names = inside.map(id => nameOf(room, id)).join(', ');
          throw new DebateError('busy', `Hay agentes con señal reciente en la sala (${names}). Ciérrala y espera a que se retiren, o repite con force si sabes que ya no trabajan.`);
        }
        // Se borra la carpeta ENTERA de la sala (`workspaces/<code>`), no solo el repo: es lo que
        // se acumula en disco y lo que dejaría una carpeta huérfana por cada trabajo borrado.
        const wsDir = path.dirname(workspaceDirFor(dataDir, code));
        let workspaceGone = false;
        try {
          workspaceGone = fs.existsSync(wsDir);
          fs.rmSync(wsDir, { recursive: true, force: true });
        } catch (err) {
          // El trabajo borrado no se queda a medias: si el repo no se puede quitar, la sala
          // tampoco se borra, y se dice por qué.
          throw new DebateError('bad_op', `No se pudo borrar el repo de trabajo de la sala (${err?.code || 'rm_failed'}). Cierra los procesos que lo estén usando e inténtalo de nuevo.`);
        }
        hall.remove(code);
        // Y que la memoria no la resucite: fuera su copia publicada y sus ramas de trabajo.
        const forgot = await mem.forget(code);
        reg.info('room.delete', {
          room: code, title: room.title || null, status: room.status,
          agents: Object.keys(room.agents || {}).length, forced: !!b.force,
          workspace: workspaceGone, memory: !!mem.enabled, memoryOk: forgot?.ok !== false, from: clientOf(req),
        });
        hub.drop(code);
        sendJSON(res, 200, { ok: true, deleted: { code, workspace: workspaceGone, memory: !!mem.enabled, memoryOk: forgot?.ok !== false } });
        return;
      } else if (b.op === 'add-agenda') {
        const res = addPoint(room, { label: b.label, options: b.options }, null);
        if (!res.point) throw new DebateError('bad_payload', 'label requerido (≤70)');
      } else if (b.op === 'open-vacancy') {
        if (!b.agentId || !room.agents[b.agentId]) throw new DebateError('bad_payload', 'agentId desconocido');
        markAbsent(room, b.agentId, b.reason || 'retirado por el administrador');
      } else if (b.op === 'push') {
        // Publicar la rama es una decisión del humano y se pide explícitamente (nunca
        // automática): solo sale de aquí si la sala declaró `repo.pushTo`.
        const out = pushBranch(room, { remote: b.remote || null });
        if (!out.ok && out.error) throw new DebateError('bad_repo', out.error);
        hall.persist(room);
        hub.notify(code);
        sendJSON(res, 200, { ok: true, ...out });
        return;
      } else if (b.op === 'revert') {
        // Deshacer una mejora ya integrada: decisión del humano, con su motivo, y solo
        // cuando nadie está a mitad de un parche (no se revierte encima de trabajo a medias).
        const out = revertItem(room, { itemId: b.itemId || b.item || null, reason: b.reason || '', by: b.by || 'humano' });
        if (!out.ok) {
          sendJSON(res, 409, { ok: false, error: 'bad_revert', message: out.error, conflicts: out.conflicts || [] });
          return;
        }
        hall.persist(room);
        hub.notify(code);
        sendJSON(res, 200, { ok: true, ...out, room: publicRoom(room) });
        return;
      } else if (b.op === 'human-review') {
        // El juicio humano, SOLO sobre lo entregado: aprueba la entrega o pide cambios concretos.
        // No es un comentario al pie — un cambio pedido se convierte en tareas y la sala vuelve a
        // trabajar sobre ellas (con las capturas de antes y las de después al lado).
        const out = recordHumanReview(room, b);
        let reopened = { reopened: false, because: 'aprobado: no hay nada que rehacer' };
        if (out.canReopen) reopened = await reopenForChanges(room, out.review);
        refreshFrozenResult(room);
        hall.persist(room);
        hub.notify(code);
        reg.info('room.human-review', {
          room: code, verdict: out.review.verdict, requests: out.review.requests.length,
          reopened: !!reopened.reopened, phase: room.phase.name, from: clientOf(req),
        });
        sendJSON(res, 200, {
          ok: true,
          verdict: out.review.verdict,
          requests: out.review.requests.map(r => ({ id: r.id, text: r.text, items: r.itemIds }) ),
          warnings: out.warnings,
          ...reopened,
          room: publicRoom(room),
        });
        return;
      } else if (b.op === 'reapply') {
        // La vuelta atrás de la vuelta atrás: un botón junto a los datos tiene que poder
        // deshacerse, o un clic equivocado obliga a tocar git a mano.
        const out = reapplyItem(room, { itemId: b.itemId || b.item || null, reason: b.reason || '', by: b.by || 'humano' });
        if (!out.ok) {
          sendJSON(res, 409, { ok: false, error: 'bad_reapply', message: out.error, conflicts: out.conflicts || [] });
          return;
        }
        hall.persist(room);
        hub.notify(code);
        sendJSON(res, 200, { ok: true, ...out, room: publicRoom(room) });
        return;
      } else if (b.op === 'set-repo') {
        // Adjuntar (o recalcar) el repo antes de que arranque el debate.
        if (!['lobby', 'frame'].includes(room.status === 'closed' ? 'closed' : room.phase.name)) {
          throw new DebateError('wrong_phase', 'El repo solo se puede adjuntar en el lobby o durante el encuadre.');
        }
        const warning = await attachRepoOrWarn(room, b.repo);
        if (warning) sendJSON(res, 400, { ok: false, error: 'bad_repo', message: warning });
      } else if (b.op === 'set-verify') {
        // Lo que dejó integrar parches sin comprobar: declarar (o corregir) el comando
        // de verificación en cualquier momento, sin recrear la sala.
        const out = setVerifyCommand(room, {
          command: b.command === undefined ? (room.repo?.verify?.command || '') : b.command,
          timeoutMs: b.timeoutMs ?? null,
          rerunBaseline: b.rerunBaseline !== false,
        });
        if (!out.ok) throw new DebateError('bad_repo', out.error);
        hall.persist(room);
        hub.notify(code);
        if (out.rerun) runBaselineNow(room);
        sendJSON(res, 200, { ok: true, ...out, room: publicRoom(room) });
        return;
      } else if (b.op === 'run-baseline') {
        if (!room.repo) throw new DebateError('bad_payload', 'La sala no tiene repo.');
        if (!room.repo.verify) throw new DebateError('bad_payload', 'La sala no tiene comando de verificación declarado.');
        runBaselineNow(room);
      } else {
        throw new DebateError('bad_op', 'op: advance|close|delete|add-agenda|open-vacancy|set-repo|set-verify|run-baseline|push|revert|reapply');
      }
      hall.persist(room);
      hub.notify(code);
      sendJSON(res, 200, { ok: true, room: publicRoom(room) });
      return;
    }

    if (m === 'GET' && sub === '/stream') {
      const openedAt = Date.now();
      reg.debug('panel.stream_open', { room: code, from: clientOf(req), subscribers: hub.stats().subscribers + 1 });
      req.on('close', () => reg.debug('panel.stream_close', { room: code, from: clientOf(req), openSec: Math.round((Date.now() - openedAt) / 1000) }));
      hub.subscribe(code, res, req);
      return;
    }

    sendJSON(res, 404, { ok: false, error: 'not_found', message: 'Subruta desconocida' });
  }

  // La base real de captura: cuando el socket abra, este proceso sabe en qué puerto quedó de
  // verdad. Se registra aquí y no en el arranque de `index.mjs` porque cualquier camino que
  // escuche (pruebas incluidas) debe capturar su propio artefacto, no el de otro servidor.
  server.on('listening', () => {
    const addr = server.address();
    if (addr && typeof addr === 'object' && addr.port) setServerBase(`http://127.0.0.1:${addr.port}`);
  });

  return {
    server, hall, hub, tournaments, dist, memory: mem,
    // Parar incluye vaciar la memoria: es el último momento en que el trabajo puede salir del
    // disco antes de que el host lo borre (un despliegue envía SIGTERM y espera un poco).
    stop: () => {
      stopClock();
      return mem.stop();
    },
  };
}

// ---------------------------------------------------------------- utilidades
function send(res, status, body, type = 'application/json; charset=utf-8', extraHeaders = null) {
  if (res.headersSent) return;
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Idempotency-Key',
    // La previsualización añade aquí su CSP y su política de recursos; el resto de rutas no.
    ...(extraHeaders || {}),
  });
  res.end(body);
}
function sendJSON(res, status, obj) { send(res, status, JSON.stringify(obj)); }

// El origen con el que el cliente está hablando (http://127.0.0.1:8919). Sirve para que la
// política de la vista previa incluya explícitamente el origen del servidor: el iframe va con
// origen opaco y `'self'` no le casa. Un `Host` raro no se usa: mejor sin origen que con basura.
// ------------------------------------------------------------- lectura de la petición
// Qué se apunta de cada petición sin filtrar secretos: la ruta sin query, la sala, el agente
// y unos pocos parámetros con significado (espera, desde, búsqueda). El token y el adminToken
// jamás se copian, ni siquiera recortados.
const SAFE_QUERY = new Set(['wait', 'since', 'lines', 'from', 'regex', 'q', 'harness', 'role']);

function safeUrl(raw) {
  try { return new URL(String(raw || '/'), 'http://local'); }
  catch { return new URL('/', 'http://local'); }
}

function describeRequest(method, u) {
  const pathname = u.pathname.replace(/\/+$/, '') || '/';
  const room = /^\/api\/rooms\/([a-z0-9]{4,12})/i.exec(pathname)?.[1]?.toLowerCase()
    || /^\/r\/([a-z0-9]{4,12})/i.exec(pathname)?.[1]?.toLowerCase()
    || null;
  const sub = /^\/api\/rooms\/[a-z0-9]{4,12}(\/[a-z.]+)/i.exec(pathname)?.[1]?.toLowerCase() || '';
  const agent = u.searchParams.get('agent') || null;
  const query = {};
  for (const [k, v] of u.searchParams) {
    if (!SAFE_QUERY.has(k)) continue;
    query[k] = v.length > 60 ? `${v.slice(0, 60)}…` : v;
  }
  // Cara al agente: lo que un harness hace y el humano necesita leer en el registro.
  const agentFacing = pathname.startsWith('/r/')
    || ['/join', '/turn', '/move', '/heartbeat', '/state', '/result', '/bootstrap', '/repo', '/work.diff'].includes(sub);
  return {
    path: pathname,
    room,
    agent,
    query: Object.keys(query).length ? query : null,
    agentFacing,
    method,
  };
}

// De dónde viene la petición: un harness local, un navegador o un tercero. Sin esto, «no
// avanzó» no distingue entre «el agente no llegó» y «llegó desde otro sitio».
function clientOf(req) {
  const ip = (String(req.headers['x-forwarded-for'] || '').split(',')[0].trim())
    || req.socket?.remoteAddress || '';
  return ip.replace(/^::ffff:/, '') || 'desconocido';
}

function originOf(req) {
  const host = String(req.headers.host || '');
  if (!/^[A-Za-z0-9.:\[\]-]+$/.test(host)) return null;
  return `${protoOf(req)}://${host}`;
}

// El esquema con el que llegó el cliente, no el que usa este proceso por dentro: detrás de un
// proxy (Render y cualquier servicio gestionado) la conexión local es http y lo público es https.
// Dar `http://…` a un agente le entrega una URL que redirige en vez de una que funciona, y a la
// vista previa le deja una política que bloquea su propio iframe.
function protoOf(req) {
  const forwarded = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  if (forwarded === 'https' || forwarded === 'http') return forwarded;
  return req.socket?.encrypted ? 'https' : 'http';
}

function httpError(res, err) {
  const status = err instanceof DebateError
    ? (HTTP_STATUS[err.code] || 400)
    : 500;
  const body = err instanceof DebateError
    ? { ok: false, error: err.code, message: err.message }
    : { ok: false, error: 'internal', message: err?.message || 'error interno' };
  sendJSON(res, status, body);
}

// 512 KB era el techo heredado de cuando un movimiento era un párrafo. Un harness que
// manda un parche de refactor de verdad (decenas de archivos, archivos generados) chocaba
// con «body demasiado grande» y perdía el trabajo compuesto. Ahora el techo es de
// protección de memoria, no de contenido: si se alcanza, el mensaje dice qué hacer.
const MAX_BODY_BYTES = 32 * 1024 * 1024;

function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) {
        reject(new DebateError('too_large',
          `body de más de ${Math.round(limit / (1024 * 1024))} MB: es el techo de memoria del servidor, no un límite de contenido. ` +
          'Manda el mismo trabajo en varios movimientos (por ejemplo el parche en files[] por tandas).'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(decodeBody(Buffer.concat(chunks), req.headers['content-type'])));
    req.on('error', reject);
  });
}

// Un CLI que manda los acentos en latin-1 (cp1252) rompía el texto para siempre: guardábamos
// «�Cu�l es el eje?» con cada acento convertido en U+FFFD, y eso ya no se puede recuperar.
// Aquí se respeta el charset declarado y, si los bytes no son UTF-8 válido, se decodifican
// como latin-1 (que recupera el texto tal cual se escribió) en vez de destruirlo.
//
// Los 27 bytes en los que cp1252 se separa de latin-1 (0x80..0x9F): en Windows ponen aquí
// el euro, las comillas tipográficas, la raya y el resto de la puntuación. Sin esta tabla,
// un CLI de Windows que mandaba «—» dejaba el JSON inválido y perdía el movimiento entero;
// y no hay sustituto en Node: TextDecoder('windows-1252') de este runtime devuelve latin-1.
const CP1252 = {
  0x80: '\u20ac', 0x82: '\u201a', 0x83: '\u0192', 0x84: '\u201e', 0x85: '\u2026', 0x86: '\u2020',
  0x87: '\u2021', 0x88: '\u02c6', 0x89: '\u2030', 0x8a: '\u0160', 0x8b: '\u2039', 0x8c: '\u0152',
  0x8e: '\u017d', 0x91: '\u2018', 0x92: '\u2019', 0x93: '\u201c', 0x94: '\u201d', 0x95: '\u2022',
  0x96: '\u2013', 0x97: '\u2014', 0x98: '\u02dc', 0x99: '\u2122', 0x9a: '\u0161', 0x9b: '\u203a',
  0x9c: '\u0153', 0x9e: '\u017e', 0x9f: '\u0178',
};

// Lee los bytes como latin-1/cp1252: un byte por carácter, salvo la franja 0x80..0x9F, que
// en cp1252 es puntuación (y en ISO-8859-1 serían controles, que no caben en un JSON válido).
function decodeLatin(buf) {
  let out = '';
  for (const byte of buf) out += CP1252[byte] || String.fromCharCode(byte);
  return out;
}

export function decodeBody(buf, contentType = '') {
  const declared = /charset=["']?([\w-]+)/i.exec(String(contentType || ''))?.[1]?.toLowerCase();
  if (declared) {
    if (declared === 'utf-8' || declared === 'utf8') return buf.toString('utf8');
    if (['latin-1', 'latin1', 'iso-8859-1', 'iso8859-1', 'cp1252', 'windows-1252'].includes(declared)) return decodeLatin(buf);
    if (Buffer.isEncoding(declared)) return buf.toString(declared);
  }
  const utf8 = buf.toString('utf8');
  // Si al recomponer los bytes el resultado no coincide, no era UTF-8: latin-1/cp1252 es la
  // única otra lectura razonable de un JSON de texto.
  if (Buffer.compare(Buffer.from(utf8, 'utf8'), buf) !== 0) return decodeLatin(buf);
  return utf8;
}

async function readJSON(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  try { return JSON.parse(raw); }
  catch { throw new DebateError('bad_json', 'El body debe ser JSON válido'); }
}

function serveApp(res, dist, relPath) {
  const indexFile = path.join(dist, 'index.html');
  const clean = path.normalize(relPath).replace(/^(\.\.[/\\])+/, '');
  const target = clean === '/' || clean === '\\' ? indexFile : path.join(dist, clean);
  if (fs.existsSync(target) && fs.statSync(target).isFile()) {
    const ext = path.extname(target).toLowerCase();
    send(res, 200, fs.readFileSync(target), MIME[ext] || 'application/octet-stream');
    return;
  }
  if (fs.existsSync(indexFile)) { send(res, 200, fs.readFileSync(indexFile), MIME['.html']); return; }
  send(res, 200, uiNotBuiltPage(), MIME['.html']);
}

function uiNotBuiltPage() {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<title>Polymind — interfaz sin construir</title>
<style>body{font:15px/1.6 system-ui,sans-serif;background:#0b1020;color:#e8ecf4;margin:0;display:grid;place-items:center;min-height:100vh}
.card{max-width:640px;padding:32px;background:#141a2e;border:1px solid #26314f;border-radius:16px}
code{background:#0b1020;border:1px solid #26314f;border-radius:6px;padding:2px 6px;font-family:ui-monospace,monospace}
h1{margin:0 0 8px;font-size:22px}a{color:#7fb2ff}</style></head><body><div class="card">
<h1>La interfaz no está construida</h1>
<p>El servidor está funcionando, pero falta compilar la aplicación React.</p>
<p><code>npm install &amp;&amp; npm run build</code></p>
<p>Mientras tanto, la API de agentes y el manual siguen disponibles: <a href="/manual">/manual</a> · <a href="/api/hall">/api/hall</a></p>
<p>En desarrollo puedes usar <code>npm run dev</code> (Vite en :5190 con proxy a la API).</p>
</div></body></html>`;
}

export function lanAddress() {
  for (const [, ifs] of Object.entries(os.networkInterfaces())) {
    for (const i of ifs || []) if (i.family === 'IPv4' && !i.internal) return i.address;
  }
  return null;
}
