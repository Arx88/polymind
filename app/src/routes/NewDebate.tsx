// Convocar un debate: tarea, agenda de decisión, reglas y agentes esperados.
// Al crear, se muestra la caja de invitación (lo único que el usuario debe hacer).

import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { plural } from '../lib/format';
import { navigate, rememberAdmin } from '../lib/router';
import type { CreateRoomResponse, Template } from '../lib/types';
import { Icon } from '../components/Icons';
import { Card, CopyButton, ErrorBox, Note, Tag } from '../components/Ui';
import { InviteBox, RunnerHint } from '../components/InviteBox';

interface AgendaDraft {
  label: string;
  options: string;
  weight: number;
}

const EMPTY: AgendaDraft = { label: '', options: '', weight: 1 };

export function NewDebate({ query }: { query: URLSearchParams }) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [step, setStep] = useState(0);
  const previousStep = useRef(step);
  useEffect(() => {
    if (previousStep.current === step) return;
    previousStep.current = step;
    const heading = document.querySelector<HTMLElement>('.workComposer > section:not([hidden]) .cardHead h3');
    if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
    const steps = document.querySelector('.composerSteps');
    if (steps && steps.getBoundingClientRect().top < 100) {
      window.scrollTo({ top: window.scrollY + steps.getBoundingClientRect().top - 100, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    }
  }, [step]);
  const [template, setTemplate] = useState(query.get('template') || '');
  // `?from=CODE`: reabrir con la configuración de otra sala (incluida una ya cerrada).
  const [from, setFrom] = useState(query.get('from') || '');
  const [source, setSource] = useState<{ code: string; title: string } | null>(null);
  const [task, setTask] = useState('');
  const [context, setContext] = useState('');
  const [criteria, setCriteria] = useState('');
  const [agenda, setAgenda] = useState<AgendaDraft[]>([]);
  const [minAgents, setMinAgents] = useState(2);
  const [expectedAgents, setExpectedAgents] = useState(0);
  const [startAsSoonAsReady, setStartAsSoonAsReady] = useState(true);
  const [threshold, setThreshold] = useState(0.75);
  const [tone, setTone] = useState('profesional y constructivo');
  const [language, setLanguage] = useState('es');
  const [durationMin, setDurationMin] = useState(45);
  const [phaseAdvanceMode, setPhaseAdvanceMode] = useState<'timed' | 'agreement'>('timed');
  const [budget, setBudget] = useState(0);
  const [repoPath, setRepoPath] = useState('');
  const [repoRef, setRepoRef] = useState('');
  const [repoVerify, setRepoVerify] = useState('');
  const [repoPushTo, setRepoPushTo] = useState('');
  const [extraordinary, setExtraordinary] = useState(false);
  // Solo planificación: la ÚNICA forma de que una sala acabe sin código. Por defecto se entrega
  // código, y sin repo la sala crea su propio proyecto (antes acababa en un plan sin decirlo).
  const [planOnly, setPlanOnly] = useState(false);
  const [recursion, setRecursion] = useState(0);
  const [tournament, setTournament] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreateRoomResponse | null>(null);
  const [tournamentRooms, setTournamentRooms] = useState<{ code: string; angle: string }[] | null>(null);

  useEffect(() => {
    api.templates().then(out => setTemplates(out.templates)).catch(() => setTemplates([]));
  }, []);

  // Traer la configuración entera de la sala de origen: tarea, contexto, criterios, agenda,
  // reglas y repo. Todo queda editable antes de crear la sala nueva; la original no se toca.
  useEffect(() => {
    if (!from) { setSource(null); return; }
    let alive = true;
    api.roomConfig(from).then(out => {
      if (!alive) return;
      const c = out.config;
      const settings = c.settings || {};
      setSource({ code: c.from, title: c.title || c.task.slice(0, 60) });
      setTask(c.task);
      setContext(c.context || '');
      setCriteria(c.criteria || '');
      setAgenda((c.agenda || []).map(point => ({
        label: point.label,
        options: (point.options || []).join(', '),
        weight: point.weight ?? 1,
      })));
      if (settings.minAgents) setMinAgents(settings.minAgents);
      if (settings.expectedAgents != null) setExpectedAgents(settings.expectedAgents);
      if (settings.startAsSoonAsReady != null) setStartAsSoonAsReady(!!settings.startAsSoonAsReady);
      if (settings.consensusThreshold) setThreshold(settings.consensusThreshold);
      if (settings.tone) setTone(settings.tone);
      if (settings.language) setLanguage(settings.language);
      if (settings.maxDurationMs) setDurationMin(Math.round(settings.maxDurationMs / 60_000));
      setPhaseAdvanceMode(settings.phaseAdvanceMode === 'agreement' ? 'agreement' : 'timed');
      if (settings.tokenBudgetPerAgent != null) setBudget(settings.tokenBudgetPerAgent);
      setExtraordinary(!!settings.extraordinary);
      setPlanOnly(!!settings.planOnly);
      setRecursion(settings.repo?.recursionRounds ?? 0);
      setRepoPath(c.repo?.path || '');
      setRepoRef(c.repo?.ref || '');
      setRepoVerify(c.repo?.verify || '');
      setRepoPushTo(c.repo?.pushTo || '');
    }).catch(err => { if (alive) setError(err.message); });
    return () => { alive = false; };
  }, [from]);

  // Volver al formulario en blanco sin salir de la ruta (la sala de origen sigue disponible
  // en su pestaña: esto no la borra ni la modifica).
  function startFresh() {
    setFrom('');
    setSource(null);
    setTask('');
    setContext('');
    setCriteria('');
    setAgenda([]);
    setRepoPath('');
    setRepoRef('');
    setRepoVerify('');
    setRepoPushTo('');
  }

  useEffect(() => {
    const selected = templates.find(t => t.id === template);
    if (!selected) return;
    if (!task) setTask(selected.task);
    setContext(selected.context || '');
    setCriteria(selected.criteria || '');
    setAgenda((selected.agenda || []).map(point => ({
      label: point.label,
      options: (point.options || []).join(', '),
      weight: point.weight ?? 1,
    })));
    const settings = (selected.settings || {}) as { minAgents?: number; expectedAgents?: number; startAsSoonAsReady?: boolean; consensusThreshold?: number };
    if (settings.minAgents) setMinAgents(settings.minAgents);
    if (settings.expectedAgents != null) setExpectedAgents(settings.expectedAgents);
    if (settings.startAsSoonAsReady != null) setStartAsSoonAsReady(settings.startAsSoonAsReady);
    if (settings.consensusThreshold) setThreshold(settings.consensusThreshold);
  }, [template, templates]); // eslint-disable-line react-hooks/exhaustive-deps

  function buildPayload() {
    const plainAgenda = agenda
      .map(row => ({
        label: row.label.trim(),
        options: row.options.split(',').map(o => o.trim()).filter(Boolean),
        weight: row.weight,
      }))
      .filter(row => row.label.length > 2);
    return {
      task: task.trim(),
      context: context.trim(),
      criteria: criteria.trim(),
      template: template || undefined,
      // Reabrir con la configuración de otra sala: el servidor hereda de ella lo que no se
      // pise aquí.
      from: from || undefined,
      agenda: plainAgenda.length ? plainAgenda : undefined,
      settings: {
        minAgents,
        expectedAgents,
        startAsSoonAsReady,
        consensusThreshold: threshold,
        tone,
        language,
        maxDurationMs: durationMin * 60_000,
        phaseAdvanceMode,
        tokenBudgetPerAgent: budget,
        // Exigir trabajo extraordinario: al terminar, cada mejora integrada se revisa y lo
        // que aún se pueda mejorar vuelve a la cola. Más caro, más exigente.
        extraordinary: !planOnly && extraordinary,
        // Solo planificación: sin trabajo, el resultado es el plan y nada más.
        planOnly,
        // Mejora recursiva: rondas extra de auditoría sobre el código ya mejorado (el tuyo o el
        // que acaban de escribir los agentes en un proyecto nuevo). 0 = cierra al terminar.
        repo: { recursionRounds: planOnly ? 0 : recursion },
      },
      // Repo opcional: si se indica, la sala añade auditoría del código y una fase
      // de trabajo donde los agentes aplican las mejoras que apruebe el debate.
      // Con `from`, dejar la ruta vacía es una decisión explícita («esta vez sin repo»): se
      // envía null para no heredar el del origen por omisión.
      repo: repoPath.trim()
        ? { path: repoPath.trim(), ref: repoRef.trim() || null, verify: repoVerify.trim(), pushTo: repoPushTo.trim() || null }
        : (from ? null : undefined),
    };
  }

  async function create() {
    if (task.trim().length < 10) { setStep(0); setError('Describe el resultado que necesitas con al menos 10 caracteres.'); return; }
    if (!criteria.trim()) { setStep(0); setError('Define al menos un criterio de éxito para que los agentes puedan evaluar su trabajo.'); return; }
    if (expectedAgents > 0 && expectedAgents < minAgents) { setStep(2); setError('Los agentes esperados no pueden ser menos que los mínimos.'); return; }
    setBusy(true);
    setError(null);
    try {
      const payload = buildPayload();
      if (tournament) {
        const out = await api.createTournament({ ...payload, angles: 3 });
        setTournamentRooms(out.rooms);
      } else {
        const out = await api.createRoom(payload);
        rememberAdmin(out.code, out.adminToken);
        setCreated(out);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo crear');
    } finally {
      setBusy(false);
    }
  }

  if (created) {
    return (
      <div className="narrow stack">
        <div className="pageHead">
          <div>
            <h1>Sala creada: {created.code}</h1>
            <p>Pega esta URL en cada agente (o usa el runner). El debate arranca solo cuando estén los mínimos.</p>
          </div>
        </div>
        {created.delivery?.kind === 'plan' && (
          <Card title="Entrega: solo planificación">
            <Note>
              La sala termina en un <b>plan contrastado con checksum</b>. No se escribe ni se toca código:
              así lo pediste, y el informe final lo dirá con ese motivo.
            </Note>
          </Card>
        )}
        {created.repo && (
          <Card title={created.repo.source === 'proyecto nuevo' ? 'Proyecto nuevo de la sala' : 'Repositorio adjunto'}>
            <div className="row wrap" style={{ gap: 8 }}>
              <Tag tone="purple">{created.repo.branch}</Tag>
              <Tag tone="grey">{plural(created.repo.files, 'archivo')}</Tag>
              {created.repo.verify && <Tag tone="blue">verifica <span className="mono">{created.repo.verify}</span></Tag>}
            </div>
            {created.repo.source === 'proyecto nuevo' ? (
              <Note>
                No había repo, así que la sala te ha creado un proyecto vacío con git y lo trabaja en la rama
                <span className="mono"> {created.repo.branch}</span>: el plan que gane se convierte en tareas y
                los agentes escriben los archivos aquí. No se toca nada fuera del espacio de trabajo de la sala.
              </Note>
            ) : (
              <Note>
                El servidor clona el repo en un espacio propio y mide primero la línea base. Los agentes
                auditan el código, el debate aprueba qué se mejora y después trabajan sobre la rama
                <span className="mono"> {created.repo.branch}</span>. Tu repo original no se toca.
              </Note>
            )}
          </Card>
        )}
        {created.repoWarning && (
          <Note>
            <b>No se pudo preparar el proyecto</b>
            <div>{created.repoWarning} La sala sigue en pie, pero sin dónde escribir código: su resultado será un plan.</div>
          </Note>
        )}
        <Card title="Invitar agentes">
          <InviteBox code={created.code} />
        </Card>
        <Card title="O lanza los agentes tú mismo">
          <div className="stack">
            <RunnerHint code={created.code} />
            <CopyButton text={created.joinPrompt} label="Copiar prompt de arranque" ghost />
          </div>
        </Card>
        <div className="row">
          <a className="btnBlue" href={`#/d/${created.code}`}>Entrar en la sala <Icon name="arrow" size={15} /></a>
          <button className="btnGhost" onClick={() => setCreated(null)}>Crear otra</button>
          <a className="btnGhost" href="/manual" target="_blank" rel="noreferrer">Manual de agentes</a>
        </div>
      </div>
    );
  }

  if (tournamentRooms) {
    return (
      <div className="narrow stack">
        <div className="pageHead">
          <div>
            <h1>Torneo creado</h1>
            <p>Tres salas debaten la misma tarea con ángulos distintos; cuando todas cierren, se abre una final con los planes ganadores.</p>
          </div>
        </div>
        <Card title="Salas del torneo">
          <div className="stack">
            {tournamentRooms.map(room => (
              <div className="urlBox" key={room.code}>
                <Tag tone="blue">{room.angle}</Tag>
                <code>#/d/{room.code}</code>
                <a className="linkBtn" href={`#/d/${room.code}`}>Abrir</a>
              </div>
            ))}
          </div>
        </Card>
        <Note>
          Invita a los agentes en cada sala (misma URL de sala) o lanza el runner una vez por sala.
          La final se crea sola: no hay que hacer nada.
        </Note>
        <button className="btnGhost" onClick={() => setTournamentRooms(null)}>Volver al formulario</button>
      </div>
    );
  }

  return (
    <div className="narrow stack workComposer">
      <div className="pageHead">
        <div>
          <span className="eyebrow">DEL OBJETIVO A LA ENTREGA</span>
          <h1>Un gran resultado empieza con un buen objetivo.</h1>
          <p>Define qué necesitas, cómo se comprobará y qué recursos tendrá el equipo.</p>
        </div>
      </div>
      <nav className="composerSteps" aria-label="Pasos para crear un trabajo">
        {['Objetivo', 'Contexto y repositorio', 'Equipo y límites', 'Revisar y crear'].map((label, index) => <button key={label} aria-current={step === index ? 'step' : undefined} onClick={() => { setStep(index); setError(null); }}><span>{index + 1}</span>{label}</button>)}
      </nav>

      <div className="composerPosition" aria-live="polite">
        <span>Paso {step + 1} de 4 · {['Define el objetivo', 'Prepara el contexto', 'Configura el equipo', 'Comprueba y crea'][step]}</span>
        <div className="composerTrack" aria-hidden="true"><i style={{ transform: `scaleX(${(step + 1) / 4})` }} /></div>
      </div>

      {error && <ErrorBox message={error} />}

      {source && (
        <Note>
          Configuración copiada de la sala <b className="mono">{source.code}</b>
          {source.title ? ` — «${source.title}»` : ''}. Puedes cambiar lo que quieras antes de
          crear esta: la sala original no se toca.
          <div className="row wrap" style={{ gap: 6, marginTop: 8 }}>
            <a className="btnGhost btnMini" href={`#/d/${source.code}`}>
              <Icon name="chat" size={14} /> Ver la sala original
            </a>
            <button className="btnGhost btnMini" onClick={startFresh}>
              <Icon name="plus" size={14} /> Empezar de cero
            </button>
          </div>
        </Note>
      )}

      <section hidden={step !== 0}>
      <Card title="¿Qué quieres conseguir?">
        <label className="field">
          <span>Tarea <em>· obligatoria</em></span>
          <textarea className="textarea" rows={3} value={task} onChange={e => setTask(e.target.value)}
            placeholder="Ej: Diseñar la capa de caché para una API de búsqueda a 500 rps con presupuesto de $50/mes." />
        </label>
        <div className="two">
          <label className="field">
            <span>Contexto <em>· opcional</em></span>
            <textarea className="textarea" rows={2} value={context} onChange={e => setContext(e.target.value)}
              placeholder="Stack, restricciones, lo que ya se intentó…" />
          </label>
          <label className="field">
            <span>Criterios de éxito <em>· obligatorio</em></span>
            <textarea className="textarea" rows={2} value={criteria} onChange={e => setCriteria(e.target.value)}
              placeholder="Ej.: tests en verde, sin romper la API pública y con un informe de cambios y limitaciones." />
          </label>
        </div>
        <label className="field">
          <span>Plantilla</span>
          <select className="select" value={template} onChange={e => setTemplate(e.target.value)}>
            <option value="">Sin plantilla</option>
            {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
      </Card>
      </section>

      <section hidden={step !== 1}>
      <Card title="Entrega">
        <Note>
          Una sala termina entregando <b>código</b>: el plan que gane el debate se convierte en tareas
          y los agentes escriben los archivos —uno parchea, otro revisa y el servidor verifica antes de
          commitear en una rama propia de la sala—. Solo se queda en plan si lo pides aquí.
        </Note>
        <div className="stack" style={{ marginTop: 14, gap: 8 }}>
          <button
            className={`toggleRow${!planOnly ? ' on' : ''}`}
            onClick={() => setPlanOnly(false)}
            aria-pressed={!planOnly}
          >
            <span className="switch"><i /></span>
            <span style={{ minWidth: 0 }}>
              <b>Entregar código</b>
              <small>
                Con repo, audita y mejora el tuyo. <b>Sin repo, la sala crea su propio proyecto</b> (vacío,
                con git) y trabaja ahí. En los dos casos el resultado trae rama, commits y archivos.
              </small>
            </span>
          </button>
          <button
            className={`toggleRow${planOnly ? ' on' : ''}`}
            onClick={() => setPlanOnly(true)}
            aria-pressed={planOnly}
          >
            <span className="switch"><i /></span>
            <span style={{ minWidth: 0 }}>
              <b>Solo planificación</b>
              <small>El resultado es el plan contrastado, con su checksum. No se escribe ni se toca código.</small>
            </span>
          </button>
        </div>
      </Card>
      </section>

      <section hidden={step !== 1}>
      <Card title="Repositorio · opcional">
        <Note>
          Si indicas un repo, los agentes auditan tu código con hallazgos anclados a archivos, el debate
          aprueba qué mejoras se hacen y después las ejecutan por turnos sobre una rama propia de la sala.
          Si lo dejas vacío, la sala crea un <b>proyecto nuevo</b> y escribe ahí: el plan ganador es la
          especificación.
        </Note>
        <div className="two" style={{ marginTop: 14 }}>
          <label className="field">
            <span>Ruta local o URL de git <em>· vacío = proyecto nuevo de la sala</em></span>
            <input className="input" value={repoPath} onChange={e => setRepoPath(e.target.value)}
              placeholder="C:/Users/yo/proyecto  ·  https://github.com/yo/proyecto" />
          </label>
          <label className="field">
            <span>Rama o commit <em>· opcional</em></span>
            <input className="input" value={repoRef} onChange={e => setRepoRef(e.target.value)} placeholder="main (por defecto)" />
          </label>
        </div>
        <label className="field">
          <span>Comando de verificación <em>· lo ejecuta el servidor, nunca los agentes</em></span>
          <input className="input" value={repoVerify} onChange={e => setRepoVerify(e.target.value)}
            placeholder="npm test  ·  node check.mjs  ·  pytest -q" />
        </label>
        <p className="tiny">
          Se ejecuta al adjuntar el repo (línea base) y después de cada parche aprobado. Si la línea base ya
          está en rojo, ese fallo se registra como preexistente y no se le echa la culpa al debate.
          Sin comando, los parches se integran marcados como «sin verificación».
        </p>
        <label className="field" style={{ marginTop: 4 }}>
          <span>Publicar la rama en <em>· opcional; nunca se empuja nada sin pedirlo</em></span>
          <input className="input" value={repoPushTo} onChange={e => setRepoPushTo(e.target.value)}
            placeholder="git@github.com:yo/proyecto.git  ·  vacío = solo te llevas el diff" />
        </label>
        <p className="tiny">
          Si lo indicas, el panel gana un botón «Publicar la rama» que empuja los commits de la sala a ese
          remoto con <span className="mono">git push</span> (usa tus credenciales de git). No se ejecuta solo:
          publicar es una decisión tuya.
        </p>
      </Card>
      </section>

      <section hidden={step !== 1}>
      <Card
        title="Agenda de decisión"
        action={<span className="tiny">{plural(agenda.length, 'punto')}</span>}
      >
        <Note>
          Cada punto tiene un espacio de opciones enumerado: los agentes se posicionan y el consenso se
          cuenta de forma exacta (no es prosa). Si un agente propone una opción nueva, entra automáticamente.
        </Note>
        <div className="stack" style={{ marginTop: 14 }}>
          {agenda.map((row, i) => (
            <div className="row" key={i} style={{ alignItems: 'flex-start', gap: 8 }}>
              <input className="input" style={{ flex: '0 0 34%' }} placeholder="Punto (ej: Segmento objetivo)"
                value={row.label}
                onChange={e => setAgenda(rows => rows.map((r, j) => j === i ? { ...r, label: e.target.value } : r))} />
              <input className="input" placeholder="Opciones separadas por comas: PYME, Mid-market, Enterprise"
                value={row.options}
                onChange={e => setAgenda(rows => rows.map((r, j) => j === i ? { ...r, options: e.target.value } : r))} />
              <input className="input" type="number" min={0.5} max={3} step={0.5} style={{ flex: '0 0 74px' }}
                title="Peso del punto en el consenso global"
                value={row.weight}
                onChange={e => setAgenda(rows => rows.map((r, j) => j === i ? { ...r, weight: Number(e.target.value) || 1 } : r))} />
              <button className="btnGhost btnMini" onClick={() => setAgenda(rows => rows.filter((_, j) => j !== i))} title="Quitar punto">
                <Icon name="stop" size={14} />
              </button>
            </div>
          ))}
          <button className="btnGhost" onClick={() => setAgenda(rows => [...rows, { ...EMPTY }])}>
            <Icon name="plus" size={15} /> Añadir punto de decisión
          </button>
        </div>
      </Card>
      </section>

      <section hidden={step !== 2}>
      <Card title="Reglas del debate">
        <div className="three">
          <label className="field">
            <span>Agentes mínimos</span>
            <input className="input" type="number" min={1} max={64} value={minAgents}
              onChange={e => setMinAgents(Number(e.target.value) || 1)} />
          </label>
          <label className="field">
            <span>Agentes esperados <em>· 0 = sin límite</em></span>
            <input className="input" type="number" min={0} max={64} value={expectedAgents}
              onChange={e => setExpectedAgents(Number(e.target.value) || 0)} />
          </label>
          <label className="field">
            <span>Umbral de consenso</span>
            <select className="select" value={threshold} onChange={e => setThreshold(Number(e.target.value))}>
              <option value={0.6}>60% — rápido</option>
              <option value={0.75}>75% — normal</option>
              <option value={0.9}>90% — exigente</option>
              <option value={1}>100% — unanimidad</option>
            </select>
          </label>
        </div>
        <label className="field" style={{ marginTop: 16 }}>
          <span><input type="checkbox" checked={startAsSoonAsReady} onChange={e => setStartAsSoonAsReady(e.target.checked)} /> Empezar apenas llegue el mínimo</span>
          <small>Los demás harnesses pueden entrar más tarde. Durante el debate participan desde la siguiente fase; durante el trabajo pueden ayudar de inmediato. Si el mínimo es 1, el primero inicia el encargo.</small>
        </label>
        <div className="three">
          <label className="field">
            <span>Avance de las fases</span>
            <select className="select" value={phaseAdvanceMode} onChange={e => setPhaseAdvanceMode(e.target.value as 'timed' | 'agreement')}>
              <option value="timed">Con plazos</option>
              <option value="agreement">Por acuerdo · sin reloj</option>
            </select>
            {phaseAdvanceMode === 'agreement' && <small>Todos confirman antes de pasar. Un aporte nuevo reinicia las confirmaciones. Si alguien se desconecta, tendrás que intervenir. El lobby y las pruebas ejecutables conservan sus límites de seguridad.</small>}
          </label>
          <label className="field">
            <span>{phaseAdvanceMode === 'agreement' ? 'Duración (no se aplica en este modo)' : 'Duración del debate'}</span>
            <select className="select" disabled={phaseAdvanceMode === 'agreement'} value={durationMin} onChange={e => setDurationMin(Number(e.target.value))}>
              <option value={15}>15 minutos</option>
              <option value={45}>45 minutos</option>
              <option value={120}>2 horas</option>
            </select>
          </label>
          <label className="field">
            <span>Idioma</span>
            <select className="select" value={language} onChange={e => setLanguage(e.target.value)}>
              <option value="es">Español</option>
              <option value="en">English</option>
              <option value="pt">Português</option>
            </select>
          </label>
          <label className="field">
            <span>Presupuesto por agente <em>· 0 = sin tope</em></span>
            <input className="input" type="number" min={0} step={1000} value={budget}
              onChange={e => setBudget(Number(e.target.value) || 0)} />
          </label>
        </div>
        <label className="field">
          <span>Tono</span>
          <input className="input" value={tone} onChange={e => setTone(e.target.value)} />
        </label>
        <Note>
          Estas reglas son negociables: en la fase de encuadre los agentes pueden sugerir cambios y se
          aplican los que ratifique la mayoría.
        </Note>
      </Card>
      </section>

      <section hidden={step !== 2}>
      <Card title="Exigencia y modo">
        {planOnly && <Note>Solo planificación: no hay trabajo sobre código, así que estas dos palancas no se usan.</Note>}
        <button
          className={`toggleRow${extraordinary ? ' on' : ''}`}
          disabled={planOnly}
          onClick={() => setExtraordinary(v => !v)}
          aria-pressed={extraordinary}
        >
          <span className="switch"><i /></span>
          <span style={{ minWidth: 0 }}>
            <b>Trabajo extraordinario</b>
            <small>
              Al terminar el trabajo, la sala <b>no cierra</b>: cada mejora integrada se revisa contra el diff real y
              lo que todavía se pueda mejorar vuelve a la cola de trabajo (hasta dos rondas de revisión).
              Consume más tokens; la mejora debe comprobarse en el resultado. Sin esto, el debate cierra cuando el trabajo está integrado.
            </small>
          </span>
        </button>
        <button
          className={`toggleRow${recursion > 0 ? ' on' : ''}`}
          disabled={planOnly}
          onClick={() => setRecursion(v => (v > 0 ? 0 : 2))}
          aria-pressed={recursion > 0}
          style={{ marginTop: 10 }}
        >
          <span className="switch"><i /></span>
          <span style={{ minWidth: 0 }}>
            <b>Mejora recursiva</b>
            <small>
              Al cerrar el trabajo, la sala <b>vuelve a auditar el código ya mejorado</b>
              {' '}(con sus propios parches dentro) y repite el ciclo. Se detiene cuando una auditoría
              no encuentra nada nuevo: eso es «no hay más que mejorar», dicho por los agentes, y queda
              escrito en el acta con el motivo. El número son rondas extra permitidas, no la meta:
              {' '}{recursion > 0 ? `${recursion} extra (máx. ${1 + recursion} rondas en total)` : 'ahora mismo desactivada'}.
            </small>
          </span>
        </button>
        {recursion > 0 && (
          <div className="chips" style={{ marginTop: 10 }}>
            {[1, 2, 3, 6].map(n => (
              <button key={n} className={`chip${recursion === n ? ' on' : ''}`} onClick={() => setRecursion(n)}>
                {`${n} ronda${n === 1 ? '' : 's'} extra`}
              </button>
            ))}
          </div>
        )}
        <div className="chips" style={{ marginTop: 14 }}>
          <button className={`chip${!tournament ? ' on' : ''}`} onClick={() => setTournament(false)}>
            <Icon name="chat" size={16} /> Una sala
          </button>
          <button className={`chip${tournament ? ' on' : ''}`} onClick={() => setTournament(true)}>
            <Icon name="branch" size={16} /> Torneo de 3 ángulos + final
          </button>
        </div>
        <p className="tiny" style={{ marginTop: 10 }}>
          El torneo debate la misma tarea desde tres ángulos (coste, riesgo, ambición) y enfrenta después
          los planes ganadores en una final. Consume más tokens; no garantiza por sí solo una calidad superior.
        </p>
      </Card>
      </section>

      <section hidden={step !== 3}>
        <Card title="Tu encargo, antes de empezar">
          <div className="briefReview"><h3>{task || 'Falta definir el objetivo'}</h3><p>{criteria || 'Faltan los criterios de éxito'}</p><dl><div><dt>Entrega</dt><dd>{planOnly ? 'Solo planificación (plan con checksum)' : repoPath ? 'Código: mejoras sobre tu repo, en rama aparte' : 'Código: proyecto nuevo que crea la sala'}</dd></div><div><dt>Equipo</dt><dd>{minAgents} agentes mínimos · {expectedAgents || 'sin límite de'} esperados · {startAsSoonAsReady ? 'inicia al alcanzar el mínimo' : 'espera nuevas conexiones'}</dd></div><div><dt>Avance</dt><dd>{phaseAdvanceMode === 'agreement' ? 'Por acuerdo de todos · sin reloj durante el trabajo' : `Con plazos · ${durationMin} minutos de debate más ejecución y revisión`}</dd></div><div><dt>Presupuesto</dt><dd>{budget ? `${budget.toLocaleString('es')} tokens estimados por agente` : 'Sin límite de tokens configurado'}</dd></div><div><dt>Verificación</dt><dd>{repoVerify || 'Sin comando de pruebas explícito'}</dd></div></dl></div>
          {repoPath && !repoVerify && <Note>Sin un comando de verificación explícito, no debes interpretar una mejora integrada como una mejora probada. El servidor puede detectar un comando del repositorio; compruébalo al crear la sala.</Note>}
          <Note>Crear el trabajo no conecta ni ejecuta tus harnesses. El siguiente paso te dará la invitación y las instrucciones para conectarlos.</Note>
        </Card>
      </section>
      <div className="row composerActions">
        {step > 0 && <button className="btnGhost" onClick={() => setStep(n => n - 1)}><Icon name="back" size={16}/> Atrás</button>}
        {step < 3 ? <button className="btnBlue" onClick={() => { if (step === 0 && (task.trim().length < 10 || !criteria.trim())) { setError('Completa el objetivo (mínimo 10 caracteres) y los criterios de éxito.'); return; } setError(null); setStep(n => n + 1); }}>Continuar <Icon name="arrow" size={16}/></button> :
        <button className="btnBlue" onClick={create} disabled={busy}>
          {busy ? 'Creando…' : tournament ? 'Crear torneo' : 'Crear trabajo e invitar agentes'}
        </button>}
        <button className="btnGhost" onClick={() => navigate('#/trabajos')}>Cancelar</button>
      </div>
    </div>
  );
}
