// Formateadores y etiquetas compartidas.

import type { Macro, Phase, PointStatus } from './types';

export const pct = (v: number | null | undefined, digits = 0) =>
  v == null ? '—' : `${Math.round((v as number) * 100 * (digits ? 10 ** digits : 1)) / (digits ? 10 ** digits : 1)}%`;

export const pct0 = (v: number | null | undefined) => (v == null ? '—' : `${Math.round(v * 100)}%`);

export function timeAgo(ts: number | null | undefined): string {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  const min = Math.round(diff / 60000);
  if (min < 1) return 'ahora';
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.round(h / 24);
  if (d < 30) return `hace ${d} d`;
  return new Date(ts).toLocaleDateString();
}

export function clock(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

export function dateTime(ts: number | null | undefined): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export const PHASE_LABEL: Record<Phase, string> = {
  lobby: 'Lobby',
  frame: 'Encuadre',
  contrast: 'Contraste de ejes',
  audit: 'Auditoría',
  work: 'Trabajo',
  proposal: 'Propuestas',
  critique: 'Crítica',
  revise: 'Revisión',
  vote: 'Votación',
  tiebreak: 'Desempate',
  objection: 'Vetos',
  repair: 'Reparación',
  synthesis: 'Síntesis',
  verify: 'Verificación',
  review: 'Revisión posterior',
  closed: 'Resultado',
};

export const PHASE_DESCRIPTION: Record<Phase, string> = {
  lobby: 'Los agentes entran y el debate arranca solo al reunir los mínimos. Cada harness entra como es.',
  frame: 'Proponen puntos de decisión y negocian las reglas.',
  contrast: 'Con la agenda a la vista se añade el eje que faltó y se impugna el que sobra; lo impugnado no se borra, se debate sabiendo que se discute.',
  audit: 'Leen el repositorio y dejan hallazgos anclados a archivos; los mejores se votan como cualquier punto.',
  work: 'Cada mejora aprobada se convierte en una tarea: uno la reclama, otro la revisa y el servidor verifica antes de commitear.',
  proposal: 'Propuestas a ciegas: nadie ve las demás hasta que todas entran.',
  critique: 'El servidor asigna propuestas ajenas para atacar (advocatus diaboli).',
  revise: 'Cada autor responde a las objeciones o retira su propuesta.',
  vote: 'Voto secreto por orden de preferencia.',
  tiebreak: 'Alegato decisivo y segunda votación entre finalistas.',
  objection: 'Ventana de veto: un fallo fatal obliga a reparar.',
  repair: 'El autor aborda el veto o lo rebate por escrito.',
  synthesis: 'El autor de la ganadora fusiona su plan con las objeciones válidas.',
  verify: 'Otro agente convierte el plan en comprobaciones falsables.',
  review: 'Se revisa el trabajo ya integrado como conjunto: ¿hizo lo que el plan decía y aún se puede mejorar algo?',
  closed: 'Resultado congelado con checksum.',
};

export const MACRO_LABEL: Record<Macro, string> = {
  presentation: 'Presentación',
  debate: 'Debate',
  synthesis: 'Síntesis',
  decision: 'Decisión',
  work: 'Trabajo',
};

export const MACRO_PHASES: Record<Macro, Phase[]> = {
  presentation: ['lobby', 'frame', 'contrast', 'audit', 'proposal'],
  debate: ['critique', 'revise', 'vote', 'tiebreak'],
  synthesis: ['objection', 'repair', 'synthesis'],
  decision: ['verify', 'closed'],
  work: ['work', 'review'],
};

export const MACRO_ORDER: Macro[] = ['presentation', 'debate', 'synthesis', 'decision', 'work'];

export const MACRO_SUBTITLE: Record<Macro, string> = {
  presentation: '',
  debate: '',
  synthesis: 'En curso',
  decision: '',
  work: '',
};

// Estados de una tarea de trabajo (el servidor los nombra en inglés).
export const WORK_STATUS_LABEL: Record<string, string> = {
  open: 'libre',
  claimed: 'en curso',
  'in-review': 'en revisión',
  verifying: 'verificando',
  integrated: 'integrada',
  reverted: 'deshecha',
  failed: 'fallida',
  skipped: 'no integrada',
};

export const WORK_STATUS_TONE: Record<string, string> = {
  open: 'grey',
  claimed: 'blue',
  'in-review': 'purple',
  verifying: 'amber',
  integrated: 'green',
  reverted: 'purple',
  failed: 'red',
  skipped: 'amber',
};

// Cómo terminó el debate. Todo en español y con color honesto: verde solo si hubo plan.
export const OUTCOME_LABEL: Record<string, string> = {
  incomplete: 'Entrega incompleta',
  decided: 'Completado',
  failed: 'Sin decisión',
  expired: 'Expirado',
  closed: 'Cerrado',
};
export const OUTCOME_TONE: Record<string, 'green' | 'amber' | 'red'> = {
  incomplete: 'amber',
  decided: 'green',
  failed: 'red',
  expired: 'amber',
  closed: 'amber',
};

// El vocabulario del protocolo viaja en inglés (blocker/concern/high/med/low);
// la interfaz lo traduce para que ninguna etiqueta suelta quede a medias.
export const SEVERITY_LABEL: Record<string, string> = {
  blocker: 'bloqueante',
  concern: 'preocupación',
  high: 'alta',
  med: 'media',
  low: 'baja',
};

export const POINT_STATUS_LABEL: Record<PointStatus, string> = {
  agreed: 'Acordado',
  discussing: 'En discusión',
  open: 'Abierto',
  pending: 'Pendiente',
};

export const POINT_STATUS_CLASS: Record<PointStatus, string> = {
  agreed: 'ok',
  discussing: 'disc',
  open: 'disc',
  pending: 'new',
};

export const LOG_KINDS: Record<string, string> = {
  room: 'sistema',
  join: 'entrada',
  phase: 'fase',
  contrast: 'contraste',
  proposal: 'propuesta',
  point: 'agenda',
  rule: 'reglas',
  critique: 'crítica',
  revision: 'revisión',
  concede: 'retirada',
  vote: 'voto',
  argument: 'alegato',
  objection: 'objeción',
  synthesis: 'síntesis',
  verify: 'verificación',
  pass: 'silencio',
  timeout: 'plazo',
  absent: 'ausencia',
  vacancy: 'vacante',
  budget: 'presupuesto',
  closed: 'cierre',
  finding: 'hallazgo',
  work: 'trabajo',
  patch: 'parche',
  review: 'revisión',
};

// El color identifica al HARNESS, que es la identidad real en la sala. Un agente que
// declara su propia lente (opcional) conserva su color de harness.
export const HARNESS_COLORS = ['#22c55e', '#ef4444', '#eab308', '#a855f7', '#6366f1', '#f97316', '#0ea5e9', '#14b8a6'];

export function harnessColor(harness: string | null | undefined): string {
  const key = String(harness || '').trim().toLowerCase();
  if (!key) return '#64748b';
  let h = 0;
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return HARNESS_COLORS[h % HARNESS_COLORS.length];
}

// Reservado para las lentes declaradas que quieran color propio en la ficha del agente.
export function roleColor(role: string | null | undefined): string {
  switch (role) {
    case 'analyst': return '#22c55e';
    case 'skeptic': return '#ef4444';
    case 'creative': return '#eab308';
    case 'strategist': return '#a855f7';
    case 'ethic': return '#6366f1';
    case 'redteam': return '#f97316';
    default: return '#64748b';
  }
}

export function estimateTokens(chars: number): number {
  return Math.round(chars / 3.5);
}

// Plural de verdad: «2 punto(s) sin cerrar» se lee mal, y con cuarenta tarjetas así la
// interfaz parecía una plantilla a medio rellenar. Por defecto basta con añadir «s»; las
// palabras en -ción/-ón llevan su plural explícito.
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
