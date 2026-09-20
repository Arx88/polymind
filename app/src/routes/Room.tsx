// Sala en vivo: arte del salón, stepper de fases, puntos de decisión, propuestas,
// transcripción, agentes, invitación y resultado congelado.

import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { useRoomLive, useTick } from '../lib/live';
import { adminOf, navigate } from '../lib/router';
import { PHASE_DESCRIPTION, clock, pct0, plural, timeAgo } from '../lib/format';
import { Icon } from '../components/Icons';
import { Avatar } from '../components/Avatar';
import { Card, Empty, ErrorBox, Loading, Note, Tag } from '../components/Ui';
import { ConsensusRing, MacroStepper, PhaseChecklist, PhaseLine, StageConsensus } from '../components/ConsensusRing';
import { PointsTable } from '../components/PointsTable';
import { AgentRoster } from '../components/AgentRoster';
import { LiveDebate } from '../components/LiveDebate';
import { Transcript } from '../components/Transcript';
import { InviteBox, RunnerHint } from '../components/InviteBox';
import { WorkBoard } from '../components/WorkBoard';
import { PreviewPanel } from '../components/PreviewPanel';
import { DissentPanel } from '../components/DissentPanel';
import { FrameAudit } from '../components/FrameAudit';
import { ResultCard } from '../components/ResultCard';
import { LongText } from '../components/LongText';
import { RoomArt, seatsFromRoom } from '../components/RoomArt';
import { RoomConfigCard } from '../components/RoomConfigCard';
import type { Room as RoomType } from '../lib/types';

type RoomTab = 'live' | 'debate' | 'dissent' | 'work' | 'preview' | 'log' | 'config';

export function Room({ code, onChanged }: { code: string; onChanged: () => void }) {
  const { room, error, connected, updatedAt, refresh } = useRoomLive(code || null);
  const [adminToken, setAdminToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showAll, setShowAll] = useState(false);
  // La sala se ve por secciones en lugar de una columna infinita: con el trabajo y el
  // debate juntos, lo importante quedaba a diez pantallas de scroll.
  const [tab, setTab] = useState<RoomTab>('live');

  // Cambiar de sala vuelve a la sección principal: la pestaña que estabas mirando en la
  // sala anterior no dice nada de esta (el estado del componente sobrevive a la navegación).
  useEffect(() => { setAdminToken(adminOf(code)); setTab('live'); }, [code]);

  // Al entrar en la etapa de trabajo, se abre esa sección (es lo que está pasando); al
  // cerrarse la sala, el resultado congelado manda y se vuelve a la vista principal.
  const macro = room?.macro;
  const status = room?.status;
  useEffect(() => {
    if (status === 'closed') setTab('live');
    else if (macro === 'work') setTab('work');
  }, [macro, status]);

  const deadline = room && room.status !== 'closed' ? room.deadlineInSec : 0;
  const [stamp, setStamp] = useState(Date.now());
  useEffect(() => { setStamp(Date.now()); }, [room?.deadlineInSec, room?.phase, room?.status]);
  useTick(deadline > 0);
  const remaining = Math.max(0, deadline - Math.floor((Date.now() - stamp) / 1000));

  const seats = useMemo(() => seatsFromRoom(room?.roster || []), [room?.roster]);

  async function admin(op: string) {
    if (!adminToken || !room) return;
    setBusy(true);
    try {
      await api.admin(room.code, { adminToken, op });
      onChanged();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'No se pudo ejecutar la acción');
    } finally {
      setBusy(false);
    }
  }

  if (error) return <ErrorBox message={error} />;
  if (!room) return <Loading label="Cargando la sala…" />;

  const live = room.status === 'debate';
  const statusChip = room.status === 'closed'
    ? <span className="liveChip lobby"><Icon name="doc" size={13} /> {room.result?.outcome === 'decided' ? 'Sala cerrada · ver entrega' : room.result?.outcome || 'cerrado'}</span>
    : room.status === 'lobby'
      ? <span className="liveChip lobby"><i className="dot" /> Lobby · esperando agentes</span>
      : room.health ? <span className="liveChip lobby">{room.health.state === 'blocked' ? 'Bloqueado · requiere atención' : 'Sin avance comprobado'}</span>
        : <span className="liveChip"><i className="dot live" /> En vivo {connected ? '· SSE' : '· sondeo'}</span>;

  const unresolved = room.agenda.filter(p => p.status !== 'agreed');
  // El tablero del trabajo, para no confundir «plan acordado» con «entrega hecha».
  const workItems = room.work?.items || [];
  const workTotal = workItems.length;
  const workDone = workItems.filter(i => i.status === 'integrated').length;
  const workHot = workItems.filter(i => ['claimed', 'in-review', 'verifying'].includes(i.status)).length;
  const workFree = workItems.filter(i => i.status === 'open').length;
  const workOpen = workTotal > 0 && workDone < workTotal;
  const proposals = [...room.proposals].sort((a, b) => a.createdAt - b.createdAt);
  // Con mejora recursiva, la sala acumula propuestas de varias rondas: aquí manda la ronda
  // abierta (las anteriores ya se decidieron y su trabajo está integrado o aplazado).
  const ronda = room.rounds || 1;
  const proposalsDeRonda = proposals.filter(p => (p.round ?? 1) === ronda);
  const proposalsAnteriores = proposals.length - proposalsDeRonda.length;
  const visibleProposals = showAll ? proposalsDeRonda : proposalsDeRonda.slice(0, 6);

  return (
    <div className="wide">
      {room.storage?.failedAt && <ErrorBox title="Hay progreso pendiente de guardar" message="El servidor no pudo escribir en disco. No reinicies Polymind: los últimos cambios pueden estar solo en memoria. Comprueba espacio y permisos; el servidor reintentará guardar." />}
      <div className="pageHead">
        <button className="backBtn" onClick={() => navigate('#/')} title="Volver"><Icon name="back" size={18} /></button>
        <div style={{ minWidth: 0 }}>
          <h1>{room.title || room.task.slice(0, 70)}</h1>
          <p className="tiny roomMeta" style={{ marginTop: 6 }}>
            sala <b>{room.code}</b> · {plural(room.roster.length, 'agente')} · {room.template || 'sin plantilla'} · creada {timeAgo(room.createdAt)}
            {room.tournament ? ` · torneo ${room.tournament.angleLabel} (ronda ${room.tournament.round})` : ''}
            {room.rounds > 1 ? ` · mejora recursiva, ronda ${room.rounds}` : ''}
          </p>
          {room.repo && (
            <div className="row wrap" style={{ marginTop: 8, gap: 8 }}>
              {/* Qué entrega esta sala, dicho arriba del todo: código (con su rama) o solo un plan. */}
              {room.delivery?.reason === 'proyecto-nuevo' && (
                <Tag tone="green"><Icon name="sparkle" size={13} /> proyecto nuevo: los agentes escriben el código</Tag>
              )}
              <Tag tone="purple"><Icon name="branch" size={13} /> {room.repo.branch}</Tag>
              <Tag tone="grey">{plural(room.repo.files, 'archivo')} {room.delivery?.reason === 'proyecto-nuevo' ? 'ya en el proyecto' : 'del repo'}</Tag>
              {room.repo.verify && <Tag tone="blue">verifica <span className="mono">{room.repo.verify}</span></Tag>}
              {room.work && (
                <Tag tone={room.work.stats.integrated ? 'green' : 'grey'}>
                  {room.work.stats.integrated}/{room.work.stats.items} mejoras integradas
                </Tag>
              )}
              {/* Mejora recursiva: en qué ronda va y por qué paró, si paró. */}
              {room.rounds > 1 && <Tag tone="blue">ronda {room.rounds}{room.recursion?.cap ? `/${1 + room.recursion.cap}` : ''}</Tag>}
              {room.recursion?.stop && (
                <Tag tone={room.recursion.stop.reason === 'auditoria-sin-hallazgos' ? 'green' : 'grey'}>
                  {room.recursion.stop.reason === 'auditoria-sin-hallazgos'
                    ? 'sin más que mejorar'
                    : room.recursion.stop.reason === 'tope-de-rondas' ? 'tope de rondas' : 'ronda sin mejoras'}
                </Tag>
              )}
            </div>
          )}
          {/* Solo planificación: sin proyecto, el panel lo dice en vez de dejar un hueco. */}
          {!room.repo && room.delivery?.kind === 'plan' && (
            <div className="row wrap" style={{ marginTop: 8, gap: 8 }}>
              <Tag tone="grey">solo planificación: el resultado es un plan, sin código</Tag>
            </div>
          )}
        </div>
        <span className="spacer" />
        {/* En debate el reloj vive en el panel de directo: aquí solo estorbaría. */}
        {remaining > 0 && room.status !== 'debate' && <span className="timer tiny mono"><Icon name="clock" size={14} /> {clock(remaining)} · {room.phaseLabel}</span>}
        {statusChip}
      </div>

      <RoomTabs
        tab={tab}
        onTab={setTab}
        room={room}
        unresolved={unresolvedCount(room)}
      />
      {room.phaseAgreement && <div className="phaseAgreementBanner" role="status">
        <b>Avance por acuerdo · sin reloj</b>
        <span>{room.phaseAgreement.ready.length} de {room.phaseAgreement.total} agentes listos para pasar.</span>
        {room.phaseAgreement.pending.length > 0 && <small>Pendientes: {room.phaseAgreement.pending.map(id => room.roster.find(a => a.id === id)?.name || id).join(', ')}.</small>}
        <small>Confirmar el avance no significa aprobar todas las ideas. El disenso se conserva; un aporte nuevo reinicia las confirmaciones.</small>
      </div>}

      <div className="layoutTwo roomLayout">
        <div className="col">
      {tab === 'live' && room.status === 'closed' && room.result?.outcome === 'decided' && room.result.winner && (
        <section className="resultHero" aria-label="Resumen del resultado congelado">
          <div className="resultHeroCopy">
            
            <h2>Resultado <strong>congelado</strong></h2>
            <p>{plural(room.roster.length, 'agente')} · Distintas perspectivas, mejores decisiones</p>
            <div className="resultHeroStats">
              <Tag tone={room.result.consensus.global >= room.result.consensus.threshold ? 'green' : 'amber'}>
                {pct0(room.result.consensus.global)} consenso
              </Tag>
              <Tag tone="blue">{room.result.consensus.agreed} de {room.result.consensus.total} puntos acordados</Tag>
              <Tag tone="purple">{room.result.checks.length} comprobaciones</Tag>
              {/* Lo primero que busca quien abre una sala cerrada: ¿hay código o solo un plan? */}
              {room.result.delivery && (
                <Tag tone={room.result.delivery.kind === 'code' ? 'green' : 'grey'}>
                  {room.result.delivery.kind === 'code'
                    ? `código entregado: rama ${room.result.delivery.branch}`
                    : 'solo planificación: sin código'}
                </Tag>
              )}
              <Tag tone="grey">~{room.result.cost?.estTokens ?? 0} tokens</Tag>
            </div>
          </div>
          <div className="resultHeroArt" aria-hidden="true">
            <img src="/images/polymind-minds.png" alt="" />
          </div>
        </section>
      )}

      {/* Reutilizar la sala no puede ser un secreto: al terminar un debate lo que se quiere es
          volver a convocarlo con esta misma configuración o releer el prompt entero. Antes solo
          existían dentro de la última pestaña y, con la barra de pestañas desbordada y sin
          scrollbar, quedaban fuera de la pantalla. Aquí están lo primero que se ve al abrir una
          sala cerrada, también cuando cerró sin resultado decidido (una sala caducada igual
          tiene tarea, agenda y reglas que merece la pena recuperar). */}
      {room.status === 'closed' && tab === 'live' && (
        <div className="row wrap" style={{ gap: 8, margin: '0 0 14px' }}>
          <button className="btnPrimary" onClick={() => navigate(`#/nuevo?from=${room.code}`)}>
            <Icon name="refresh" size={15} /> Reabrir con esta configuración
          </button>
          <button className="btnGhost" onClick={() => setTab('config')}>
            <Icon name="doc" size={15} /> Ver el prompt completo
          </button>
          <span className="tiny" style={{ alignSelf: 'center' }}>
            Hereda tarea, agenda, reglas y repo de {room.code}; los agentes entran de nuevo.
          </span>
        </div>
      )}

          {room.status === 'closed' && tab === 'live' && <ResultCard room={room} compactHeader />}

          {/* En debate manda el directo: quién actúa, qué falta y qué acaba de pasar.
              El arte del salón se queda para el lobby y para el resultado. */}
          <div className="tabsPanel" hidden={tab !== 'live' || room.status === 'closed'}>
          {room.status === 'debate'
            ? <LiveDebate room={room} connected={connected} onOpenDissent={() => setTab('dissent')} />
            : (
              <Card pad={false}>
                <div className="cardBody" style={{ paddingBottom: 0 }}>
                  <RoomArt seats={seats} height={250} />
                </div>
                <div className="cardBody">
                  <MacroStepper room={room} />
                  <PhaseLine room={room} />
                  <p className="tiny" style={{ marginTop: 12 }}>
                    <b style={{ color: 'var(--ink)' }}>{room.phaseLabel}:</b> {PHASE_DESCRIPTION[room.phase]}
                  </p>
                  {room.status === 'lobby' && (
                    <div className="row wrap" style={{ marginTop: 12 }}>
                      <Tag tone={room.live.waitingFor ? 'amber' : 'green'}>
                        {room.live.waitingFor
                          ? `faltan ${room.live.waitingFor === 1 ? 'un agente' : `${room.live.waitingFor} agentes`} para arrancar`
                          : 'ya se puede arrancar'}
                      </Tag>
                      <span className="tiny">
                        {room.roster.length} dentro · mínimo {room.rules.minAgents} · el arranque es automático
                      </span>
                    </div>
                  )}
                </div>
              </Card>
            )}

          </div>

          {/* Con repo, el tablero de trabajo va antes que nada: es donde se ve si las
              mejoras aprobadas se están ejecutando de verdad. */}
          {/* El disenso tiene su propia sección: es lo que un porcentaje de consenso
              esconde, y el usuario tiene que poder verlo sin buscarlo en el acta. */}
          <div className="tabsPanel" hidden={tab !== 'dissent'}>
            <DissentPanel dissent={room.dissent} />
            {/* El encuadre, auditado: quién trajo los ejes, cuáles entraron tarde y cuáles se
                impugnaron. Es la otra mitad del mismo problema: el consenso puede esconder
                disenso, y un marco lo puede imponer quien habló primero. */}
            <FrameAudit audit={room.result?.agendaReview} contrast={room.contrast} />
          </div>

          <div className="tabsPanel" hidden={tab !== 'work'}>
          {/* Y aquí dentro, en vivo: mientras la sala trabaja, esto es lo que se está construyendo.
              Va antes del tablero a propósito — el tablero cuenta lo que pasó, esto enseña lo que
              está pasando. */}
          {room.repo && (
            <PreviewPanel room={room} compact active={tab === 'work'} onOpenFull={() => setTab('preview')} />
          )}
          {(room.repo || room.work || room.findings.length > 0) && (
            <WorkBoard room={room} adminToken={adminToken} />
          )}
          </div>

          {/* Vista previa: el proyecto de la sala, servido en solo lectura y recargándose solo.
              Es la pestaña donde se ve lo que se está construyendo, no solo lo que se cuenta. */}
          <div className="tabsPanel" hidden={tab !== 'preview'}>
            <PreviewPanel room={room} active={tab === 'preview'} />
          </div>

          <div className="tabsPanel" hidden={tab !== 'debate'}>
          <Card
            title="Puntos clave del debate"
            action={<span className="tiny">{room.consensus.agreed}/{room.consensus.total || 0} acordados</span>}
          >
            <PointsTable points={room.agenda} />
          </Card>

          <Card
            title={`Propuestas (${proposalsDeRonda.filter(p => !p.conceded).length} vivas${ronda > 1 ? ` · ronda ${ronda}` : ''})`}
            action={proposals.length > 6
              ? <button className="linkBtn" onClick={() => setShowAll(v => !v)}>{showAll ? 'Ver menos' : 'Ver todas'}</button>
              : null}
          >
            {proposalsAnteriores > 0 && (
              <p className="tiny" style={{ marginBottom: 10 }}>
                Esta es la ronda {ronda}: arriba están las propuestas de esta ronda. Las de rondas
                anteriores ({proposalsAnteriores}) ya se decidieron y no vuelven a la votación.
              </p>
            )}
            {visibleProposals.length === 0 ? (
              <Empty icon="doc" title="Todavía no hay propuestas" hint="Se presentan a ciegas en la primera fase del debate." />
            ) : (
              <div className="stack">
                {visibleProposals.map(proposal => (
                  <ProposalCard
                    key={proposal.id}
                    proposal={proposal}
                    room={room}
                    isWinner={room.result?.winner?.id === proposal.id}
                  />
                ))}
              </div>
            )}
          </Card>

          </div>

          <div className="tabsPanel" hidden={tab !== 'log'}>
          <Card title="Registro completo" action={<span className="tiny">{plural(room.log.length, 'evento')}</span>}>
            <Transcript log={room.log} roster={room.roster} />
          </Card>
          </div>

          <div className="tabsPanel" hidden={tab !== 'config'}>
            <RoomConfigCard code={room.code} adminToken={adminToken} />
          </div>

          <div className="tabsPanel" hidden={tab !== 'debate'}>
          {(room.checks.length > 0 || room.verification) && (
            <Card title="Verificación independiente">
              {room.verification && (
                <div className="row wrap" style={{ marginBottom: 12 }}>
                  <Tag tone={room.verification.verdict === 'pass' ? 'green' : 'red'}>veredicto {room.verification.verdict}</Tag>
                  <Tag tone="blue">por {room.verification.byName}</Tag>
                  {room.verification.selfVerified && <Tag tone="amber">autoverificación</Tag>}
                  {room.verification.repaired && <Tag tone="amber">reparado después</Tag>}
                </div>
              )}
              {room.verification?.findings.map((finding, i) => (
                <div className="agentRow" key={i}>
                  <Tag tone={finding.severity === 'high' ? 'red' : 'amber'}>{finding.severity}</Tag>
                  <div className="who"><small style={{ whiteSpace: 'normal' }}>{finding.text}</small></div>
                </div>
              ))}
              {room.checks.map(check => (
                <div className="checkItem" key={check.id}>
                  <span className="ic"><Icon name="check" size={13} strokeWidth={3} /></span>
                  <div>
                    <b>{check.claim}</b>
                    <div className="tiny">Comprobar: {check.method || '—'} · Esperado: {check.expectation || '—'} · por {check.byName}</div>
                  </div>
                </div>
              ))}
              {!room.checks.length && !room.verification?.findings.length && (
                <p className="tiny">La verificación aún no ha producido comprobaciones.</p>
              )}
            </Card>
          )}

          </div>

          <div className="tabsPanel" hidden={tab !== 'debate'}>
          {(room.objections.length > 0 || room.critiques.length > 0) && (
            <Card title="Críticas y vetos">
              {room.objections.map(objection => (
                <div className="agentRow" key={objection.id}>
                  <Tag tone={objection.severity === 'blocker' ? 'red' : 'amber'}>{objection.severity}</Tag>
                  <div className="who">
                    <b>{objection.byName}</b>
                    <small style={{ whiteSpace: 'normal' }}>{objection.text}</small>
                  </div>
                  {objection.addressed && <Tag tone="green">atendido</Tag>}
                </div>
              ))}
              {room.critiques.map(critique => (
                <div className="msg" key={critique.id}>
                  <Avatar name={critique.authorName} harness={room.roster.find(a => a.name === critique.authorName)?.harness ?? null} size={34} />
                  <div style={{ minWidth: 0 }}>
                    <div className="who">
                      <b>{critique.authorName}</b>
                      <Tag tone="red">crítica</Tag>
                      <span className="tiny">a «{critique.targetTitle}»</span>
                    </div>
                    {critique.steelman && <p className="tiny">Steelman: {critique.steelman}</p>}
                    {(critique.improvements || []).map(idea => <div className="sharedImprovement" key={idea.id}>
                      <b>Mejora compartida</b><p>{idea.change}</p>
                      {idea.why && <small>Por qué: {idea.why}</small>}
                      {idea.validation && <small>Cómo comprobarla: {idea.validation}</small>}
                    </div>)}
                    {critique.objections.map((objection, i) => (
                      <div key={i} style={{ marginTop: 4 }}>
                        <Tag tone={objection.severity === 'high' ? 'red' : objection.severity === 'med' ? 'amber' : 'grey'}>{objection.type}</Tag>{' '}
                        <LongText text={objection.text} lines={6} label="la objeción" />
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </Card>
          )}
          </div>
        </div>

        <div className="col">
          <Card title="Consenso actual">
            <div className="ringWrap">
              <ConsensusRing
                value={room.consensus.global}
                caption="Consenso global"
                sub={room.consensus.method === 'agenda' ? `${room.consensus.total} puntos` : 'por votos'}
              />
              <div style={{ minWidth: 0 }}>
                <div className="row wrap">
                  <Tag tone={room.consensus.global >= room.consensus.threshold ? 'green' : 'blue'}>
                    umbral {pct0(room.consensus.threshold)}
                  </Tag>
                  <Tag tone="green">{room.consensus.agreed} acordados</Tag>
                </div>
                <p className="tiny" style={{ marginTop: 8 }}>
                  {room.consensus.method === 'agenda'
                    ? 'El consenso se calcula contando las posiciones de cada agente en cada punto de la agenda.'
                    : 'Sin agenda: el consenso se calcula sobre el primer puesto de los votos.'}
                </p>
              </div>
            </div>
            {room.consensus.stages?.length ? (
              <div style={{ marginTop: 16 }}>
                <div className="row" style={{ marginBottom: 6 }}>
                  <b style={{ fontSize: 13 }}>Consenso por etapa</b>
                  <span className="spacer" />
                  <span className="tiny">cada etapa, medida al cerrarse</span>
                </div>
                <StageConsensus stages={room.consensus.stages} threshold={room.consensus.threshold} />
              </div>
            ) : null}
            {room.status !== 'closed' && <div style={{ marginTop: 14 }}><PhaseChecklist room={room} /></div>}
            <div style={{ marginTop: 14 }}>
              <Note>
                {room.status === 'lobby'
                  ? <><b>El debate aún no ha empezado</b><div>Cuando entren los agentes mínimos, el encuadre abre la agenda de decisión.</div></>
                  : room.consensus.total === 0
                    ? <><b>Sin agenda de decisión</b><div>Esta sala no declara puntos; el consenso se mide sobre los votos.</div></>
                    : <>
                      <b>{unresolved.length ? `${plural(unresolved.length, 'punto')} sin cerrar` : 'Todos los puntos acordados'}</b>
                      <div>
                        {unresolved.length
                          ? unresolved.slice(0, 4).map(p => `${p.label} (${pct0(p.share)})`).join(' · ')
                          : 'El plan puede cerrarse con acuerdo pleno sobre la agenda.'}
                      </div>
                      {/* Un plan acordado no es un trabajo terminado, y el panel no puede dejar
                          creer lo contrario: aquí se dice, con los números del tablero, que la
                          entrega sigue en curso. */}
                      {workOpen && (
                        <div style={{ marginTop: 6 }}>
                          <b>El trabajo sigue abierto</b>: {workDone}/{workTotal} tareas integradas
                          {workHot ? `, ${workHot} en la mano de un agente` : ''}{workFree ? `, ${workFree} libres` : ''}.
                          {' '}Lo acordado es el plan; lo que se entrega es el código de la pestaña Trabajo.
                        </div>
                      )}
                    </>}
              </Note>
            </div>
            {room.status === 'closed' && tab === 'live' && <button className="resultDebateAction" onClick={() => setTab('debate')}>Ver debate completo <Icon name="arrow" size={19} /></button>}
          </Card>

          <Card
            title={`Agentes (${room.roster.length})`}
            action={room.vacancies.length ? <Tag tone="amber">{plural(room.vacancies.length, 'vacante')}</Tag> : null}
          >
            <AgentRoster agents={room.roster} showTokens />
            {room.vacancies.map(vacancy => (
              <Note key={vacancy.agentId}>
                <b>Asiento vacante de {vacancy.name}</b>
                <div>Libre desde {timeAgo(vacancy.since)}. Cualquier harness puede ocuparlo pegando la URL de la sala.</div>
              </Note>
            ))}
          </Card>

          {room.status !== 'closed' && <Card title="Invitar agentes">
            <InviteBox code={room.code} />
            <div style={{ marginTop: 12 }}>
              <RunnerHint code={room.code} />
            </div>
          </Card>

          }
          <Card title="Reglas y coste">
            <div className="stack" style={{ gap: 8 }}>
              <RuleRow label="Avance" value={room.rules.phaseAdvanceMode === 'agreement' ? 'Por acuerdo · sin reloj' : `Con plazos · ${Math.round(room.rules.maxDurationMs / 60000)} min de debate`} />
              <RuleRow label="Fase actual" value={`${room.phaseLabel} · ${room.phaseAgreement ? 'sin reloj' : clock(remaining)}`} />
              <RuleRow label="Umbral de consenso" value={pct0(room.rules.consensusThreshold)} />
              <RuleRow label="Idioma y tono" value={`${room.rules.language} · ${room.rules.tone}`} />
              <RuleRow label="Exigir enfoques distintos" value={room.rules.requireDiversity ? 'sí' : 'no'} />
              <RuleRow label="Presupuesto por agente" value={room.rules.tokenBudgetPerAgent ? `~${room.rules.tokenBudgetPerAgent} tok` : 'sin tope'} />
              {room.repo && <RuleRow label="Rama de trabajo" value={room.work?.branch || room.repo.branch} />}
              {room.repo && <RuleRow label="Verificación del repo" value={room.repo.verify || 'sin comando declarado'} />}
              <RuleRow label="Trabajo extraordinario" value={room.rules.extraordinary ? 'sí · se revisa todo al final' : 'no'} />
              {room.work && <RuleRow label="Trabajo sobre el repo" value={`${room.work.stats.integrated}/${room.work.stats.items} integradas · +${room.work.stats.insertions}/-${room.work.stats.deletions}`} />}
            </div>
            {room.ruleProposals.length > 0 && (
              <div style={{ marginTop: 14 }}>
                <b style={{ fontSize: 13 }}>Cambios de reglas negociados</b>
                {room.ruleProposals.map(rule => (
                  <div className="agentRow" key={rule.id}>
                    <div className="who">
                      <b>{rule.text}</b>
                      <small>propuesto por {rule.byName}</small>
                    </div>
                    <Tag tone={rule.applied ? 'green' : 'amber'}>
                      {rule.applied ? 'aplicado' : plural(rule.ratifications.length, 'ratificación', 'ratificaciones')}
                    </Tag>
                  </div>
                ))}
              </div>
            )}
            {room.cost && (
              <div style={{ marginTop: 14 }}>
                <b style={{ fontSize: 13 }}>Coste medido</b>
                {room.cost.perAgent.map(agent => (
                  <div className="agentRow" key={agent.id}>
                    <div className="who">
                      <b>{agent.name}</b>
                      <small>{agent.harness || 'harness sin declarar'} · ~{agent.estTokens} tokens</small>
                    </div>
                  </div>
                ))}
                <p className="tiny" style={{ marginTop: 8 }}>
                  Media {room.cost.avgPerAgent} tokens por agente · {room.cost.total} en total (estimación por caracteres servidos y enviados).
                </p>
              </div>
            )}
          </Card>

          {adminToken && room.status !== 'closed' && (
            <Card title="Administración">
              <div className="row wrap">
                <button className="btnGhost btnMini" disabled={busy} onClick={() => admin('advance')}>Forzar avance de fase</button>
                <button className="btnGhost btnMini" disabled={busy} onClick={() => admin('close')}>Cerrar y congelar</button>
                {room.repo?.verify && (
                  <button className="btnGhost btnMini" disabled={busy} onClick={() => admin('run-baseline')}>Re-medir línea base</button>
                )}
              </div>
              <p className="tiny" style={{ marginTop: 10 }}>Acciones de emergencia cuando un agente se queda colgado.</p>
            </Card>
          )}
        </div>
      </div>
      <div className="footer">
        sala {room.code} · {live ? 'en vivo' : room.status} · última actualización {updatedAt ? timeAgo(updatedAt) : '—'}
        {' · '}
        <button className="linkBtn" onClick={() => refresh()}>Actualizar ahora</button>
      </div>
    </div>
  );
}

const unresolvedCount = (room: RoomType) => room.agenda.filter(p => p.status !== 'agreed').length;

// Secciones de la sala, con lo que está pasando en cada una: lo abierto en el debate, lo
// integrado en el trabajo y lo que se está revisando ahora. Un número, para saber dónde mirar.
function RoomTabs({ tab, onTab, room, unresolved }: { tab: RoomTab; onTab: (next: RoomTab) => void; room: RoomType; unresolved: number }) {
  const work = room.work;
  const review = work?.review;
  const reviewPending = review?.pending?.length || 0;
  // Ejes que el contraste añadió o dejó en pie: es lo que la sección enseña además del disenso.
  const axes = (room.contrast?.challenged?.length || 0) + (room.contrast?.merged?.length || 0);
  const items: { id: RoomTab; label: string; badge: string | null; tone: 'grey' | 'green' | 'amber' | 'blue' }[] = [
    { id: 'live', label: room.status === 'closed' ? 'Resultado' : 'En vivo', badge: room.status === 'closed' ? null : room.status === 'lobby' ? 'lobby' : room.phaseLabel, tone: 'blue' },
    {
      id: 'debate',
      label: 'Debate',
      badge: room.consensus.total ? `${room.consensus.agreed}/${room.consensus.total} puntos` : null,
      tone: unresolved > 0 ? 'amber' : 'green',
    },
    {
      id: 'dissent',
      label: 'Disenso',
      // El contraste de ejes vive en esta sección y no siempre trae disenso medido: si hay
      // ejes impugnados o fusionados, un «sin datos» es sencillamente falso. Se cuenta.
      badge: room.dissent?.measured
        ? (room.dissent.contestedCount ? plural(room.dissent.contestedCount, 'punto') : 'unánime')
        : axes > 0 ? plural(axes, 'eje') : room.contrast?.open ? 'contraste en curso' : 'sin datos',
      tone: room.dissent?.contestedCount || axes > 0 ? 'amber' : room.contrast?.open ? 'blue' : 'grey',
    },
    {
      id: 'work',
      label: 'Trabajo',
      badge: work ? `${work.stats.integrated}/${work.stats.items}` : (room.repo ? 'sin tareas' : 'sin repo'),
      tone: reviewPending > 0 ? 'amber' : work?.stats.integrated ? 'green' : 'grey',
    },
    {
      id: 'preview',
      label: 'Vista previa',
      // «en vivo» solo cuando de verdad hay algo corriendo: si no, la pestaña se anuncia sola.
      badge: work && work.stats.open > 0 ? 'en vivo' : null,
      tone: 'blue',
    },
    { id: 'config', label: 'Configuración', badge: 'prompt', tone: 'blue' },
    { id: 'log', label: 'Registro', badge: `${room.log.length}`, tone: 'grey' },
  ];
  return (
    <nav className="roomTabs">
      {items
        .filter(item => item.id !== 'work' || room.repo || room.work || room.findings.length > 0)
        // La vista previa solo tiene sentido cuando la sala entrega código: sin proyecto (o con
        // «solo planificación») no hay árbol de trabajo que enseñar.
        .filter(item => item.id !== 'preview' || (!!room.repo && room.delivery?.kind !== 'plan'))
        .map(item => (
        <button
          key={item.id}
          className={`roomTab${tab === item.id ? ' on' : ''}`}
          onClick={() => onTab(item.id)}
          aria-current={tab === item.id}
        >
          {item.label}
          {item.badge && <span className={`tabBadge ${item.tone}`}>{item.badge}</span>}
        </button>
      ))}
    </nav>
  );
}

function RuleRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="row" style={{ fontSize: 13.5 }}>
      <span className="muted">{label}</span>
      <span className="spacer" />
      <b>{value}</b>
    </div>
  );
}

function ProposalCard({ proposal, room, isWinner }: { proposal: RoomType['proposals'][number]; room: RoomType; isWinner: boolean }) {
  const critiques = room.critiques.filter(c => c.target === proposal.id);
  const pointLabel = (id: string) => room.agenda.find(p => p.id === id)?.label || id;
  const choiceLabel = (pointId: string, choiceId: string) =>
    room.agenda.find(p => p.id === pointId)?.options.find(o => o.id === choiceId)?.label || choiceId;

  return (
    <article className={`propCard${isWinner ? ' win' : ''}${proposal.conceded ? ' out' : ''}`}>
      <div className="head">
        <Avatar name={proposal.authorName} harness={room.roster.find(a => a.name === proposal.authorName)?.harness ?? null} size={34} dim={proposal.conceded} />
        <div style={{ minWidth: 0 }}>
          <h4>{proposal.title}</h4>
          <div className="tiny">
            {proposal.authorName} · v{proposal.version}
            {proposal.history ? ` · ${plural(proposal.history, 'revisión', 'revisiones')}` : ''}
            {proposal.endorsements.length ? ` · respaldada por ${proposal.endorsements.join(', ')}` : ''}
          </div>
        </div>
        <span className="spacer" />
        {isWinner && <Tag tone="green">ganadora</Tag>}
        {proposal.conceded && <Tag tone="grey">retirada</Tag>}
        {critiques.length > 0 && <Tag tone="red">{plural(critiques.length, 'crítica')}</Tag>}
      </div>

      {proposal.approach && <p className="tiny"><b>Enfoque:</b> {proposal.approach}</p>}
      {/* Fase ciega: el servidor no publica los planes ajenos hasta que se revelan, así que
          aquí no hay nada que enseñar — y decirlo es mejor que un hueco en blanco. */}
      {room.blind ? (
        <Note>
          <b>Encuadre ciego</b>
          <div>Los planes se revelan juntos al cerrarse la fase de propuestas: hasta entonces solo se publica el título, el autor y la esencia.</div>
        </Note>
      ) : (
        <LongText text={proposal.plan} lines={18} label="el plan" />
      )}

      {Object.keys(proposal.positions).length > 0 && (
        <div className="kv">
          {Object.entries(proposal.positions).map(([pointId, choiceId]) => (
            <Tag key={pointId} tone="blue">{pointLabel(pointId)}: {choiceLabel(pointId, choiceId)}</Tag>
          ))}
        </div>
      )}

      <details>
        <summary>Detalles del autor ({[proposal.premortem && 'pre-mortem', proposal.risks && 'riesgos', proposal.assumptions && 'supuestos'].filter(Boolean).length})</summary>
        {proposal.premortem && <p className="tiny" style={{ marginTop: 8 }}><b>Pre-mortem:</b> {proposal.premortem}</p>}
        {proposal.risks && <p className="tiny"><b>Riesgos declarados:</b> {proposal.risks}</p>}
        {proposal.assumptions && <p className="tiny"><b>Supuestos:</b> {proposal.assumptions}</p>}
        {proposal.revisionNote && <p className="tiny"><b>Última revisión:</b> {proposal.revisionNote}</p>}
        {proposal.concedeReason && <p className="tiny"><b>Motivo de la retirada:</b> {proposal.concedeReason}</p>}
      </details>
    </article>
  );
}
