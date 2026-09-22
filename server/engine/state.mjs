// AGORA v2 — estado de la sala: creación, registro (log), membresía básica y
// persistencia en disco. Aquí no hay transiciones de fase (viven en phases.mjs).

import fs from 'node:fs';
import path from 'node:path';
import { now, uid, token, clampStr, clampText, gist, bytesOf, plural } from './util.mjs';
import { CAPS, pickSettings, roleLabel } from './settings.mjs';
import { normalizeAgenda } from './agenda.mjs';

export const SCHEMA_VERSION = 2;

const CODE_ABC = 'abcdefghjkmnpqrstuvwxyz23456789';
function makeCode() {
  return Array.from({ length: 6 }, () => CODE_ABC[Math.floor(Math.random() * CODE_ABC.length)]).join('');
}

export function createRoom(input = {}) {
  const task = clampText(input.task || '', CAPS.task);
  if (task.trim().length < 10) {
    throw Object.assign(new Error('task: describe la tarea con al menos 10 caracteres'), { code: 'bad_task' });
  }
  const settings = pickSettings(input.settings);
  const room = {
    schemaVersion: SCHEMA_VERSION,
    code: makeCode(),
    title: clampStr(input.title || gist(task, 80), 120),
    template: input.template ? clampStr(input.template, 40) : null,
    task,
    context: clampText(input.context || '', CAPS.context),
    criteria: clampText(input.criteria || '', CAPS.criteria),
    createdAt: now(),
    createdBy: clampStr(input.createdBy || 'humano', 60),
    adminToken: token(),
    settings,
    status: 'lobby',
    agents: {},
    order: [],                 // orden de llegada (incluye ausentes)
    vacancies: [],             // asientos abiertos por incomparecencia
    agenda: normalizeAgenda(input.agenda),
    phase: { name: 'lobby', startedAt: now(), deadline: now() + settings.phaseMs.lobby, data: {} },
    artifacts: {
      proposals: {},
      critiques: {},
      objections: [],
      checks: [],
      ruleProposals: [],
      ledger: [],              // coste por movimiento, para métricas reales
      // Libro mayor de la evidencia: cada medición que hace el SERVIDOR (comando, código de
      // salida, commit, huella) y cada juicio que hace otro agente. Es lo que permite que el
      // resultado se genere desde lo ejecutado en vez de desde la prosa del plan.
      evidence: [],
      findings: [],            // hallazgos de la auditoría del repo (trabajo conjunto)
      // Disenso protegido: cada vez que un autor mueve una posición de la agenda se
      // registra aquí (con o sin la evidencia que lo justifica). Es lo que permite
      // distinguir «se acercaron porque había un argumento» de «se acercaron».
      drift: [],
    },
    repo: null,                // repositorio clonado (solo si la sala trae uno)
    work: null,                // plan de trabajo del repo, tras el debate
    // Ronda de mejora en curso (1 = el debate inicial). Con «mejora recursiva» la sala vuelve a
    // auditar el código ya parcheado y repite el ciclo: cada ronda deja aquí su balance, que es
    // lo que permite decir POR QUÉ se paró («la ronda N no encontró nada nuevo»).
    rounds: 1,
    roundHistory: [],
    lastWinnerId: null,        // ganador de la ronda en curso, para cerrar sin fase que lo lleve
    // Foto del consenso al cerrar cada macro-etapa: permite mostrar la evolución
    // (por etapa) junto al número global, sin recalcular nada hacia atrás.
    consensusHistory: [],
    served: {},                // agentId -> caracteres que el servidor le sirvió
    lastMedians: null,
    lastBallots: null,
    log: [],
    logSeq: 0,
    result: null,
    tournament: input.tournament || null,
    __changed: false,
  };
  log(room, null, 'room', `Sala creada. Tarea: ${gist(task, 160)}`);
  if (room.agenda.length) {
    log(room, null, 'room', `Agenda de decisión con ${plural(room.agenda.length, 'punto')}: ${room.agenda.map(p => p.label).join(', ')}.`);
  }
  return room;
}

export function log(room, agentId, kind, text, extra = null) {
  const entry = { id: ++room.logSeq, ts: now(), agentId, kind, text };
  if (extra) entry.data = extra;
  room.log.push(entry);
  return entry;
}

export function recordCost(room, agentId, kind, chars) {
  room.artifacts.ledger.push({ at: now(), agentId, kind, chars, phase: room.phase?.name || 'lobby' });
  if (room.artifacts.ledger.length > 800) room.artifacts.ledger.splice(0, room.artifacts.ledger.length - 800);
}

export function recordServed(room, agentId, value) {
  const chars = bytesOf(value);
  room.served[agentId] = (room.served[agentId] || 0) + chars;
  return chars;
}

export function nameOf(room, id) { return room.agents[id]?.name || id || 'sistema'; }

export function activeAgents(room) {
  const phaseId = room.phase?.instanceId || room.phase?.startedAt;
  return room.order.filter(id => {
    const agent = room.agents[id];
    return agent && agent.status !== 'absent' && (!agent.joinAfterPhase || agent.joinAfterPhase !== phaseId);
  });
}

export function agentOf(room, id) { return room.agents[id] || null; }

export function roleOf(room, id) {
  const role = room.agents[id]?.role;
  return role ? roleLabel(role) : '';
}

// La propuesta del agente EN LA RONDA ABIERTA. Con mejora recursiva la sala repite el ciclo, así
// que la de una ronda anterior ya está decidida y no cuenta: sin esto, en la ronda 2 los agentes
// aparecían «con propuesta presentada» y la votación reutilizaba los planes de la ronda 1.
export function proposalOf(room, agentId) {
  const ronda = room.rounds || 1;
  const mias = Object.values(room.artifacts.proposals).filter(p => p.author === agentId);
  return mias.find(p => (p.round || 1) === ronda) || null;
}

export function critiqueOf(room, authorId, targetId) {
  return Object.values(room.artifacts.critiques).find(c => c.author === authorId && c.target === targetId) || null;
}

export function nextSeat(room) {
  return 'a' + (room.order.length + 1);
}

export function ensureSeqs(room) {
  room.logSeq = room.logSeq || room.log.length;
}

export function newId(prefix) { return uid(prefix); }

// ---------------------------------------------------------------- migración v1→v2
export function migrate(room) {
  if (!room || typeof room !== 'object') return null;
  const version = room.schemaVersion || 1;
  if (version >= SCHEMA_VERSION) return room;
  room.settings = pickSettings(room.settings);
  room.agenda = normalizeAgenda(room.agenda);
  room.vacancies = room.vacancies || [];
  room.served = room.served || {};
  room.title = room.title || gist(room.task || '', 80);
  room.createdBy = room.createdBy || 'humano';
  room.artifacts = room.artifacts || {};
  for (const key of ['proposals', 'critiques']) room.artifacts[key] = room.artifacts[key] || {};
  for (const key of ['objections', 'checks', 'ruleProposals', 'ledger', 'findings', 'drift', 'evidence']) room.artifacts[key] = room.artifacts[key] || [];
  room.repo = room.repo || null;
  room.work = room.work || null;
  for (const pr of Object.values(room.artifacts.proposals)) {
    pr.positions = pr.positions || {};
    pr.premortem = pr.premortem || '';
    pr.approach = pr.approach || '';
    pr.conceded = !!pr.conceded;
  }
  for (const id of room.order || []) {
    const a = room.agents?.[id];
    if (!a) continue;
    a.role = a.role || '';
    a.capabilities = a.capabilities || [];
    a.status = a.status || 'active';
    a.overBudget = !!a.overBudget;
  }
  room.schemaVersion = SCHEMA_VERSION;
  log(room, null, 'room', 'Sala migrada de v1 a v2 (agenda, roles y posiciones inicializadas).');
  return room;
}

// ---------------------------------------------------------------- progreso
// Cuánto ha avanzado una sala. Es la vara con la que se decide quién manda cuando dos procesos
// tienen la MISMA sala cargada en memoria: manda la copia que más avanzó, nunca la más pobre.
//
// Por qué existe: un servidor viejo sobre el mismo directorio de datos guardó su copia de una
// sala —todavía en el lobby, sin agentes— ENCIMA de un debate que ya había terminado. El archivo
// pasó de 182 KB a 2,8 KB y la sala reapareció como «plazo de lobby agotado, 0 agentes»: el
// trabajo estaba hecho y en el panel ya no existía. Un resultado decidido y verificado es
// irreversible, así que una copia posterior con menos avance no puede sobrescribirlo jamás.
export function progressOf(room) {
  if (!room) return -1;
  const outcome = room.result?.outcome || null;
  // Cerrar con decisión es lo máximo que hace una sala; cerrar sin decidir, menos que cerrar bien.
  const cierre = outcome === 'decided' ? 4
    : outcome === 'failed' ? 3
      : outcome === 'expired' ? 2
        : room.status === 'closed' ? 1
          : 0;
  // `logSeq` es un contador monótono (el registro puede recortarse, el contador no).
  const seq = Number(room.logSeq) || (Array.isArray(room.log) ? room.log.length : 0);
  const gente = Object.keys(room.agents || {}).length;
  const trabajo = room.work ? (room.work.order || []).length : 0;
  return cierre * 1e12 + Math.min(seq, 999_999) * 1e3 + Math.min(gente + trabajo, 999);
}

// ---------------------------------------------------------------- persistencia
// Campos que solo existen mientras el proceso vive (ver persist()).
const TRANSIENT_KEYS = new Set(['__changed', '__pendingVerify', '__pendingRevertVerify', '__baselinePromise', '__storageFailure']);

function readRoomFile(file) {
  try {
    const room = migrate(JSON.parse(fs.readFileSync(file, 'utf8')));
    return room || null;
  } catch { return null; }
}

export class Hall {
  constructor(dir, { sweep = null } = {}) {
    this.dir = dir;
    this.sweep = sweep;
    this.cache = new Map();
    // Gancho de la memoria durable: se avisa después de CADA guardado real para que el trabajo
    // pueda salir del disco efímero. Vacío = comportamiento de siempre.
    this.onPersist = null;
    // Última versión conocida de cada sala: su huella en disco (mtime:bytes) y cuánto había
    // avanzado. La huella detecta que OTRO proceso escribió; el progreso evita que una copia
    // pobre —en disco o en manos de quien la leyó antes— pise una que ya avanzó más.
    this.marks = new Map();
    fs.mkdirSync(dir, { recursive: true });
  }
  fileOf(code) { return path.join(this.dir, String(code).toLowerCase() + '.json'); }

  stampOf(file) {
    try {
      const s = fs.statSync(file);
      return `${s.mtimeMs}:${s.size}`;
    } catch { return null; }
  }

  mark(code, stamp, progress) {
    this.marks.set(code, { stamp, progress });
  }

  // ¿Esta sala se quedó atrás? Es el caso del objeto que alguien leyó antes de que la sala
  // avanzara (o antes de que otra instancia la escribiera): guardarlo borraría lo posterior.
  isBehind(code, room) {
    const known = this.marks.get(code);
    return !!known && progressOf(room) < known.progress;
  }

  // Si otro proceso escribió esta sala: la de disco manda SOLO si avanzó más. Si va por detrás
  // (un servidor zombi con la sala del lobby), se queda la nuestra y se reescribe el disco — es
  // el trabajo que ya existe y que el archivo había perdido. Devuelve la copia vigente.
  reconcile(code, room) {
    const file = this.fileOf(code);
    const stamp = this.stampOf(file);
    const known = this.marks.get(code);
    if (!stamp || (known && stamp === known.stamp)) return room;
    const disk = readRoomFile(file);
    if (!disk) { this.mark(code, stamp, progressOf(room)); return room; }
    if (progressOf(disk) > progressOf(room)) {
      this.mark(code, stamp, progressOf(disk));
      this.cache.set(code, disk);
      console.warn(`[Polymind] Sala ${code}: otra instancia la dejó más avanzada en disco (${progressOf(disk)} > ${progressOf(room)}); se adopta la de disco.`);
      return disk;
    }
    // Nuestra copia manda: el disco tiene una versión anterior. Se vuelve a escribir para que el
    // trabajo no desaparezca cuando este proceso se reinicie.
    console.warn(`[Polymind] Sala ${code}: el disco tenía una copia atrasada (otra instancia la escribió); se restaura la versión avanzada.`);
    room.__changed = true;
    this.persist(room);
    return room;
  }

  create(input) {
    const room = createRoom(input);
    if (!this.persist(room)) {
      throw Object.assign(new Error('No se pudo guardar el trabajo. Comprueba el espacio libre y los permisos del directorio de datos antes de volver a intentarlo.'), { code: 'storage_unavailable' });
    }
    this.cache.set(room.code, room);
    return room;
  }
  get(code) {
    code = String(code || '').toLowerCase();
    let room = this.cache.get(code);
    if (!room) {
      const f = this.fileOf(code);
      if (!fs.existsSync(f)) return null;
      room = readRoomFile(f);
      if (!room) return null;
      this.mark(code, this.stampOf(f), progressOf(room));
      this.cache.set(code, room);
    } else {
      // Cada lectura comprueba que el disco no haya cambiado por debajo: es lo que hace que el
      // reloj (que recorre todas las salas cada segundo) repare solo una sala pisada por otro
      // proceso, sin que nadie tenga que reiniciar nada a mano.
      room = this.reconcile(code, room);
    }
    if (this.sweep && this.sweep(room)) room.__changed = true;
    return room;
  }
  persist(room) {
    const f = this.fileOf(room.code);
    const tmp = f + '.tmp';
    // Antes de escribir: ¿otro proceso dejó en disco una versión MÁS avanzada? Entonces la
    // nuestra es obsoleta y escribirla destruiría trabajo terminado. Se conserva la de disco.
    const stamp = this.stampOf(f);
    const known = this.marks.get(room.code);
    if (stamp && (!known || stamp !== known.stamp)) {
      const disk = readRoomFile(f);
      if (disk && progressOf(disk) > progressOf(room)) {
        this.mark(room.code, stamp, progressOf(disk));
        this.cache.set(room.code, disk);
        console.warn(`[Polymind] No se guarda la sala ${room.code}: hay una versión más avanzada en disco (¿dos servidores sobre el mismo directorio de datos?). Se conserva la de disco.`);
        return true;
      }
    }
    // Mismo disco, pero el objeto que me piden guardar se quedó atrás (lo leyó alguien antes de
    // que la sala avanzara, o antes de que otra instancia la escribiera): escribirlo retrocedería
    // trabajo ya hecho. Se descarta en silencio útil: el disco ya está mejor.
    if (this.isBehind(room.code, room)) {
      console.warn(`[Polymind] No se guarda la sala ${room.code}: la copia en memoria se quedó atrás (${progressOf(room)} < ${this.marks.get(room.code).progress}).`);
      return true;
    }
    try {
      // Las marcas del proceso (cambios sin guardar, promesas en vuelo) no son estado
      // de la sala: si se escribieran, al recargar parecería que la verificación sigue
      // corriendo cuando ya no existe nadie que la termine.
      fs.writeFileSync(tmp, JSON.stringify(room, (key, value) => (TRANSIENT_KEYS.has(key) ? undefined : value)));
      fs.renameSync(tmp, f);
      this.mark(room.code, this.stampOf(f), progressOf(room));
      room.__changed = false;
      delete room.__storageFailure;
      if (this.onPersist) {
        // La memoria no puede tumbar un guardado: si el aviso falla, el archivo ya está bien.
        try { this.onPersist(room); } catch { /* la sala sigue viva */ }
      }
      return true;
    } catch (error) {
      // Preserve the dirty state so the clock can retry. Never present volatile
      // progress as durably saved; publicRoom exposes a safe, actionable warning.
      room.__changed = true;
      if (!room.__storageFailure) console.error(`[Polymind] No se pudo persistir la sala ${room.code}: ${error.code || 'write_failed'}`);
      room.__storageFailure = { at: now(), code: error.code || 'write_failed' };
      return false;
    }
  }
  // Borrar una sala. Es una decisión del humano y tiene que ser TOTAL: si solo se quitara de la
  // lista, el archivo seguiría en el directorio y la sala reaparecería en la siguiente lectura
  // (y, con memoria durable, volvería desde su copia publicada). Se lleva el JSON, su temporal,
  // la caché del proceso y las marcas de progreso.
  remove(code) {
    code = String(code || '').toLowerCase();
    const file = this.fileOf(code);
    try {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}.tmp`, { force: true });
    } catch { return false; }
    this.cache.delete(code);
    this.marks.delete(code);
    return true;
  }

  list() {
    const out = [];
    let files = [];
    try { files = fs.readdirSync(this.dir); } catch { return out; }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const room = this.get(f.slice(0, -5));
      if (!room) continue;
      out.push({
        code: room.code,
        title: room.title || gist(room.task, 80),
        task: gist(room.task, 140),
        template: room.template || null,
        status: room.status,
        phase: room.status === 'closed' ? 'closed' : room.phase.name,
        macro: room.phase?.name || 'closed',
        agents: (room.order || []).length,
        activeAgents: activeAgents(room).length,
        agenda: (room.agenda || []).length,
        createdAt: room.createdAt,
        durationMin: room.result?.stats?.durationMin ?? Math.round((now() - room.createdAt) / 60000),
        outcome: room.result?.outcome || null,
        consensus: room.result?.consensus?.global ?? null,
        checksum: room.result?.checksum || null,
        tournament: room.tournament || null,
        repo: room.repo
          ? {
            source: room.repo.source,
            kind: room.repo.kind,
            branch: room.repo.branch,
            files: room.repo.files,
            verify: room.repo.verify?.command || null,
          }
          : null,
        work: room.work
          ? {
            items: room.work.order.length,
            integrated: room.work.order.filter(id => room.work.items[id]?.status === 'integrated').length,
            reverted: room.work.order.filter(id => room.work.items[id]?.status === 'reverted').length,
            open: room.work.order.filter(id => ['open', 'claimed', 'in-review', 'verifying'].includes(room.work.items[id]?.status)).length,
            head: room.work.head,
          }
          : null,
      });
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }
}
