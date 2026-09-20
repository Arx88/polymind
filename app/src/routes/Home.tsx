// Panel de inicio: convocar un debate, ver los recientes y el estado del que
// está en marcha (anillo de consenso real, checklist de fases, agentes vivos).

import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { navigate, rememberAdmin } from '../lib/router';
import { useRoomLive } from '../lib/live';
import { OUTCOME_LABEL, OUTCOME_TONE, PHASE_LABEL, pct0, plural, timeAgo } from '../lib/format';
import type { HallRoom, Room, Template } from '../lib/types';
import { Icon, type IconName } from '../components/Icons';
import { Avatar, FaceStack } from '../components/Avatar';
import { Bar, Card, Empty, Note, Tag } from '../components/Ui';
import { ConsensusRing, PhaseChecklist } from '../components/ConsensusRing';


interface Chip {
  label: string;
  icon: IconName;
  template: string;
  prompt: string;
}

const CHIPS: Chip[] = [
  { label: 'Estrategia', icon: 'chart', template: 'estrategia-lanzamiento', prompt: 'Diseña la estrategia de lanzamiento de nuestro producto para los próximos 90 días.' },
  { label: 'Producto', icon: 'layers', template: 'arquitectura-tecnica', prompt: 'Decide la arquitectura y el alcance de la próxima versión del producto.' },
  { label: 'Marketing', icon: 'target', template: 'decision-dificil', prompt: 'Elige el posicionamiento y el mensaje principal para el lanzamiento.' },
  { label: 'Análisis', icon: 'bulb', template: 'analisis-mercado', prompt: 'Analiza el mercado objetivo y prioriza la oportunidad más defendible.' },
  { label: 'Crecimiento', icon: 'rocket', template: 'modelo-negocio', prompt: 'Define el modelo de crecimiento y las métricas que lo validan.' },
  { label: 'Otros', icon: 'scale', template: 'decision-dificil', prompt: 'Debate esta decisión y elige la mejor opción con criterio explícito.' },
];

const CARD_ICON: Record<string, { icon: IconName; color: string; soft: string }> = {
  'estrategia-lanzamiento': { icon: 'rocket', color: '#16a34a', soft: '#ecfdf3' },
  'arquitectura-tecnica': { icon: 'layers', color: '#7c3aed', soft: '#f5f3ff' },
  'analisis-mercado': { icon: 'chart', color: '#7c3aed', soft: '#f5f3ff' },
  'modelo-negocio': { icon: 'coins', color: '#d97706', soft: '#fef7e6' },
  'revision-codigo': { icon: 'code', color: '#0891b2', soft: '#ecfeff' },
  'decision-dificil': { icon: 'scale', color: '#2563eb', soft: '#eff6ff' },
};

export function Home({ rooms, onRefresh }: { rooms: HallRoom[]; onRefresh: () => void }) {
  const [task, setTask] = useState('');
  const [template, setTemplate] = useState('estrategia-lanzamiento');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const live = useMemo(
    () => rooms.find(r => r.status === 'debate') || rooms.find(r => r.status === 'lobby') || null,
    [rooms],
  );
  const liveRoom = useRoomLive(live?.code ?? null);
  const rosters = useRoomRosters(rooms.slice(0, 6).map(r => r.code));
  const openRooms = rooms.filter(room => room.status !== 'closed').length;
  const frozenResults = rooms.filter(room => room.status === 'closed').length;

  async function create() {
    if (task.trim().length < 10) {
      setError('Describe la tarea con al menos 10 caracteres.');
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const out = await api.createRoom({ task: task.trim(), template });
      rememberAdmin(out.code, out.adminToken);
      onRefresh();
      navigate(`#/d/${out.code}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo crear la sala');
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="wide">
      <div className="layoutTwo">
        <div className="col">
          <div className="hero">
            <div className="heroCopy">
              <div className="heroKicker"><Icon name="sparkle" size={15} /> Deliberación multiagente, trazable de principio a fin</div>
              <h1>Distintas mentes.<br />Mejores planes.</h1>
              <p>
                Los agentes proponen a ciegas, se critican con asignación forzada, votan en secreto y
                otro agente verifica el plan antes de cerrarlo. Tú solo pegas una URL en cada agente.
              </p>
              <div className="heroSignals" aria-label="Estado de Polymind">
                <span><i className={`dot${openRooms ? ' live' : ''}`} /> {openRooms ? plural(openRooms, 'debate abierto', 'debates abiertos') : 'Listo para debatir'}</span>
                <span><Icon name="shield" size={14} /> {plural(frozenResults, 'resultado congelado', 'resultados congelados')}</span>
                <span><Icon name="check" size={14} /> Verificación independiente</span>
              </div>
            </div>
            <img className="homeMinds" src="/images/polymind-minds.png" alt="Cinco perspectivas colaborando en una decisión" width="1536" height="1024" />
            <div style={{ padding: '0 26px 24px' }}>
              <div className="promptBox">
                <span className="spark"><Icon name="sparkle" size={20} /></span>
                <input
                  aria-label="Tema del nuevo debate"
                  placeholder="¿Sobre qué quieres debatir?"
                  value={task}
                  onChange={e => setTask(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') void create(); }}
                />
                <button className="goBtn" onClick={create} disabled={creating} title="Crear la sala y empezar">
                  {creating ? <Icon name="refresh" size={17} /> : <Icon name="arrow" size={18} />}
                </button>
              </div>
              <div className="chips" style={{ marginTop: 14 }}>
                {CHIPS.map(chip => (
                  <button
                    key={chip.label}
                    className={`chip${template === chip.template && task === chip.prompt ? ' on' : ''}`}
                    onClick={() => {
                      setTemplate(chip.template);
                      setTask(chip.prompt);
                    }}
                  >
                    <Icon name={chip.icon} size={16} />
                    {chip.label}
                  </button>
                ))}
              </div>
              {error && <p className="tiny" style={{ color: 'var(--red)', marginTop: 10 }}>{error}</p>}
              <p className="tiny" style={{ marginTop: 10 }}>
                Se creará una sala con la plantilla «{template}». Podrás ajustar agenda, agentes y reglas antes de invitar.
              </p>
            </div>
          </div>

          <div className="sectionTitle">
            <h2>Debates recientes</h2>
            <span className="spacer" />
            <a className="linkBtn" href="#/resultados">Ver todos <Icon name="arrow" size={15} /></a>
          </div>

          {rooms.length === 0 ? (
            <Card><Empty icon="chat" title="Todavía no hay debates" hint="Escribe una tarea arriba y crea el primero." /></Card>
          ) : (
            <div className="debateGrid">
              {rooms.slice(0, 6).map(room => (
                <DebateCard key={room.code} room={room} roster={rosters[room.code] || []} />
              ))}
            </div>
          )}

          <div className="banner">
            <div>
              <h3>Del debate al consenso.<br />De las ideas al impacto.</h3>
              <p>Cuando distintas perspectivas se alinean, las mejores soluciones se hacen realidad: plan final, comprobaciones y disenso registrado.</p>
            </div>
            <span className="spacer" />
            <a className="btnWhite" href="#/nuevo">
              Iniciar nuevo debate <Icon name="arrow" size={16} />
            </a>
          </div>
        </div>

        <div className="col">
          <Card
            title="Consenso del debate"
            action={<Icon name="info" size={16} />}
          >
            {liveRoom.room ? (
              <>
                <div className="ringWrap">
                  <ConsensusRing
                    value={liveRoom.room.consensus.global}
                    caption="Consenso"
                    sub={liveRoom.room.consensus.method === 'agenda' ? `por ${liveRoom.room.consensus.total} puntos` : 'por votos'}
                  />
                  <div style={{ minWidth: 0 }}>
                    <div className="row">
                      <span className="dot live" />
                      <b style={{ fontSize: 13.5 }}>{liveRoom.room.phaseLabel}</b>
                    </div>
                    <p className="tiny" style={{ marginTop: 6 }}>
                      {liveRoom.room.title || liveRoom.room.task.slice(0, 90)}
                    </p>
                    <a className="linkBtn" style={{ marginTop: 8 }} href={`#/d/${liveRoom.room.code}`}>
                      Entrar en la sala <Icon name="arrow" size={14} />
                    </a>
                  </div>
                </div>
                <div style={{ marginTop: 16 }}>
                  <PhaseChecklist room={liveRoom.room} />
                </div>
                <div style={{ marginTop: 14 }}>
                  <Note>
                    <b>{plural(liveRoom.room.consensus.agreed, 'acuerdo')} detectado{liveRoom.room.consensus.agreed === 1 ? '' : 's'}</b>
                    <div>
                      {liveRoom.room.consensus.total
                        ? `Quedan ${plural(liveRoom.room.consensus.total - liveRoom.room.consensus.agreed, 'punto')} por cerrar.`
                        : 'El consenso se calcula sobre la votación secreta.'}
                    </div>
                  </Note>
                </div>
              </>
            ) : (
              <Empty icon="chart" title="Ningún debate en curso" hint="Crea una sala para ver aquí el consenso punto por punto." />
            )}
          </Card>

          <Card
            title="Agentes activos"
            action={<a className="linkBtn" href="#/agentes">Ver todos <Icon name="arrow" size={14} /></a>}
          >
            {liveRoom.room?.roster.length ? (
              liveRoom.room.roster.slice(0, 6).map(agent => (
                <div className="agentRow" key={agent.id}>
                  <Avatar name={agent.name} harness={agent.harness} size={38} dim={agent.status === 'absent'} />
                  <div className="who">
                    <b>{agent.name}</b>
                    <small>{agent.harness || 'harness sin declarar'}</small>
                  </div>
                  <span className={`st ${agent.status === 'absent' ? 'off' : agent.holding ? 'live' : !agent.online ? 'off' : ''}`}>
                    <i className={`dot ${agent.status === 'absent' ? 'off' : agent.holding ? 'live' : !agent.online ? 'off' : ''}`} />
                    {agent.status === 'absent' ? 'Ausente'
                      : agent.holding ? `Trabajando en ${agent.holding.itemId}`
                        : agent.online ? 'En línea' : 'Desconectado'}
                  </span>
                </div>
              ))
            ) : (
              <Empty icon="users" title="Sin agentes conectados" hint="Pega la URL de la sala en cada agente." />
            )}
          </Card>

          <Card title="Resultado esperado">
            <div className="row" style={{ alignItems: 'flex-start', gap: 12 }}>
              <span style={{ width: 34, height: 34, borderRadius: 11, background: 'var(--blue-soft)', display: 'grid', placeItems: 'center', color: 'var(--blue)', flex: 'none' }}>
                <Icon name="flag" size={18} />
              </span>
              <div>
                <b style={{ fontSize: 13.5 }}>Plan de acción claro y validado por todos los agentes</b>
                <p className="tiny" style={{ marginTop: 4 }}>
                  Con comprobaciones falsables, disenso registrado y checksum para verificar qué versión vio cada agente.
                </p>
              </div>
            </div>
          </Card>
        </div>
      </div>
      <div className="footer">Polymind · el protocolo del debate vive en el servidor · cualquier agente con HTTP o MCP puede participar</div>
    </div>
  );
}

// Avance real por fases para salas abiertas: nunca un porcentaje inventado.
// Están TODAS las fases, incluida la del trabajo sobre el repo: la que faltaba caía en el 0.1
// por defecto, así que una sala con repo retrocedía de 97% a 10% justo al entrar a trabajar.
const PHASE_PROGRESS: Record<string, number> = {
  lobby: 0.05, frame: 0.15, contrast: 0.18, audit: 0.22, proposal: 0.35, critique: 0.5,
  revise: 0.62, vote: 0.72, tiebreak: 0.78, objection: 0.84, repair: 0.88, synthesis: 0.93,
  verify: 0.97, work: 0.98, review: 0.99, closed: 1,
};

function DebateCard({ room, roster }: { room: HallRoom; roster: { name: string; role: string | null }[] }) {
  const icon = CARD_ICON[room.template || ''] || { icon: 'chat' as IconName, color: '#2563eb', soft: '#eff6ff' };
  const isClosed = room.status === 'closed';
  // Una sala cerrada no tiene «avance»: terminó, y la barra se llena. Antes se dibujaba el
  // consenso final en la misma barra, así que un debate que cerró con 97.5% de acuerdo se veía
  // como «98%» en el sitio donde las demás tarjetas enseñan progreso: leído como «quedó a medias».
  // El consenso se dice con su nombre, al lado, y el avance solo habla de salas vivas.
  const progress = isClosed ? 1 : (PHASE_PROGRESS[room.phase] ?? 0.1);
  const consensus = isClosed && room.outcome === 'decided' && room.consensus != null ? room.consensus : null;
  const statusTag = room.status === 'closed'
    ? { tone: OUTCOME_TONE[room.outcome || 'closed'] || 'amber' as const, label: OUTCOME_LABEL[room.outcome || 'closed'] || 'Cerrado' }
    : room.status === 'lobby'
      ? { tone: 'amber' as const, label: 'Lobby' }
      // El nombre de la fase invita a entrar al directo: se ve qué debate está vivo y en qué punto.
      : { tone: 'blue' as const, label: `En vivo · ${PHASE_LABEL[room.phase]}` };

  return (
    <a className="debateCard" href={`#/d/${room.code}`} aria-label={`Abrir debate: ${room.title}`}>
      <div className="head">
        <span className="icon" style={{ background: icon.soft, color: icon.color }}><Icon name={icon.icon} size={20} /></span>
        <div style={{ minWidth: 0 }}>
          <b>{room.title}</b>
          <small>{room.tournament ? `torneo · ${room.tournament.angleLabel}` : 'debate'} · {timeAgo(room.createdAt)}</small>
        </div>
        <span className="spacer" />
        <Tag tone={statusTag.tone}>{statusTag.label}</Tag>
      </div>
      <div className="row" style={{ gap: 10 }}>
        <Bar value={progress} />
        <b
          style={{ fontSize: 13.5, color: 'var(--ink)' }}
          title={isClosed ? 'el debate terminó; el consenso final se mide aparte' : 'avance del debate por fases'}
        >{pct0(progress)}</b>
        {isClosed
          ? <small className="tiny" style={{ whiteSpace: 'nowrap' }}>
            {consensus == null ? 'cerrado' : `consenso ${pct0(consensus)}`}
          </small>
          : <small className="tiny" style={{ whiteSpace: 'nowrap' }}>avance</small>}
      </div>
      <div className="meta">
        {roster.length ? <FaceStack agents={roster} /> : <Avatar name={room.code} harness={room.template || null} size={26} />}
        <span>{plural(room.agents, 'agente')}</span>
        {room.agenda > 0 && <span>· {plural(room.agenda, 'punto')}</span>}
      </div>
      <p>{room.task.length > 130 ? `${room.task.slice(0, 130)}…` : room.task}</p>
    </a>
  );
}

// Carga las plantillas de las salas recientes para poder dibujar sus caras.
function useRoomRosters(codes: string[]) {
  const [map, setMap] = useState<Record<string, { name: string; role: string | null }[]>>({});
  const key = codes.join(',');
  useEffect(() => {
    if (!codes.length) return;
    let alive = true;
    Promise.all(codes.map(code => api.room(code).then(out => [code, out.room.roster.map(a => ({ name: a.name, role: a.role }))] as const).catch(() => [code, []] as const)))
      .then(entries => { if (alive) setMap(Object.fromEntries(entries)); });
    return () => { alive = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return map;
}

export type { Room, Template };
