// Tipos de la API de AGORA v2 (lo que devuelve /api/rooms/:code/public y compañía).

export type Phase =
  | 'lobby' | 'frame' | 'contrast' | 'audit' | 'proposal' | 'critique' | 'revise' | 'vote'
  | 'tiebreak' | 'objection' | 'repair' | 'synthesis' | 'verify' | 'work' | 'review' | 'closed';

export type Macro = 'presentation' | 'debate' | 'synthesis' | 'decision' | 'work';

export type WorkStatus = 'open' | 'claimed' | 'in-review' | 'verifying' | 'integrated' | 'reverted' | 'failed' | 'skipped';

// Repositorio adjunto: el servidor lo clona aparte y trabaja en su propia rama.
export interface RepoSummary {
  source: string;
  kind: 'path' | 'url';
  ref: string | null;
  branch: string;
  baseCommit: string;
  head: string;
  files: number;
  directories: { name: string; count: number }[];
  extensions: { name: string; count: number }[];
  verify: string | null;
  // De dónde salió el comando de verificación (declarado o detectado en el proyecto).
  verifySource?: { detected: boolean; why: string } | null;
  verifyTimeoutMs: number | null;
  baseline: VerifyRun | null;
  // Publicación de la rama: destino declarado por el humano y qué se publicó ya.
  pushTo?: string | null;
  pushed?: string[];
  pushedAt?: number | null;
  // Hasta qué commit salió la rama y si el remoto se ha quedado atrás después.
  pushedHead?: string | null;
  pushedOutdated?: boolean;
  attachedAt: number;
}

// Resultado de ejecutar el comando de verificación de la sala.
export interface VerifyRun {
  status?: 'running' | 'done';
  ran: boolean;
  ok?: boolean | null;
  exitCode?: number | null;
  command?: string | null;
  durationMs?: number | null;
  timedOut?: boolean;
  outputTail?: string | null;
  at?: number;
}

// Hallazgo de la auditoría: qué está mal, con qué evidencia y qué mejora aplicable.
export interface Finding {
  id: string;
  byName: string;
  severity: 'high' | 'med' | 'low';
  file: string | null;
  line: number | null;
  symbol: string | null;
  claim: string;
  evidence: string;
  action: string;
  pointId: string | null;
}

export interface WorkItem {
  id: string;
  pointId: string;
  title: string;
  status: WorkStatus;
  severity: 'high' | 'med' | 'low';
  files: string[];
  share: number;
  voters: number;
  claim: string;
  evidence: string;
  attempt: number;
  verifyFailures: number;
  byName: string | null;
  reviewerName: string | null;
  commit: string | null;
  unreviewed: boolean;
  verify: { ran: boolean; ok: boolean | null; exitCode: number | null; command: string | null; durationMs: number | null; preExisting: boolean } | null;
  // Deshacer una mejora integrada es una decisión del humano: viaja con su motivo y con
  // la verificación posterior, para que la fila no tenga que interpretarse.
  revert: {
    of: string;
    commit: string | null;
    reason: string | null;
    by: string | null;
    at: number;
    files: string[];
    verify: { status: string; ran: boolean; ok: boolean | null; exitCode: number | null; command: string | null; durationMs: number | null; outputTail: string | null } | null;
  } | null;
  // Y si después se volvió a aplicar: deshacer no borra la historia.
  reapplied: {
    of: string;
    commit: string | null;
    reason: string | null;
    by: string | null;
    at: number;
    revertedAt: number | null;
    verify: { status: string; ran: boolean; ok: boolean | null; exitCode: number | null; command: string | null; durationMs: number | null; outputTail: string | null } | null;
  } | null;
  lastError: string | null;
  note: string | null;
  patchId: string | null;
  patches: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface WorkPatch {
  id: string;
  itemId: string;
  authorName: string;
  mode: string;
  summary: string;
  stat: { files: number; insertions: number; deletions: number; list: { path: string; insertions: number; deletions: number }[] } | null;
  committed: boolean;
  superseded: boolean;
  sha: string | null;
  at: number;
  diffLines: number;
  review: { byName: string; verdict: 'approve' | 'changes'; notes: string } | null;
  verify: { ran: boolean; ok: boolean | null; exitCode: number | null; command: string | null; durationMs: number | null; status: string; outputTail: string | null } | null;
}

// Consenso por macro-etapa: lo cerrado viene congelado y la etapa en curso, en vivo.
export interface ConsensusStage {
  macro: Macro;
  label: string;
  // 'skipped' = la sala cerró sin llegar a medir esa etapa (no es «aún no llega»).
  status: 'now' | 'done' | 'pending' | 'skipped';
  global: number | null;
  agreed: number | null;
  total: number | null;
  unresolved: number | null;
  measured: boolean;
  // La etapa de trabajo se mide con su tablero (integradas sobre total), no con el consenso del
  // plan: un plan acordado al 100% no dice nada de si el código existe.
  work?: { integrated: number; total: number; inProgress: number; free: number; failed: number; finishedAt: number | null } | null;
  phase: Phase | null;
  at: number | null;
}

// Revisión posterior al trabajo: qué mejoras integradas ya miró otro agente y qué falta.
export interface WorkReviewState {
  active: boolean;
  round: number;
  maxRounds: number;
  extraordinary: boolean;
  total: number;
  // null = no hay registro de veredictos (sala anterior a la revisión posterior).
  reviewed: number | null;
  unknown?: boolean;
  reviewedItems?: { id: string; by: string[] }[];
  pending: { id: string; title: string; files: string[]; byName: string | null }[];
  proposals: { title: string; files: string[]; severity: string; action: string; byName: string | null }[];
}

// Tablero de trabajo: tareas aprobadas, parches, verificación y rama.
export interface WorkState {
  branch: string;
  baseCommit: string;
  head: string | null;
  startedAt: number;
  finishedAt: number | null;
  items: WorkItem[];
  patches: WorkPatch[];
  pending: { patchId: string; itemId: string; status: string } | null;
  stats: {
    items: number; integrated: number; reverted: number; failed: number; skipped: number; open: number;
    unreviewed: number; deferredFindings: number; skippedByCap: number; verifyRuns: number;
    files: number; insertions: number; deletions: number; list: { path: string; insertions: number; deletions: number }[];
  };
  baseline: VerifyRun | null;
  verifyCommand: string | null;
  verifySource?: { detected: boolean; why: string } | null;
  review?: WorkReviewState | null;
  rechecks?: { of: string; kind: 'revert' | 'reapply'; command: string | null }[];
  busy?: string | null;
}
export type PointStatus = 'agreed' | 'discussing' | 'open' | 'pending';
export type AgentStatus = 'active' | 'absent';

export interface RosterAgent {
  id: string;
  name: string;
  model: string;
  harness: string;
  role: string | null;
  roleLabel: string;
  capabilities: string[];
  status: AgentStatus;
  overBudget: boolean;
  lastSeenAt: number;
  online: boolean;
  // El trabajo que este agente tiene EN LA MANO ahora mismo (reclamado o en revisión). `null` =
  // ninguno. Es lo que permite decir «Trabajando en w1» en lugar de deducir una desconexión a
  // partir de un umbral de presencia: escribir un parche no es dejar de estar.
  holding?: {
    itemId: string; title: string; state: 'working' | 'reviewing'; since: number | null;
    // Lo demás que sostiene además de su tarea (revisiones encima).
    also?: { itemId: string; title: string; state: 'working' | 'reviewing'; since: number | null }[];
  } | null;
  // Una sola palabra para el panel: 'working' | 'reviewing' | 'online' | 'offline' | 'absent'.
  presence?: 'working' | 'reviewing' | 'online' | 'offline' | 'absent';
  tokens: number;
  onProposal: boolean;
  replacementOf: string | null;
  absentBy: number | null;
}

export interface AgendaChoice {
  id: string;
  label: string;
  count: number;
  share: number;
  agents: string[];
}

export interface AgendaPoint {
  id: string;
  label: string;
  status: PointStatus;
  share: number;
  weight: number;
  source: 'seed' | 'agent';
  voters: number;
  abstain: number;
  modal: { id: string; label: string; count: number; agents: string[] } | null;
  choices: AgendaChoice[];
  options: { id: string; label: string; origin: string; by: string | null }[];
  // Un eje impugnado en el contraste sigue contando, pero se publica que se discute y quién
  // lo trajo. Si nació de una fusión, de dónde salió: el origen no se pierde.
  contested?: boolean;
  challenged?: { by: string; because: string }[];
  mergedFrom?: { label: string; by: string[] }[];
}

// Contraste de ejes, en vivo: la vuelta corta del encuadre, donde la agenda ya está a la vista
// y se añade el eje que falta o se impugna el que sobra.
export interface ContrastView {
  open: boolean;
  challenged: { id: string; label: string; by: string[]; because: string[] }[];
  merged: { from: string; into: string; by: string[] }[];
}

// Auditoría del encuadre, al cerrar el debate: quién definió los ejes, cuáles entraron tarde
// (en el contraste), cuáles se impugnaron y si el primer eje ordenó todo el debate. Proponer a
// ciegas evita el anclaje mientras se escribe, no después: esto es lo que lo muestra.
export interface AgendaReview {
  opened: { id: string; label: string; by: string | null; objections: number; mostObjected: boolean } | null;
  anchored: boolean;
  note: string;
  agentAxes: number;
  proposers: { by: string; count: number; labels: string[] }[];
  addedLate: { id: string; label: string; by: string | null }[];
  challenged: { id: string; label: string; by: string[]; because: string[] }[];
  merged: { from: string; into: string; by: string[]; because: string[]; options: string[] }[];
  keptUnmerged: { label: string; by: string[]; because: string[]; wantedMerge: string[] }[];
  concentration: { by: string; count: number; share: number; flagged: boolean } | null;
}

export interface Proposal {
  id: string;
  // Ronda de mejora recursiva en la que se presentó (1 = el debate inicial).
  round?: number;
  title: string;
  authorName: string;
  authorId: string;
  version: number;
  gist: string;
  plan: string;
  risks: string | null;
  assumptions: string | null;
  premortem: string | null;
  approach: string | null;
  revisionNote: string | null;
  positions: Record<string, string>;
  positionNotes: Record<string, string>;
  conceded: boolean;
  concedeReason: string | null;
  history: number;
  endorsements: string[];
  createdAt: number;
}

export interface Critique {
  id: string;
  authorName: string;
  authorId: string;
  target: string;
  targetTitle: string;
  steelman: string;
  improvements?: SharedImprovement[];
  objections: { type: string; severity: 'high' | 'med' | 'low'; text: string; against?: string | null }[];
}

export interface SharedImprovement { id: string; change: string; why: string; validation: string }
export interface ContributionResponse { contributionId: string; disposition: 'adopted' | 'adapted' | 'declined'; reason: string }

export interface Objection {
  id: string;
  byName: string;
  severity: 'blocker' | 'concern';
  text: string;
  addressed: boolean;
}

export interface Check {
  id: string;
  byName: string;
  claim: string;
  method: string;
  expectation: string;
  pointId: string | null;
  verdict: string;
}

export interface Verification {
  byName: string;
  by: string;
  verdict: 'pass' | 'fail';
  selfVerified: boolean;
  findings: { severity: 'high' | 'med' | 'low'; text: string }[];
  repaired: boolean;
  checks?: number;
}

export interface RuleProposal {
  id: string;
  byName: string;
  text: string;
  op: string;
  ratifications: string[];
  rejectedBy: string[];
  applied: boolean;
}

export interface LogEntry {
  id: number;
  ts: number;
  by: string;
  agentId: string | null;
  kind: string;
  text: string;
}

export interface CostSnapshot {
  perAgent: { id: string; name: string; harness: string | null; role: string | null; estTokens: number; servedChars: number; sentChars: number }[];
  total: number;
  avgPerAgent: number;
}

// Un punto de agenda que llegó con minoría real: quién sostiene qué, con nombres.
export interface DissentPoint {
  id: string;
  label: string;
  status: PointStatus;
  share: number;
  majority: { label: string; share: number; by: string[] } | null;
  minority: { label: string; share: number; by: string[] }[];
}

// Disenso protegido: lo que impide leer una convergencia como un acuerdo. Minorías con
// nombre, puntos resueltos por autoridad sin evidencia y posiciones que se movieron sin
// decir por qué. Se deriva del recuento que ya existe: no gasta ni un token de más.
export interface DissentProtection {
  measured: boolean;
  contestedCount: number;
  contestedShare: number | null;
  // Cuota de puntos votados donde todos eligieron lo mismo. Alto no es bueno en sí mismo.
  unanimity: number | null;
  contestedPoints: DissentPoint[];
  resolutions: {
    pointId: string; pointLabel: string;
    choiceId?: string | null; choiceLabel?: string | null;
    basis: 'evidence' | 'adopted-dissent' | 'authority';
    evidence: string | null; note: string | null;
  }[];
  byAuthority: string[];
  // Puntos con minoría real que la síntesis dejó sin resolver: no mencionarlos no los cierra.
  unresolved: { id: string; label: string }[];
  convergenceWithoutEvidence: {
    count: number; total: number;
    moves: { by: string; point: string; from: string; to: string; because: string | null; evidenced: boolean }[];
  };
  vote: {
    collapsed: boolean; maxSimilarity: number; threshold: number;
    closest: { a: string; b: string; similarity: number } | null;
  };
}

export interface RoomResult {
  task: string;
  title: string;
  language: string;
  outcome: 'decided' | 'failed' | 'expired';
  reason?: string;
  // Entrega congelada con el resultado: código (rama y partes integradas) o solo un plan, con el
  // motivo. Es lo que evita que «no hay código» quede sin explicación en el informe.
  delivery?: Delivery & { items?: number; integrated?: number; files?: number; note?: string };
  winner: {
    id: string; title: string; author: string; authorId: string; version: number;
    plan: string; approach: string | null; premortem: string | null; risks: string | null;
    positions: Record<string, string>;
  } | null;
  final: string;
  finalSource: 'synthesis' | 'winner' | null;
  synthesisBy: string | null;
  collaboration?: (SharedImprovement & { by: string; targetTitle: string; proposalResponse: ContributionResponse | null; finalResponse: ContributionResponse | null })[];
  pointResolutions: { pointId: string; choiceId: string | null; note: string }[];
  merges: string[];
  checks: { id: string; by: string; point: string | null; claim: string; method: string; expectation: string; verdict: string }[];
  verification: { by: string; verdict: string; selfVerified: boolean; findings: { severity: string; text: string }[]; repaired: boolean } | null;
  consensus: {
    global: number; method: 'agenda' | 'ballots'; threshold: number;
    agreed: number; discussing: number; open: number; pending: number; total: number;
    stages?: ConsensusStage[];
    points: {
      id: string; label: string; status: PointStatus; share: number;
      modal: { id: string; label: string; agents: string[] } | null;
      choices: { label: string; count: number; share: number; agents: string[] }[];
    }[];
  };
  dissent: { by: string; text: string; severity: string; addressed: boolean; point?: string }[];
  dissentProtection?: DissentProtection;
  // El encuadre, auditado al cerrar: quién abrió el marco y si ordenó el debate.
  agendaReview?: AgendaReview;
  ruleChanges: { text: string; by: string; op: string | null }[];
  repo?: RepoSummary | null;
  work?: (WorkState & { commits: { sha: string; author: string; subject: string; at: number }[]; undebated: { byName: string; file: string | null; action: string }[] }) | null;
  ballots: Record<string, string[]>;
  // Marcador por harness: qué hizo cada agente, contado desde el registro.
  scoreboard?: {
    byAgent: {
      id: string; name: string; harness: string | null; model: string | null; status: AgentStatus;
      moves: number; tokens: number;
      votedWinner: boolean; wonProposal: boolean;
      agreedPoints: number; dissentPoints: number;
      proposals: number; revised: number; conceded: number;
      objections: number; blockers: number; checks: number; verifier: boolean;
      findings: number; corroboratedFindings: number;
      patches: number; reviews: number; integrated: number; reverted: number; rejectedPatches: number;
    }[];
    highlights: { label: string; value: number; names: string[] }[];
  } | null;
  cost: CostSnapshot & { totalChars: number; estTokens: number; perPhaseTokens: Record<string, number> };
  roster: RosterAgent[];
  stats: {
    agents: number; active: number; proposals: number; critiques: number;
    objections: number; checks: number; durationMin: number;
  };
  closedAt: number;
  checksum: string;
}

// Estado de un agente durante la fase actual, tal como lo calcula el servidor.
export type MemberState = 'pending' | 'delivered' | 'free';
export interface LiveMember {
  id: string;
  name: string;
  harness: string | null;
  status: AgentStatus;
  online: boolean;
  lastSeenAt: number;
  state: MemberState;
  action: string | null;
}

// Radiografía del directo: quién tiene turno, quién ya entregó y qué falta para cerrar.
export interface LiveState {
  status: 'lobby' | 'debate' | 'closed';
  phase: Phase;
  phaseLabel: string;
  mechanism: string | null;
  next: string | null;
  deadlineInSec: number;
  // Veces que se ha ampliado el plazo de esta fase porque alguien tenía el turno entregado
  // y sin responder: la fase no cierra encima de quien está trabajando.
  phaseExtensions: number;
  pending: number;
  delivered: number;
  expected: number;
  who: { id: string; name: string; harness: string | null; action: string; online: boolean }[];
  members: LiveMember[];
  lastEvent: { id: number; kind: string; text: string; by: string | null; at: number } | null;
  // Disenso protegido en vivo: puntos disputados, convergencia sin evidencia y el aviso
  // de propuestas que llegaron casi idénticas a la votación.
  dissent: DissentProtection;
  waitingFor: number | null;
}

// Vista previa del trabajo: qué se puede enseñar del árbol de trabajo de la sala y por qué no,
// cuando no se puede. El `entry` es la página que se carga en el iframe.
// Un archivo tocado y todavía sin commitear: es lo que hace que la vista previa sea del trabajo EN
// CURSO y no de una foto. `at` es la hora en que se escribió (para decir «hace 8 s»).
export interface PreviewChange {
  path: string;
  code: string;
  status: 'nuevo' | 'editado' | 'borrado' | 'renombrado';
  insertions: number | null;
  deletions: number | null;
  at: number | null;
}

export interface PreviewInfo {
  available: boolean;
  reason?: 'solo-planificacion' | 'sin-proyecto' | 'sin-pagina';
  entry?: string | null;
  pages?: string[];
  // Página de prueba automática: el proyecto no tiene HTML propio y el servidor sirve una que carga
  // sus módulos de verdad. `modules` son los que se prueban y `imports`, los paquetes que el
  // proyecto importa por nombre y se resolvieron solos para que el navegador pueda cargarlos.
  synthetic?: boolean;
  modules?: string[];
  imports?: string[];
  files?: number;
  sample?: string[];
  branch?: string | null;
  head?: string | null;
  changes?: PreviewChange[];
  changed?: { files: number; insertions: number; deletions: number };
  lastWrite?: { path: string; at: number | null } | null;
  // El código del archivo más reciente, para cuando no hay página que cargar: sin él, un proyecto
  // de módulos (una librería, un shader) solo podía enseñar nombres de archivo.
  source?: {
    path: string;
    code: string | null;
    reason?: string;
    lines: number | null;
    shown?: number;
    truncated?: boolean;
    bytes?: number;
    at?: number;
  } | null;
}

// Qué se lleva el humano de la sala: código (repo ajeno o proyecto nuevo) o solo un plan. El
// panel lo dice desde el primer momento, en vez de dejar que se adivine por qué no hay archivos.
export interface Delivery {
  kind: 'code' | 'plan';
  reason: 'repo' | 'proyecto-nuevo' | 'solo-planificacion' | 'sin-proyecto';
  planOnly: boolean;
  branch: string | null;
  warning?: string | null;
}

export interface Room {
  health?: { state: 'blocked' | 'stalled'; reason: string; action: string } | null;
  storage?: { saved: boolean; failedAt: number | null };
  code: string;
  delivery?: Delivery;
  title: string;
  createdAt: number;
  closedAt: number | null;
  task: string;
  context: string;
  criteria: string;
  template: string | null;
  tournament: { id: string; round: number; angle: string; angleLabel: string } | null;
  status: 'lobby' | 'debate' | 'closed';
  phase: Phase;
  // Fase ciega en curso: la vista pública no trae los planes ajenos (se revelan al cerrarse).
  blind: boolean;
  // Mejora recursiva: ronda en curso (1 = el debate inicial) y por qué paró, si paró.
  rounds: number;
  recursion?: {
    rounds: number;
    cap: number;
    history: { round: number; integrated: number; findings?: number; head: string | null; at: number; next: boolean }[];
    stop: { round: number; cap: number; integrated: number; reason: string; head?: string | null; agents?: number } | null;
  };
  phaseLabel: string;
  macro: Macro;
  deadlineInSec: number;
  live: LiveState;
  rules: {
    language: string; tone: string; minAgents: number; expectedAgents: number;      consensusThreshold: number; requireDiversity: boolean; tokenBudgetPerAgent: number;
      phaseMs: Record<string, number>; maxDurationMs: number;
      extraordinary?: boolean; planOnly?: boolean; phaseAdvanceMode?: 'timed' | 'agreement';
    };
  roster: RosterAgent[];
  phaseAgreement?: { revision: string; ready: string[]; pending: string[]; total: number } | null;
  vacancies: { agentId: string; name: string; role: string | null; roleLabel: string; reason: string; since: number }[];
  agenda: AgendaPoint[];
  consensus: {
    global: number; method: 'agenda' | 'ballots'; threshold: number;
    agreed: number; discussing: number; open: number; pending: number; total: number;
    stanceSource: Record<string, { kind: string; proposalId?: string }>;
    stages?: ConsensusStage[];
  };
  dissent: DissentProtection;
  // Contraste de ejes en vivo (vacío si el encuadre no dejó ejes que contrastar).
  contrast?: ContrastView;
  proposals: Proposal[];
  critiques: Critique[];
  objections: Objection[];
  checks: Check[];
  verification: Verification | null;
  ruleProposals: RuleProposal[];
  tiebreakArgs: { byName: string; target: string; targetTitle: string; text: string }[];
  ballots?: Record<string, string[]>;
  cost?: CostSnapshot;
  repo: RepoSummary | null;
  findings: Finding[];
  work: WorkState | null;
  log: LogEntry[];
  result?: RoomResult;
}

export interface HallRoom {
  code: string;
  title: string;
  task: string;
  template: string | null;
  status: 'lobby' | 'debate' | 'closed';
  phase: Phase;
  macro: Phase | 'closed';
  agents: number;
  activeAgents: number;
  agenda: number;
  createdAt: number;
  durationMin: number;
  outcome: string | null;
  consensus: number | null;
  checksum: string | null;
  tournament: { id: string; round: number; angleLabel: string } | null;
  repo: { source: string; kind: 'path' | 'url'; branch: string; files: number; verify: string | null } | null;
  work: { items: number; integrated: number; open: number; head: string | null } | null;
}

export interface Template {
  id: string;
  name: string;
  icon?: string;
  order?: number;
  roomTitle?: string;
  description?: string;
  task: string;
  context?: string;
  criteria?: string;
  agenda?: { label: string; options?: string[]; weight?: number }[];
  settings?: Record<string, unknown>;
}

// El catálogo de lentes es solo informativo: nada se asigna por rotación.

export interface AgentMeta {
  name: string;
  model: string;
  harness: string;
  role: string | null;
  capabilities: string[];
  lastSeenAt: number;
  status: AgentStatus;
  online: boolean;
  rooms: string[];
  debates: number;
  // Si ahora mismo tiene trabajo en la mano en alguna sala (reclamado o en revisión).
  holding?: { itemId: string; title: string; state: 'working' | 'reviewing' } | null;
}

export interface LensInfo { label: string; lens: Record<string, string>; caps: string[] }

// Las lentes son opcionales: el agente puede declarar una o ninguna. No se asignan.
export interface Meta {
  phases: Phase[];
  lenses: Record<string, LensInfo>;
  roles?: Record<string, LensInfo>; // alias heredado de lenses
  capabilities: Record<string, string>;
}

export interface SnippetBundle {
  harness: string;
  label: string;
  mode: string;
  files: { name: string; language: string; content: string }[];
  prompt: string;
  curl: string;
}

export interface JoinResponse {
  ok: true;
  agentId: string;
  token: string;
  role: string | null; // lente declarada por el agente; null si no declaró ninguna
  seat: string;
  replacement: boolean;
  phase: string;
  briefing: string;
  turn: { action: string; message?: string; agenda?: { id: string; label: string }[] };
}

export interface CreateRoomResponse {
  ok: true;
  code: string;
  url: string;
  agentUrl: string;
  panelUrl: string;
  adminToken: string;
  bootstrap: string;
  joinPrompt: string;
  agenda: { id: string; label: string; options: string[] }[];
  repo: RepoSummary | null;
  repoWarning: string | null;
  delivery: Delivery;
}

export interface Tournament {
  id: string;
  title: string;
  status: 'open' | 'final' | 'closed';
  createdAt: number;
  finalCode: string | null;
  winner: string | null;
  consensus?: number | null;
  rooms: {
    code: string; angle: string; angleLabel: string; round: number;
    status: string; phase: Phase | null; agents: number;
    consensus: number | null; winner: string | null; title: string | null; outcome: string | null;
  }[];
}

// Configuración portable de una sala: todo lo necesario para verla entera en un sitio y
// volver a abrir un debate con ella. Sin tokens y apuntando al proyecto original.
export interface RoomConfigRepo {
  path: string | null;
  kind: string | null;
  ref: string | null;
  verify: string;
  pushTo: string | null;
}

export interface RoomConfig {
  from: string;
  title: string;
  task: string;
  context: string;
  criteria: string;
  language: string;
  tone: string;
  template: string | null;
  agenda: { label: string; options: string[]; weight?: number }[];
  settings: {
    language?: string; tone?: string; minAgents?: number; expectedAgents?: number;
    consensusThreshold?: number; maxDurationMs?: number; tokenBudgetPerAgent?: number;
    extraordinary?: boolean; requireDiversity?: boolean; offlineMs?: number; planOnly?: boolean; phaseAdvanceMode?: 'timed' | 'agreement';
    repo?: { verifyCommand?: string; maxWorkItems?: number; reviewRounds?: number; recursionRounds?: number; claimIdleMs?: number };
  };
  repo: RoomConfigRepo | null;
  roster: { name: string; harness: string; model: string }[];
  origin: {
    at: number | null; status: string | null; phase: string | null;
    outcome: string | null; checksum: string | null; agents: number;
  };
  tournament: { id: string | null; angle: string | null; round: number | null } | null;
  prompt: string;
  joinPrompt: string;
}
