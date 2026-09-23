// Debate live: la vista que responde en dos segundos a «¿qué está pasando?».
//
// Regla de diseño: un solo foco. Primero la frase de estado (quién está actuando
// ahora, con nombres), después el mecanismo (por qué existe esta fase), después el
// reparto de turnos agrupado por estado, y al final el detalle.
//
// Nada de bloques repetidos: el mismo texto cinco veces no informa. Cada estado es
// una etiqueta corta o un glifo, y quien no tiene turno no ocupa espacio de nadie.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Avatar } from './Avatar';
import { Icon } from './Icons';
import { clock, harnessColor, plural } from '../lib/format';
import type { LiveMember, Phase, Room } from '../lib/types';

type Tone = 'blue' | 'purple' | 'red' | 'amber' | 'green' | 'grey';

// Cada fase tiene color propio: al cambiar el acento, se entiende que el mecanismo cambió.
const PHASE_TONE: Record<Phase, Tone> = {
  lobby: 'grey',
  frame: 'blue',
  contrast: 'blue',
  audit: 'blue',
  work: 'green',
  review: 'purple',
  proposal: 'purple',
  critique: 'red',
  revise: 'purple',
  vote: 'blue',
  tiebreak: 'red',
  objection: 'red',
  repair: 'amber',
  synthesis: 'green',
  verify: 'green',
  closed: 'grey',
};

// Qué hace un agente mientras tiene turno, conjugado para la frase de estado.
const PHASE_DOING: Record<Phase, string> = {
  lobby: 'entrando a la sala',
  frame: 'proponiendo puntos y reglas',
  contrast: 'contrastando los ejes de la agenda',
  audit: 'auditando el repositorio',
  work: 'trabajando sobre el repo',
  review: 'revisando el trabajo integrado',
  proposal: 'escribiendo su propuesta a ciegas',
  critique: 'atacando la propuesta que le asignaron',
  revise: 'respondiendo a las críticas',
  vote: 'emitiendo su voto secreto',
  tiebreak: 'alegando por su finalista',
  objection: 'decidiendo si vetan el plan',
  repair: 'reparando el plan vetado',
  synthesis: 'fusionando el plan con las objeciones',
  verify: 'convirtiendo el plan en comprobaciones',
  closed: 'cerrando',
};

// La frase describe la fase real; la marca visual compacta identifica su tipo de trabajo.
const PHASE_LABEL: Record<Phase, string> = {
  lobby: 'Reuniendo al equipo',
  frame: 'Definiendo el problema',
  contrast: 'Contrastando los ejes',
  audit: 'Inspeccionando el proyecto',
  proposal: 'Construyendo propuestas',
  critique: 'Poniendo ideas a prueba',
  revise: 'Mejorando propuestas',
  vote: 'Decidiendo entre opciones',
  tiebreak: 'Resolviendo el empate',
  objection: 'Examinando objeciones',
  repair: 'Reparando el plan',
  synthesis: 'Uniendo lo mejor',
  verify: 'Definiendo comprobaciones',
  work: 'Construyendo el resultado',
  review: 'Revisando lo construido',
  closed: 'Trabajo terminado',
};
const PHASE_STAGE: Record<Phase, number> = {
  lobby: 0, frame: 0, contrast: 0, audit: 0,
  proposal: 1, critique: 1, revise: 1, vote: 1, tiebreak: 1, objection: 1, repair: 1,
  synthesis: 2, verify: 2, work: 3, review: 4, closed: 4,
};
// Las etapas usan ilustraciones de objetos; los retratos quedan reservados para agentes.
const STAGE_TRACK: ReadonlyArray<{ label: string; art: string }> = [
  { label: 'Preparar', art: 'prepare' },
  { label: 'Debatir', art: 'debate' },
  { label: 'Cerrar el plan', art: 'plan' },
  { label: 'Construir', art: 'build' },
  { label: 'Revisar', art: 'review' },
];

function StageMark({ index }: { index: number }) {
  return <span className="stageMark" aria-hidden="true">
    <img src={`/images/stages/${STAGE_TRACK[index].art}-v2.png`} alt="" width="48" height="48" />
  </span>;
}

const EVENT_TONE: Record<string, Tone> = {
  proposal: 'blue',
  point: 'blue',
  contrast: 'blue',
  rule: 'blue',
  finding: 'blue',
  work: 'green',
  patch: 'green',
  review: 'purple',
  critique: 'red',
  objection: 'red',
  revision: 'purple',
  argument: 'purple',
  concede: 'amber',
  vote: 'grey',
  synthesis: 'green',
  verify: 'green',
  // Una posición que se mueve sin citar evidencia es disenso en movimiento, no un aviso menor.
  drift: 'amber',
  pass: 'grey',
  join: 'grey',
  timeout: 'amber',
  absent: 'amber',
  vacancy: 'amber',
  budget: 'amber',
  closed: 'green',
};

const EVENT_LABEL: Record<string, string> = {
  join: 'entrada',
  proposal: 'propuesta',
  point: 'agenda',
  contrast: 'contraste',
  rule: 'reglas',
  finding: 'hallazgo',
  work: 'trabajo',
  patch: 'parche',
  review: 'revisión',
  critique: 'crítica',
  revision: 'revisión',
  concede: 'retirada',
  vote: 'voto',
  drift: 'disenso',
  argument: 'alegato',
  objection: 'veto',
  synthesis: 'síntesis',
  verify: 'verificación',
  pass: 'silencio',
  timeout: 'plazo',
  absent: 'ausencia',
  vacancy: 'vacante',
  budget: 'presupuesto',
  closed: 'cierre',
};

// Nombre corto de lo que se entrega en cada fase: cabe en una píldora junto al nombre.
const PHASE_ACTION_SHORT: Record<Phase, string> = {
  lobby: 'listo para arrancar',
  frame: 'puntos y reglas',
  contrast: 'contraste de ejes',
  audit: 'hallazgos',
  work: 'trabajo en el repo',
  review: 'revisión del trabajo',
  proposal: 'propuesta',
  critique: 'crítica',
  revise: 'respuesta',
  vote: 'voto secreto',
  tiebreak: 'alegato',
  objection: 'decisión de veto',
  repair: 'reparación',
  synthesis: 'síntesis',
  verify: 'verificación',
  closed: '',
};

// El servidor añade el número de piezas que faltan («crítica asignada (2)»);
// la píldora conserva el número pero usa el nombre corto.
function shortAction(phase: Phase, action: string | null): string | null {
  const base = PHASE_ACTION_SHORT[phase];
  if (!base) return null;
  const count = action?.match(/\((\d+)\)/);
  return count ? `${base} (${count[1]})` : base;
}

const STATE_LABEL: Record<LiveMember['state'] | 'absent', string> = {
  pending: 'turno abierto',
  delivered: 'ya entregó',
  free: 'sin turno en esta fase',
  absent: 'ausente',
};

export function LiveDebate({ room, connected, onOpenDissent }: { room: Room; connected: boolean; onOpenDissent?: () => void }) {
  const live = room.live;
  const [now, setNow] = useState(Date.now());
  const [stamp, setStamp] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  // El plazo se recalcula cuando el servidor publica fase, plazo o estado nuevos.
  useEffect(() => { setStamp(Date.now()); }, [live.deadlineInSec, live.phase, room.status]);

  const secondsLeft = Math.max(0, live.deadlineInSec - Math.floor((now - stamp) / 1000));
  const phaseMs = Number(room.rules.phaseMs?.[room.phase] || 0);
  const phaseShare = phaseMs > 0 ? Math.min(1, Math.max(0, secondsLeft / (phaseMs / 1000))) : 0;
  const urgent = !room.phaseAgreement && room.status === 'debate' && live.pending > 0 && secondsLeft <= 60;

  const members = live.members;
  const acting = members.filter(m => m.status !== 'absent' && m.state === 'pending');
  const delivered = members.filter(m => m.status !== 'absent' && m.state === 'delivered');
  const idle = members.filter(m => m.status !== 'absent' && m.state === 'free');
  const absent = members.filter(m => m.status === 'absent');

  const headline = useMemo(() => {
    if (room.health) return room.health.reason;
    if (room.status === 'lobby') {
      return live.waitingFor
        ? `Faltan ${live.waitingFor} ${live.waitingFor === 1 ? 'agente' : 'agentes'} para arrancar el debate`
        : 'Ya están los mínimos reunidos: el debate arranca solo';
    }
    if (acting.length) {
      return `Turno abierto para ${nameList(acting.map(m => m.name))}: ${PHASE_DOING[room.phase]}`;
    }
    if (delivered.length) {
      return `Todos los turnos de ${live.phaseLabel.toLowerCase()} están entregados`;
    }
    return `Nadie tiene turno abierto en ${live.phaseLabel.toLowerCase()}`;
  }, [room.status, room.phase, room.health, live.phaseLabel, live.waitingFor, acting, delivered.length]);

  // Del más nuevo al más viejo. Las entradas se agrupan aparte: cinco «se une al
  // debate» seguidos son ruido, no información.
  const feed = useMemo(
    () => room.log.filter(e => e.kind !== 'room' && e.kind !== 'join').slice(-24).reverse().slice(0, 6),
    [room.log],
  );
  const joins = useMemo(() => room.log.filter(e => e.kind === 'join').length, [room.log]);
  const newestId = feed[0]?.id ?? null;
  const recentByAgent = useMemo(() => {
    const recent = new Map<string, string>();
    for (const entry of [...room.log].reverse()) {
      if (entry.agentId && !recent.has(entry.agentId) && !['join', 'pass', 'phase', 'timeout', 'absent', 'vacancy', 'budget'].includes(entry.kind)) {
        recent.set(entry.agentId, entry.text);
      }
    }
    return recent;
  }, [room.log]);
  const flashRef = useRef<number | null>(null);
  const isFresh = newestId !== null && flashRef.current !== newestId && Date.now() - (feed[0]?.ts || 0) < 10000;
  useEffect(() => { flashRef.current = newestId; }, [newestId]);

  if (room.status === 'closed') return null;
  const tone = PHASE_TONE[room.phase] || 'grey';
  // Ejes que el contraste dejó impugnados o fusionó: se cuentan tal como los publica el
  // servidor, sin inventar un resumen propio.
  const challenged = room.contrast?.challenged?.length || 0;
  const merged = room.contrast?.merged?.length || 0;
  const axes = challenged + merged;
  const total = members.filter(m => m.status !== 'absent').length;
  const stageIndex = PHASE_STAGE[room.phase];

  return (
    <section className={`livePanel tone-${tone}`}>
      <header className="liveHead">
        <span className="liveDot" />
        <b className="liveTitle">Trabajo en directo</b>
        <span className="livePhase">{live.phaseLabel}</span>
        <span className="spacer" />
        {/* El plazo se amplía cuando alguien tiene el turno entregado: sin decirlo, el reloj
            parecería reiniciarse solo. */}
        {room.status === 'debate' && live.phaseExtensions > 0 && (
          <span className="liveTimer extended" title="La fase no se cierra encima de quien está trabajando: el plazo se ha ampliado mientras un agente termina su movimiento">
            ampliada ×{live.phaseExtensions}
          </span>
        )}
        {room.status === 'debate' && live.deadlineInSec > 0 && (
          <span className={`liveTimer${urgent ? ' urgent' : ''}`}>
            cierra en <b className="mono">{clock(secondsLeft)}</b>
          </span>
        )}
        <span className={`liveSource${connected ? '' : ' slow'}`} title={connected ? 'Eventos enviados por el servidor' : 'Sin flujo SSE: sondeo cada 3 s'}>
          {connected ? 'en directo' : 'sondeo 3 s'}
        </span>
      </header>
      {room.status === 'debate' && phaseMs > 0 && (
        <div className="liveTimebar"><i style={{ width: `${Math.round(phaseShare * 100)}%` }} className={urgent ? 'urgent' : ''} /></div>
      )}

      {/* 1 · El foco: qué está pasando, con nombres, y por qué existe esta fase. */}
      <div className="liveNow">
        <div className="liveScene">
          <div className="liveSceneMain">
            <div className="liveNowText">
              <span className="liveSceneEyebrow">{room.health ? 'Requiere atención' : `Ahora · ${PHASE_LABEL[room.phase]}`}</span>
              <p className="liveNowLine" aria-live="polite">{headline}</p>
              {(room.health?.action || live.mechanism) && <p className="liveWhy">{room.health?.action || live.mechanism}</p>}
            </div>
          </div>
          {urgent && (
            <p className="liveAlert">
              {/* Si la fase ya se ha ampliado, el reloj NO se lleva por delante a quien tiene
                  el turno: decirlo al revés sería mentir sobre lo que va a pasar. */}
              {live.phaseExtensions > 0
                ? `Cierra en ${clock(secondsLeft)}, pero la fase espera a ${live.who.map(w => w.name).join(', ') || 'quien tiene el turno'}: ${live.pending === 1 ? 'está' : 'están'} a mitad de su movimiento y no se cierra encima.`
                : `Cierra en ${clock(secondsLeft)} y ${live.pending} ${live.pending === 1 ? 'sigue' : 'siguen'} sin entregar: al expirar, la fase avanza sin su aporte.`}
            </p>
          )}
        </div>
        <div className="liveGauge">
          <div className="liveGaugeNums">
            <b>{live.delivered}</b>
            <span className="of">/ {live.expected}</span>
          </div>
          <div className="liveGaugeLabel">
            {live.expected === 0
              ? room.health ? 'sin turnos activos · requiere atención' : 'sin aportes pendientes en esta fase'
              : live.expected === 1 ? 'aporte entregado en esta fase' : 'aportes entregados en esta fase'}
          </div>
          {live.expected < total && (
            <div className="liveGaugeSub">
              {live.expected} de {total} agentes {live.expected === 1 ? 'tiene' : 'tienen'} algo que entregar; el resto espera.
            </div>
          )}
          <div className="livePips">
          {members.map(m => {
            const state = m.status === 'absent' ? 'absent' : m.state;
            return <i key={m.id} className={state} title={`${m.name} · ${STATE_LABEL[state]}`} />;
          })}
          </div>
          {live.next && <div className="liveNext">al cerrar → <b>{live.next}</b></div>}
        </div>
      </div>
      <div className={`liveJourney${room.repo ? '' : ' short'}`} aria-label="Etapas del trabajo">
        {STAGE_TRACK.slice(0, room.repo ? 5 : 3).map((stage, index) => {
          const current = stageIndex === index;
          return <div className={`journeyStep${current ? ' current' : ''}${index < stageIndex ? ' past' : ''}`}
            key={stage.label} aria-current={current ? 'step' : undefined}>
            <StageMark index={index} />
            <span className="journeyCopy"><b>{stage.label}</b><small>{current ? 'Ahora' : index < stageIndex ? 'Hecho' : 'Después'}</small></span>
          </div>;
        })}
      </div>

      {/* 1b · Una sola línea para el disenso: el detalle vive en su pestaña, aquí solo
          importa saber que el consenso de la cabecera no cuenta toda la historia. */}
      {(live.dissent?.contestedCount > 0 || live.dissent?.convergenceWithoutEvidence?.count > 0 || live.dissent?.vote?.collapsed) && (
        <button className="liveDissent" onClick={onOpenDissent}>
          <Icon name="scale" size={14} />
          <b>Disenso protegido</b>
          <span className="liveDissentText">
            {live.dissent.contestedCount > 0 && `${plural(live.dissent.contestedCount, 'punto sigue', 'puntos siguen')} con minoría real`}
            {live.dissent.contestedCount > 0 && live.dissent.convergenceWithoutEvidence.count > 0 && ' · '}
            {live.dissent.convergenceWithoutEvidence.count > 0 && `${plural(live.dissent.convergenceWithoutEvidence.count, 'posición se movió', 'posiciones se movieron')} sin evidencia`}
            {live.dissent.vote?.collapsed && `${live.dissent.contestedCount > 0 || live.dissent.convergenceWithoutEvidence.count > 0 ? ' · ' : ''}propuestas casi idénticas en la votación`}
          </span>
          <span className="spacer" />
          <span className="liveDissentGo">ver</span>
        </button>
      )}

      {/* 1c · El contraste de ejes: durante esa fase es EL asunto de la sala, así que no puede
          quedarse detrás de una pestaña que dice «sin datos». Una línea, con la cifra real. */}
      {(axes > 0) && (
        <button className="liveDissent" onClick={onOpenDissent}>
          <Icon name="scale" size={14} />
          <b>Contraste de ejes</b>
          <span className="liveDissentText">
            {challenged > 0 && `${plural(challenged, 'eje impugnado sigue', 'ejes impugnados siguen')} en pie`}
            {challenged > 0 && merged > 0 && ' · '}
            {merged > 0 && `${plural(merged, 'eje fusionado', 'ejes fusionados')}`}
          </span>
          <span className="spacer" />
          <span className="liveDissentGo">ver</span>
        </button>
      )}

      {/* 2 · Reparto de turnos, agrupado: quien actúa primero, quien ya terminó después. */}
      <div className="liveTurns">
        <div className="turnsHead">
          <b>Quién hace qué</b>
          <span className="spacer" />
          <span className="tiny">
            {joins > 0 && `${joins} en la sala · `}
            {acting.length} con turno abierto
          </span>
        </div>
        {room.status === 'lobby'
          ? <TurnGroup tone="grey" label="en la sala" members={members} phase={room.phase} room={room} recentByAgent={recentByAgent} />
          : (
            <>
              {acting.length > 0 && <TurnGroup tone="blue" label="turno abierto" members={acting} phase={room.phase} room={room} recentByAgent={recentByAgent} busy />}
              {delivered.length > 0 && <TurnGroup tone="green" label="ya entregaron" members={delivered} phase={room.phase} room={room} recentByAgent={recentByAgent} />}
              {idle.length > 0 && <TurnGroup tone="grey" label="esperando su turno" members={idle} phase={room.phase} room={room} recentByAgent={recentByAgent} />}
              {absent.length > 0 && <TurnGroup tone="amber" label="ausentes" members={absent} phase={room.phase} room={room} recentByAgent={recentByAgent} />}
            </>
          )}
      </div>

      {/* 3 · El detalle: qué acaba de pasar, sin cortar palabras a la mitad. */}
      <div className="liveFeed">
        <div className="liveFeedHead">
          <b>Lo último que ha pasado</b>
          <span className="spacer" />
          <span className="tiny">últimos {feed.length} de {room.log.length} eventos</span>
        </div>
        {feed.length === 0 ? (
          <p className="tiny">Aún no hay movimientos: el debate está arrancando.</p>
        ) : feed.map((entry, i) => (
          entry.kind === 'phase'
            ? (
              <div className="feedPhase" key={entry.id}>
                <span className="feedPhaseLine" />
                <span className="feedPhaseText">{shortPhase(entry.text)}</span>
                <span className="feedWhen tiny">{ago(entry.ts, now)}</span>
              </div>
            )
            : (
              <div className={`feedRow${i === 0 && isFresh ? ' fresh' : ''}`} key={entry.id}>
                <i className="feedDot" style={{ background: dotColor(entry.kind, entry.by && harnessOf(room, entry.by)) }} />
                <span className={`feedBadge ${EVENT_TONE[entry.kind] || 'grey'}`}>{EVENT_LABEL[entry.kind] || entry.kind}</span>
                <span className="feedText" title={entry.text}>{entry.text}</span>
                <span className="feedWhen tiny">{ago(entry.ts, now)}</span>
              </div>
            )
        ))}
      </div>
    </section>
  );
}

function TurnGroup({ label, members, tone, phase, room, recentByAgent, busy }: {
  label: string; members: LiveMember[]; tone: Tone; phase: Phase; room: Room;
  recentByAgent: Map<string, string>; busy?: boolean;
}) {
  return (
    <div className="turnGroup">
      <span className={`turnLabel ${tone}`}>
        {busy && <i className="spinner" />}
        {label}
        <b>{members.length}</b>
      </span>
      <div className="turnFolks">
        {members.map(member => {
          const holding = room.roster.find(agent => agent.id === member.id)?.holding;
          const last = recentByAgent.get(member.id);
          const state = member.status === 'absent' ? 'absent' : member.state;
          return <div
            className={`folk ${state}${member.online ? '' : ' offline'}`}
            key={member.id}
          >
            <div className="folkPortrait">
              <Avatar name={member.name} harness={member.harness} size={58} dim={state === 'absent'} />
              {state === 'pending' && member.online && <i className="folkBusy" aria-hidden="true" />}
            </div>
            <div className="folkInfo">
              <b>{member.name}</b>
              <small>{member.harness || 'Harness sin declarar'}</small>
              <span className="folkStatus">{STATE_LABEL[state]}{!member.online && state !== 'absent' ? ' · sin señal reciente' : ''}</span>
            </div>
            {(holding?.title || (state === 'pending' && shortAction(phase, member.action))) && (
              <p className="folkFocus"><span>{holding ? 'Tarea asignada' : 'Acción pedida'}</span>{holding?.title || shortAction(phase, member.action)}</p>
            )}
            {last && <p className="folkRecent" title={last}><span>Último aporte</span>{last}</p>}
          </div>;
        })}
      </div>
    </div>
  );
}

const harnessOf = (room: Room, name: string) => room.roster.find(a => a.name === name)?.harness ?? null;

// El punto de color identifica al harness (quien actuó), no el tipo de evento.
function dotColor(kind: string, harness: string | null | undefined): string {
  if (kind === 'timeout' || kind === 'absent' || kind === 'budget' || kind === 'vacancy') return 'var(--amber)';
  return harnessColor(harness);
}

// Los cambios de fase llegan como un párrafo; en la lista solo cabe el titular.
function shortPhase(text: string): string {
  const first = text.split(/(?<=[.;:])\s/)[0] || text;
  const cut = first.replace(/[.;:,]+$/, '').trim();
  return cut.length > 84 ? `${cut.slice(0, 83).trimEnd()}…` : cut;
}

// En español la enumeración no repite «y»: «Ana, Bruno y Ciro», no «Ana y Bruno y Ciro».
function nameList(names: string[]): string {
  if (names.length <= 1) return names[0] || '';
  if (names.length === 2) return `${names[0]} y ${names[1]}`;
  if (names.length === 3) return `${names[0]}, ${names[1]} y ${names[2]}`;
  return `${names[0]}, ${names[1]} y ${names.length - 2} más`;
}

function ago(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 5) return 'ahora';
  if (s < 60) return `hace ${s} s`;
  const m = Math.round(s / 60);
  return m < 60 ? `hace ${m} min` : `hace ${Math.round(m / 60)} h`;
}
