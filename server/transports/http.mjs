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
  healFrozenResults, setResultRefresher, setVerifyCommand,
  roomConfig, roomInputFromConfig, templateFromConfig, deliveryOf,
  previewEntry, previewFile, previewHeaders,
} from '../engine/index.mjs';
import { LiveHub, startClock } from './live.mjs';
import { manualText, bootstrapText, snippetsFor, joinPrompt } from '../snippets.mjs';
import { listTemplates, getTemplate, roomInputFromTemplate, saveTemplate } from '../templates.mjs';
import { TournamentManager } from '../tournament.mjs';

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

export function createAgora({ dataDir, appDistDir, clockMs = 1000 } = {}) {
  const hall = new Hall(dataDir, { sweep });
  const hub = new LiveHub(hall);
  const tournaments = new TournamentManager({ hall, dir: dataDir });
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dist = appDistDir || path.join(here, '..', '..', 'app', 'dist');

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
      runBaselineNow(room);
      return null;
    } catch (err) {
      return err?.message || 'No se pudo adjuntar el repositorio.';
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
    route(req, res).catch(err => {
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
  });

  async function route(req, res) {
    const u = new URL(req.url, 'http://local');
    const p = u.pathname.replace(/\/+$/, '') || '/';
    const m = req.method;
    const base = `http://${req.headers.host || 'localhost'}`;

    if (m === 'OPTIONS') { send(res, 204, ''); return; }

    // ---------------------------------------------------------- documentos
    if (m === 'GET' && p === '/manual') { send(res, 200, manualText(), 'text/markdown; charset=utf-8'); return; }
    if (m === 'GET' && p === '/api/health') {
      sendJSON(res, 200, { ok: true, rooms: hall.list().length, ...hub.stats(), uptimeSec: Math.round(process.uptime()) });
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
      const waitSec = Math.min(120, Math.max(0, parseInt(u.searchParams.get('wait') || '0', 10) || 0));
      const since = Math.max(0, parseInt(u.searchParams.get('since') || '0', 10) || 0);
      const turn = await hub.waitForTurn(code, agentId, waitSec, since);
      if (!turn) { sendJSON(res, 404, { ok: false, error: 'not_found', message: 'Sala no encontrada' }); return; }
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
        sendJSON(res, 200, {
          ok: true, closed: false, phase: room.phase.name,
          deadlineInSec: Math.max(0, Math.round((room.phase.deadline - Date.now()) / 1000)),
        });
        return;
      }
      sendJSON(res, 200, { ok: true, closed: true, result: room.result });
      return;
    }

    if (m === 'POST' && sub === '/move') {
      const b = await readJSON(req);
      const aid = b.agentId || agentId;
      const tk = b.token || tok;
      if (!aid || !tk) throw new DebateError('unauthorized', 'Faltan agentId/token');
      authAgent(room, aid, tk);
      const out = applyMove(room, aid, {
        kind: b.kind, payload: b.payload, idempotencyKey: b.idempotencyKey || req.headers['idempotency-key'],
      });
      hall.persist(room);
      hub.notify(code);
      const turn = currentTurn(room, aid);
      sendJSON(res, 200, { ok: true, warnings: out.warnings || [], replayed: !!out.replayed, turn });
      return;
    }

    if (m === 'POST' && sub === '/admin') {
      const b = await readJSON(req);
      if (b.adminToken !== room.adminToken) throw new DebateError('unauthorized', 'adminToken inválido');
      if (b.op === 'advance' && room.status === 'debate') {
        // Orden del humano: avanza ya, sin prórrogas por actividad de los agentes.
        room.phase.deadline = Date.now() - 1;
        sweep(room, { force: true });
      } else if (b.op === 'close' && room.status !== 'closed') {
        const live = Object.values(room.artifacts.proposals).filter(p => !p.conceded);
        if (live.length) finishRoom(room, live[0].id);
        else closeRoom(room, 'expired', 'Cerrada por el administrador.');
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
        throw new DebateError('bad_op', 'op: advance|close|add-agenda|open-vacancy|set-repo|set-verify|run-baseline|push|revert|reapply');
      }
      hall.persist(room);
      hub.notify(code);
      sendJSON(res, 200, { ok: true, room: publicRoom(room) });
      return;
    }

    if (m === 'GET' && sub === '/stream') { hub.subscribe(code, res, req); return; }

    sendJSON(res, 404, { ok: false, error: 'not_found', message: 'Subruta desconocida' });
  }

  return { server, hall, hub, tournaments, dist, stop: () => stopClock() };
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
function originOf(req) {
  const host = String(req.headers.host || '');
  if (!/^[A-Za-z0-9.:\[\]-]+$/.test(host)) return null;
  return `http://${host}`;
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
<title>AGORA — interfaz sin construir</title>
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
