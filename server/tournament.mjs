// AGORA v2 — torneo de ágoras.
//
// Varias salas debaten la misma tarea con ángulos distintos (coste, riesgo,
// ambición, velocidad) y después una sala final contrasta los planes ganadores.
// Sube la calidad porque el desacuerdo se busca a propósito, no se espera.

import fs from 'node:fs';
import path from 'node:path';
import { now, uid, clampStr, clampText, gist, token, plural } from './engine/util.mjs';
import { CAPS } from './engine/settings.mjs';

export const ANGLES = [
  {
    id: 'economico', label: 'Coste mínimo',
    prompt: 'Optimiza sobre todo el coste: recorta hasta el mínimo viable y di qué renuncias.',
    extraPoint: { label: 'Recorte principal', options: ['Menos alcance', 'Menos calidad', 'Menos velocidad', 'Menos soporte'] },
    settings: { consensusThreshold: 0.7 },
  },
  {
    id: 'riesgo', label: 'Riesgo mínimo',
    prompt: 'Optimiza sobre todo la robustez: asume que todo lo que pueda fallar fallará y blindalo.',
    extraPoint: { label: 'Riesgo dominante', options: ['Técnico', 'De mercado', 'Operativo', 'Legal'], weight: 1.5 },
    settings: { requireDiversity: true },
  },
  {
    id: 'ambicioso', label: 'Ambición máxima',
    prompt: 'Optimiza el techo: propón la apuesta con el mayor retorno posible y justifica por qué es alcanzable.',
    extraPoint: { label: 'Apuesta clave', options: ['Nuevo segmento', 'Nueva categoría', 'Nuevo canal', 'Nueva tecnología'] },
    settings: {},
  },
  {
    id: 'rapido', label: 'Máxima velocidad',
    prompt: 'Optimiza el tiempo: qué se puede tener funcionando en dos semanas y qué sacrificas.',
    extraPoint: { label: 'Sacrificado por velocidad', options: ['Alcance', 'Calidad', 'Soporte', 'Documentación'] },
    settings: { phaseMs: { proposal: 5 * 60_000, critique: 4 * 60_000 } },
  },
];

export class TournamentManager {
  constructor({ hall, dir }) {
    this.hall = hall;
    this.dir = dir;
    this.file = path.join(dir, '_tournaments.json');
    this.list_ = [];
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.file)) this.list_ = JSON.parse(fs.readFileSync(this.file, 'utf8')) || [];
    } catch { this.list_ = []; }
  }

  save() {
    try { fs.writeFileSync(this.file, JSON.stringify(this.list_, null, 0)); } catch { /* solo en memoria */ }
  }

  list() { return [...this.list_].sort((a, b) => b.createdAt - a.createdAt); }

  get(id) { return this.list_.find(t => t.id === id) || null; }

  // `repo` es opcional: si viene, cada sala de ángulo clona el mismo proyecto y
  // trabaja en su propia rama (por eso van en paralelo sin pisarse). El repositorio lo
  // adjunta quien llama (clonar es asíncrono y esto no lo es); aquí solo se decide a
  // qué salas hay que adjuntarlo. `needsRepo` lo consume el transporte.
  create({ task, title, context, criteria, agenda = [], settings = {}, angles = 3, createdBy = 'humano', repo = null }) {
    const chosen = ANGLES.slice(0, Math.max(2, Math.min(4, angles)));
    const t = {
      id: uid('t'),
      title: clampStr(title || gist(task, 80), 120),
      task: clampText(task, CAPS.task),
      context: clampText(context, CAPS.context),
      criteria: clampText(criteria, CAPS.criteria),
      agenda,
      settings,
      createdAt: now(),
      createdBy,
      status: 'open',
      rooms: [],
      finalCode: null,
      winner: null,
      repo: repo || null,
      adminToken: token(),
    };
    for (const angle of chosen) {
      const room = this.hall.create({
        title: `${t.title} · ${angle.label}`,
        task: `${t.task}\n\n[ÁNGULO DE ESTA SALA: ${angle.label}] ${angle.prompt}`,
        context: t.context,
        criteria: t.criteria,
        agenda: [...agenda, angle.extraPoint].filter(Boolean),
        settings: { ...settings, ...(angle.settings || {}) },
        tournament: { id: t.id, round: 1, angle: angle.id, angleLabel: angle.label },
        createdBy,
      });
      t.rooms.push({ code: room.code, angle: angle.id, angleLabel: angle.label, round: 1, needsRepo: !!repo });
    }
    this.list_.unshift(t);
    this.save();
    return t;
  }

  // Avanza los torneos: cuando todas las salas de ronda 1 cierran, abre la final
  // con los planes ganadores como material de partida.
  tick() {
    let changed = false;
    for (const t of this.list_) {
      if (t.status === 'open') {
        const rooms = t.rooms.filter(r => r.round === 1).map(r => this.hall.get(r.code)).filter(Boolean);
        if (rooms.length && rooms.every(r => r.status === 'closed')) {
          const finalRoom = this.openFinal(t, rooms);
          t.finalCode = finalRoom.code;
          t.status = 'final';
          changed = true;
        }
      } else if (t.status === 'final' && t.finalCode) {
        const final = this.hall.get(t.finalCode);
        if (final && final.status === 'closed') {
          t.status = 'closed';
          t.winner = final.result?.winner?.title || null;
          t.consensus = final.result?.consensus?.global ?? null;
          t.closedAt = now();
          changed = true;
        }
      }
    }
    if (changed) this.save();
    return changed;
  }

  openFinal(t, rooms) {
    const winners = [];
    for (const room of rooms) {
      const w = room.result?.winner;
      if (!w) continue;
      const work = room.result?.work;
      winners.push({
        room: room.code,
        angle: room.tournament?.angleLabel || '',
        title: w.title,
        author: w.author,
        plan: w.plan,
        positions: w.positions || {},
        final: room.result?.final || w.plan,
        checks: (room.result?.checks || []).map(c => c.claim),
        // Si la ronda previa trabajó sobre un repo, la final recibe qué cambió cada
        // ángulo: rama, commits y tamaño del diff. Sin eso, la final decidiría a ciegas.
        work: work
          ? {
            branch: work.branch,
            items: work.stats?.items ?? 0,
            integrated: work.stats?.integrated ?? 0,
            stats: work.stats ? { files: work.stats.files, insertions: work.stats.insertions, deletions: work.stats.deletions } : null,
            commits: (work.commits || []).map(c => c.subject).slice(0, 6),
          }
          : null,
      });
    }
    const context = [
      t.context,
      '',
      'PLANES FINALISTAS DE LA RONDA PREVIA:',
      ...winners.map((w, i) => [
        `--- Finalista ${i + 1} (${w.angle}) — «${w.title}» de ${w.author} (sala ${w.room}) ---`,
        clampText(w.final, 1200),
        w.checks.length ? `Comprobaciones propuestas: ${w.checks.join('; ')}` : '',
        w.work
          ? `Cambios ya aplicados en esa sala (rama ${w.work.branch}): ${w.work.integrated}/${w.work.items} mejoras integradas` +
            `${w.work.stats ? `, ${plural(w.work.stats.files, 'archivo')} +${w.work.stats.insertions}/-${w.work.stats.deletions}` : ''}.` +
            `${w.work.commits.length ? ` Commits: ${w.work.commits.join(' | ')}` : ''}`
          : '',
      ].filter(Boolean).join('\n')),
      '',
      'Ágora final: no repitas la ronda anterior. Contrasta los finalistas, quédate con lo mejor de cada uno y resuelve las diferencias con criterio explícito.',
    ].join('\n');

    const finalRoom = this.hall.create({
      title: `${t.title} · FINAL`,
      task: `${t.task}\n\n[RONDA FINAL] Debes producir el plan definitivo integrando o descartando los finalistas con razones.`,
      context,
      criteria: t.criteria ? `${t.criteria}\nDebe integrar explícitamente lo mejor de los planes finalistas.` : 'Debe integrar explícitamente lo mejor de los planes finalistas.',
      agenda: t.agenda,
      settings: { ...t.settings, minAgents: Math.min(2, t.settings?.minAgents || 2), expectedAgents: 0, joinQuietMs: 120_000 },
      tournament: { id: t.id, round: 2, angle: 'final', angleLabel: 'Final' },
      createdBy: t.createdBy,
    });
    if (this.hall.log) void this.hall.log;
    finalRoom.log.push({
      id: ++finalRoom.logSeq, ts: now(), agentId: null, kind: 'phase',
      text: `Ágora final abierta con ${plural(winners.length, 'finalista')} de la ronda previa.`,
    });
    t.rooms.push({ code: finalRoom.code, angle: 'final', angleLabel: 'Final', round: 2 });
    this.hall.persist(finalRoom);
    return finalRoom;
  }

  view(t) {
    if (!t) return null;
    return {
      ...t,
      // Solo la fuente del repo (nunca la ruta absoluta del clon de cada sala).
      repo: t.repo ? { source: t.repo.path || t.repo.url || t.repo.source || null, verify: t.repo.verify || null } : null,
      rooms: t.rooms.map(r => {
        const room = this.hall.get(r.code);
        return {
          ...r,
          status: room?.status || 'missing',
          phase: room?.phase?.name || null,
          agents: room?.order?.length || 0,
          consensus: room?.result?.consensus?.global ?? null,
          winner: room?.result?.winner?.title || null,
          title: room?.title || null,
          outcome: room?.result?.outcome || null,
        };
      }),
    };
  }
}
