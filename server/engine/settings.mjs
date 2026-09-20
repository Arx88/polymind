// AGORA v2 — configuración del protocolo: fases, topes, movimientos, roles.
// Todo lo que define «el orden del debate» vive aquí, no disperso por el motor.

export const PHASE_ORDER = [
  'lobby', 'frame', 'contrast', 'audit', 'proposal', 'critique', 'revise', 'vote',
  'tiebreak', 'objection', 'repair', 'synthesis', 'verify', 'work', 'review', 'closed',
];

// Fases que solo existen en algunas salas: 'audit' y 'work' requieren un repo
// adjunto, 'review' solo si hubo algo integrado, y 'tiebreak'/'repair' solo aparecen
// si el debate los necesita. 'contrast' se salta cuando el encuadre no dejó ningún eje
// que contrastar (no hay nada que añadir ni impugnar).
export const OPTIONAL_PHASES = ['tiebreak', 'repair', 'audit', 'work', 'review', 'contrast'];

// Las macro-etapas que ve el usuario en la UI, mapeadas a las fases reales.
export const MACRO_STAGES = [
  { id: 'presentation', label: 'Presentación', phases: ['lobby', 'frame', 'contrast', 'audit', 'proposal'] },
  { id: 'debate', label: 'Debate', phases: ['critique', 'revise', 'vote', 'tiebreak'] },
  { id: 'synthesis', label: 'Síntesis', phases: ['objection', 'repair', 'synthesis'] },
  { id: 'decision', label: 'Decisión', phases: ['verify', 'closed'] },
  { id: 'work', label: 'Trabajo', phases: ['work', 'review'] },
];

export function macroOf(phase) {
  return (MACRO_STAGES.find(s => s.phases.includes(phase)) || MACRO_STAGES[0]).id;
}

export const DEFAULT_SETTINGS = {
  phaseAdvanceMode: 'timed',
  language: 'es',
  minAgents: 2,
  expectedAgents: 0,           // 0 = desconocido; auto-arranque por calma
  joinQuietMs: 90_000,         // silencio de entradas con mínimos reunidos → arranca
  maxDurationMs: 45 * 60_000,
  consensusThreshold: 0.75,    // cuota de la opción modal para marcar un punto «acordado»
  consensusMinShare: 0.5,      // por debajo de esto el punto está «abierto»
  requireDiversity: true,      // exigir enfoques distintos entre propuestas
  // Exigir trabajo extraordinario: no cerrar con lo primero que se integre, sino revisar
  // cada mejora y volver a la cola con lo que aún se pueda mejorar (solo con repo).
  extraordinary: false,
  diversityMax: 0.8,           // similitud de elecciones a partir de la cual se pide cambiar
  requirePositions: false,     // si true, la propuesta sin posiciones se rechaza
  tokenBudgetPerAgent: 0,      // 0 = sin tope; si se agota, el agente pasa a evaluador
  allowMidJoin: true,          // aceptar reemplazos en vacantes durante el debate
  // Solo planificación: la sala termina en un plan y no escribe código. Es la ÚNICA forma de
  // acabar sin entrega; por defecto una sala sin repo crea su propio proyecto y trabaja en él.
  planOnly: false,
  tone: 'profesional y constructivo',
  // A partir de cuánto silencio un agente se muestra «sin señal» en el panel y se le
  // considera desconectado. Un único número para las dos cosas: antes era un 120 000
  // escrito a mano en la vista, que nadie podía ajustar.
  offlineMs: 120_000,
  phaseMs: {
    lobby: 10 * 60_000, frame: 4 * 60_000, contrast: 4 * 60_000, audit: 10 * 60_000, proposal: 8 * 60_000,
    critique: 6 * 60_000,
    revise: 6 * 60_000, vote: 4 * 60_000, tiebreak: 4 * 60_000, objection: 3 * 60_000,
    repair: 6 * 60_000, synthesis: 6 * 60_000, verify: 5 * 60_000, work: 30 * 60_000,
    review: 8 * 60_000,
  },
  // Trabajo conjunto sobre el repo (solo si la sala trae repo). El servidor aplica
  // parches y ejecuta ESTE comando; los agentes nunca ejecutan nada por su cuenta.
  repo: {
    verifyCommand: '',          // p. ej. "npm test"; vacío = sin verificación ejecutable
    verifyTimeoutMs: 5 * 60_000,
    baseline: true,             // correr la verificación al adjuntar, como referencia
    // Cuántas mejoras aprobadas pasan a la cola de trabajo. No es un techo de lo que un
    // agente puede proponer (los hallazgos no tienen tope): es cuánto trabajo se ejecuta
    // de una vez. Lo que no entra queda listado como aplazado, con su origen, en el
    // resultado. Se puede subir: una auditoría en un repo grande produce muchos.
    maxWorkItems: 12,
    // Una tarea reclamada por alguien que lleva este tiempo sin dar señales vuelve
    // al montón: el trabajo no depende de que un agente desaparezca con su tarea.
    // Cuánto se espera a un agente que reclamó una tarea antes de devolverla al montón.
    // Cinco minutos era demasiado poco: quien verifica su parche en local se pasaba del
    // plazo sin dar señales y perdía la tarea a mitad. Se puede bajar, pero el defecto
    // acompaña a un trabajo real.
    claimIdleMs: 20 * 60_000,
    // Rondas de revisión posteriores como máximo cuando la sala exige trabajo extraordinario.
    reviewRounds: 2,
    // Mejora RECURSIVA: cuántas rondas más de auditoría sobre el código ya mejorado admite la
    // sala. Con 0 (defecto) la sala hace su trabajo y cierra. Con N, al agotarse el trabajo y su
    // revisión la sala vuelve a auditar el repo — con los parches ya integrados como base — y
    // repite el ciclo. Se detiene sola en cuanto una ronda de auditoría no encuentra nada nuevo:
    // eso ES la declaración conjunta de «no hay más que mejorar» (y queda escrita en el acta).
    // El tope existe para que una sala no sea eterna, no para decidir cuándo termina.
    recursionRounds: 0,
  },
};

// Umbrales de silencio en milisegundos, ya resueltos con la configuración de la sala.
export function offlineThresholdMs(room) {
  const v = Number(room?.settings?.offlineMs);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_SETTINGS.offlineMs;
}

// Cuánto puede un agente tener un turno en la mano antes de darse por perdido. Se apoya en el
// mismo número con el que la sala define «sin señal» (offlineMs) y nunca baja de 10 minutos:
// escribir un plan largo es trabajo, no abandono.
export function turnHoldMs(room) {
  return Math.max(10 * 60_000, offlineThresholdMs(room));
}

// ¿Cuánto silencio hace falta para decir que un agente está «sin señal»?
//
// «Sin señal» no puede significar «está pensando». El motor le entregó a este agente una acción
// de la fase abierta (`awaiting`) y todavía no la ha devuelto: la sala lo está esperando, así que
// la paciencia es la del motor (turnHoldMs), no la del vistazo rápido. Sin esto, un panel con
// umbral de dos minutos marcaba desconectados a harnesses que estaban escribiendo un parche
// (medido en una sala real: turnos de 2 a 7 minutos) y el humano acababa «reconectando» a quien
// nunca se había ido. Se apaga solo: en cuanto entrega, o en cuanto se deja de esperar su turno,
// vuelve a mandar offlineMs.
export function offlineGraceMs(room, agent) {
  const awaiting = agent?.awaiting && agent.awaiting.phase === room?.phase?.name;
  return awaiting ? turnHoldMs(room) : offlineThresholdMs(room);
}

// Rondas de mejora recursiva permitidas (0 = la sala cierra tras su trabajo).
export function recursionRounds(room) {
  const v = Number(room?.settings?.repo?.recursionRounds);
  return Number.isFinite(v) && v > 0 ? Math.min(6, Math.round(v)) : 0;
}

export function claimIdleThresholdMs(room) {
  const v = Number(room?.settings?.repo?.claimIdleMs);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_SETTINGS.repo.claimIdleMs;
}

// Techos de seguridad del servidor: la frontera entre «esto es una protección de memoria»
// y «esto le dice a un harness cuánto puede escribir».
//
// FILOSOFÍA — por qué aquí casi todo es enorme o directamente libre: en esta plataforma
// trabajan harnesses completos, que ya saben decidir por sí mismos cuánto necesitan decir.
// Un agente que se explica largo, que ataca con treinta objeciones o que manda un refactor
// de cuarenta archivos está haciendo su oficio; recortarle el texto no mejora el debate,
// lo empobrece y le cuesta tokens en llamadas extra para decir lo mismo por partes. Por
// eso se distinguen dos clases de techo:
//
//   · CONTENIDO (lo que el harness escribe con sus propias palabras: planes, objeciones,
//     notas, evidencia, hallazgos, parches). No tiene tope práctico: TEXT, 1 MB por campo,
//     es un millón de caracteres para una sola respuesta, muy por encima de cualquier
//     turno real. El único límite verdadero es el cuerpo de la petición (32 MB) y su
//     mensaje lo explica.
//   · CLAVE (etiquetas, opciones, rutas de archivo, ids de base): cortos a propósito.
//     No son prosa: son el índice con el que el debate se cuenta, y una etiqueta de
//     medio megabyte rompería la interfaz sin aportar nada.
//
// Nada de esto rechaza un movimiento: se aplica por coerción, y si algún techo llegara a
// morder, el movimiento lo DICE con la cifra exacta y qué quedó fuera (`fit`/`fitList` en
// util.mjs). Perder texto de un agente en silencio es un fallo, no una política.
const TEXT = 1_000_000;          // contenido libre, en caracteres
const ELEMENTS = 500;            // contenido libre, en número de elementos

export const CAPS = {
  task: TEXT, context: TEXT, criteria: TEXT,
  proposalTitle: 300, proposalPlan: TEXT, proposalPremortem: TEXT,
  proposalRisks: TEXT, proposalAssumptions: TEXT, proposalApproach: 600,
  pointLabel: 400, pointOption: 300, pointNote: TEXT, maxPoints: 40, maxOptionsPerPoint: 24,
  steelman: TEXT, objectionsPerCritique: ELEMENTS, objectionText: TEXT,
  revisionNote: TEXT, tiebreakArg: TEXT, objectionMsg: TEXT, synthesisFinal: TEXT,
  // Disenso protegido: por qué un autor se movió de posición y con qué base se resuelve
  // un punto abierto en la síntesis.
  driftReason: TEXT, resolutionBasis: 20, resolutionEvidence: TEXT,
  ruleChangeText: TEXT, checksPerAgent: ELEMENTS, checkMethod: TEXT, checkExpectation: TEXT,
  findingText: TEXT, checkClaim: TEXT, gist: 220,
  // Auditoría del repo y trabajo conjunto.
  findingsPerAgent: 200, findingClaim: TEXT, findingAction: TEXT, findingEvidence: TEXT,
  findingFile: 400, findingLine: 12, findingSymbol: 200, findingNote: TEXT,
  maxFindingPoints: 40, workNote: TEXT, reviewNotes: TEXT, patchSummary: TEXT,
  // Un parche puede tocar la lista de archivos que toque y traer archivos grandes. El
  // contenido de un archivo se guarda byte a byte: normalizarlo lo rompería.
  patchDiffMax: 4_000_000, patchFilesMax: ELEMENTS, patchFileMax: 4_000_000,
  // Revisión posterior al trabajo: qué ve cada agente del diff y qué puede proponer.
  // El diff va COMPLETO en el turno del revisor: truncarlo obligaba a un segundo viaje
  // por HTTP para leer lo que ya estaba en el árbol, que es justo el gasto que se quería
  // evitar.
  reviewDiffChars: 4_000_000, recheckAction: TEXT, recheckClaim: TEXT, recheckEvidence: TEXT,
  progressNote: TEXT,
};

// Cómo se describen en los esquemas que ve el agente los campos de contenido libre: sin
// cifras que parezcan un presupuesto de palabras.
export const FREE_TEXT = 'texto libre — sin tope práctico, escribe lo que el problema pida';

// Fases que aportan movimientos propios al protocolo cuando hay repo adjunto.
// (Se mantienen aquí, con el resto del «orden del debate», para que la lista de
// movimientos válidos siga siendo una sola fuente de verdad.)

// Movimientos válidos por fase.
export const MOVE_KINDS = {
  lobby: ['start', 'pass'],
  frame: ['point-proposal', 'rule-change', 'ratify', 'pass'],
  // Contraste de ejes: con los puntos de todos ya a la vista (ya no hay riesgo de anclar a
  // nadie), se añade el eje que falta, se impugna el que sobra o se fusionan dos que son el
  // mismo. Sin esto, el encuadre era definitivo y un eje ausente no podía entrar jamás.
  contrast: ['point-proposal', 'point-challenge', 'pass'],
  audit: ['finding', 'pass'],
  proposal: ['proposal'],
  critique: ['critique'],
  revise: ['revision', 'concede', 'pass'],
  vote: ['vote'],
  tiebreak: ['argument', 'vote'],
  objection: ['objection', 'pass'],
  repair: ['revision', 'pass'],
  synthesis: ['synthesis'],
  verify: ['verification', 'pass'],
  work: ['claim-item', 'submit-patch', 'review-patch', 'progress', 'pass'],
  review: ['recheck', 'pass'],
  closed: [],
};

export const ROLES = {
  analyst: {
    label: 'Analista',
    caps: ['data', 'logic'],
    lens: {
      es: 'Lente de analista: pide magnitudes, evidencia y criterios medibles. Desconfía de cualquier afirmación sin número o sin fuente.',
      en: 'Analyst lens: demand magnitudes, evidence and measurable criteria. Distrust any claim without a number or a source.',
    },
  },
  skeptic: {
    label: 'Escéptico',
    caps: ['logic', 'risk'],
    lens: {
      es: 'Lente de escéptico: busca el fallo que nadie vio, el supuesto oculto y el escenario donde el plan se rompe.',
      en: 'Skeptic lens: hunt the overlooked failure, the hidden assumption and the scenario where the plan breaks.',
    },
  },
  creative: {
    label: 'Creativo',
    caps: ['creativity'],
    lens: {
      es: 'Lente creativa: propón la opción que nadie planteó y combina ideas existentes de forma nueva, sin perder viabilidad.',
      en: 'Creative lens: propose the option nobody raised and recombine existing ideas, without losing feasibility.',
    },
  },
  strategist: {
    label: 'Estratega',
    caps: ['logic', 'synthesis'],
    lens: {
      es: 'Lente estratégica: conecta decisiones con objetivos, ordena prioridades y señala qué se sacrifica en cada camino.',
      en: 'Strategist lens: tie decisions to goals, order priorities and name what each path sacrifices.',
    },
  },
  ethic: {
    label: 'Ético',
    caps: ['ethics', 'risk'],
    lens: {
      es: 'Lente ética: evalúa impacto en personas, riesgos de segundo orden y qué pasa si todos adoptan la misma solución.',
      en: 'Ethics lens: weigh impact on people, second-order risks and what happens if everyone adopts the same solution.',
    },
  },
  redteam: {
    label: 'Red team',
    caps: ['risk', 'logic'],
    lens: {
      es: 'Lente de red team: intenta demostrar que el plan falla en producción y describe el escenario concreto del fallo.',
      en: 'Red team lens: try to prove the plan fails in production and describe the concrete failure scenario.',
    },
  },
};

export const ROLE_IDS = Object.keys(ROLES);

// NOTA de diseño: aquí se debate entre harnesses, no entre personajes. Un harness
// ya trae sus propios subagentes y lentes internas. Por eso NADA de esto se asigna:
// un agente puede DECLARAR una lente (de esta lista o con texto libre) y entonces el
// servidor se la recuerda en su turno; si no declara nada, debate como sí mismo
// (harness + modelo) sin que la plataforma le imponga una identidad.

export const CAPABILITIES = {
  data: 'Análisis de datos',
  web: 'Investigación web',
  logic: 'Razonamiento lógico',
  creativity: 'Creatividad',
  risk: 'Evaluación de riesgos',
  synthesis: 'Síntesis',
  negotiation: 'Negociación',
  ethics: 'Impacto ético',
};

export const CAPABILITY_IDS = Object.keys(CAPABILITIES);

// La lente solo existe si el propio agente la declaró. No hay rotación ni reparto.
export function lensFor(role, language = 'es') {
  const r = ROLES[role];
  if (!r) return '';
  return r.lens[language] || r.lens.en || r.lens.es;
}

// Etiqueta de la lente declarada; cadena vacía si el agente no declaró ninguna
// (lo normal: la identidad es su harness y su modelo).
export function roleLabel(role) {
  if (!role) return '';
  return ROLES[role]?.label || String(role);
}

// Acepta una lente conocida o texto libre declarado por el agente.
export function normalizeLens(raw) {
  const value = typeof raw === 'string' ? raw.trim().slice(0, 60) : '';
  if (!value) return null;
  const lower = value.toLowerCase();
  if (ROLE_IDS.includes(lower)) return lower;
  return value;
}

// Normaliza los settings que llegan de fuera (humano, plantilla o agente).
export function pickSettings(input = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const s = {
    phaseAdvanceMode: src.phaseAdvanceMode === 'agreement' ? 'agreement' : 'timed',
    language: ['es', 'en', 'pt'].includes(src.language) ? src.language : DEFAULT_SETTINGS.language,
    // Sin tope práctico: la sala no decide cuántos harnesses caben en un debate. Estos
    // números solo coordinan el arranque (mínimo para empezar y cuántos se esperan).
    minAgents: clampInt(src.minAgents, DEFAULT_SETTINGS.minAgents, 1, 64),
    expectedAgents: clampInt(src.expectedAgents, 0, 0, 64),
    joinQuietMs: clampInt(src.joinQuietMs, DEFAULT_SETTINGS.joinQuietMs, 1000, 30 * 60_000),
    maxDurationMs: clampInt(src.maxDurationMs, DEFAULT_SETTINGS.maxDurationMs, 60_000, 6 * 3600_000),
    consensusThreshold: clampFraction(src.consensusThreshold, DEFAULT_SETTINGS.consensusThreshold, 0.5, 1),
    consensusMinShare: clampFloat(src.consensusMinShare, DEFAULT_SETTINGS.consensusMinShare, 0.1, 0.9),
    requireDiversity: src.requireDiversity === undefined ? DEFAULT_SETTINGS.requireDiversity : !!src.requireDiversity,
    diversityMax: clampFloat(src.diversityMax, DEFAULT_SETTINGS.diversityMax, 0.5, 1),
    requirePositions: !!src.requirePositions,
    tokenBudgetPerAgent: clampInt(src.tokenBudgetPerAgent, 0, 0, 2_000_000),
    allowMidJoin: src.allowMidJoin === undefined ? DEFAULT_SETTINGS.allowMidJoin : !!src.allowMidJoin,
    planOnly: src.planOnly === undefined ? DEFAULT_SETTINGS.planOnly : !!src.planOnly,
    tone: String(src.tone || DEFAULT_SETTINGS.tone).slice(0, 80),
    offlineMs: clampInt(src.offlineMs, DEFAULT_SETTINGS.offlineMs, 30_000, 30 * 60_000),
    extraordinary: src.extraordinary === undefined ? DEFAULT_SETTINGS.extraordinary : !!src.extraordinary,
    phaseMs: { ...DEFAULT_SETTINGS.phaseMs },
    // El trabajo sobre el repo tiene sus propios topes. Antes no se normalizaban: lo
    // que mandaras aquí se descartaba en silencio y el motor usaba sus valores por
    // defecto, así que la sala no podía bajar el límite de tareas ni el de paciencia
    // con un agente que se apaga a mitad.
    repo: { ...DEFAULT_SETTINGS.repo },
  };
  const pm = src.phaseMs && typeof src.phaseMs === 'object' ? src.phaseMs : {};
  for (const k of Object.keys(DEFAULT_SETTINGS.phaseMs)) {
    if (pm[k] != null) s.phaseMs[k] = clampInt(pm[k], DEFAULT_SETTINGS.phaseMs[k], 5000, 60 * 60_000);
  }
  const rp = src.repo && typeof src.repo === 'object' ? src.repo : {};
  // Un comando de verificación no se recorta nunca a media línea: cortarlo cambiaría lo
  // que el servidor ejecuta, que es peor que rechazarlo. 2 000 caracteres no los alcanza
  // ninguna suite real.
  s.repo.verifyCommand = String(rp.verifyCommand ?? '').replace(/\s+/g, ' ').trim().slice(0, 2_000);
  s.repo.verifyTimeoutMs = clampInt(rp.verifyTimeoutMs, DEFAULT_SETTINGS.repo.verifyTimeoutMs, 5_000, 20 * 60_000);
  s.repo.baseline = rp.baseline === undefined ? DEFAULT_SETTINGS.repo.baseline : !!rp.baseline;
  s.repo.maxWorkItems = clampInt(rp.maxWorkItems, DEFAULT_SETTINGS.repo.maxWorkItems, 1, 200);
  s.repo.claimIdleMs = clampInt(rp.claimIdleMs, DEFAULT_SETTINGS.repo.claimIdleMs, 30_000, 60 * 60_000);
  s.repo.reviewRounds = clampInt(rp.reviewRounds, DEFAULT_SETTINGS.repo.reviewRounds, 1, 3);
  s.repo.recursionRounds = clampInt(rp.recursionRounds, DEFAULT_SETTINGS.repo.recursionRounds, 0, 6);
  if (s.expectedAgents > 0) s.minAgents = Math.min(s.minAgents, s.expectedAgents);
  return s;
}

function clampInt(v, dflt, min, max) {
  const n = typeof v === 'number' ? v : parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.round(n)));
}
function clampFloat(v, dflt, min, max) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

// Cuotas y umbrales se escriben de las dos formas: 0.7 o 70. Interpretar 70 como
// «siete mil por ciento recortado a 100» rompería el debate en silencio.
function clampFraction(v, dflt, min, max) {
  let n = typeof v === 'number' ? v : parseFloat(v);
  if (!Number.isFinite(n)) return dflt;
  if (n > 1 && n <= 100) n = n / 100;
  return Math.min(max, Math.max(min, n));
}
