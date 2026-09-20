// Trabajo conjunto: el repo, lo que el debate aprobó y qué pasó con cada tarea.
//
// La prioridad es la honestidad visual: verde solo lo que está integrado y
// verificado, ámbar lo que está en el aire, rojo lo que falló. Un parche sin
// revisar se dice con esas palabras, no se disimula.

import { useState } from 'react';
import { Icon } from './Icons';
import { Card, Empty, Note, Tag } from './Ui';
import { WORK_STATUS_LABEL, WORK_STATUS_TONE, dateTime, plural } from '../lib/format';
import type { RepoSummary, Room, WorkItem, WorkState } from '../lib/types';

const SEV_TONE: Record<string, 'red' | 'amber' | 'grey'> = { high: 'red', med: 'amber', low: 'grey' };

export function WorkBoard({ room, adminToken }: { room: Room; adminToken: string | null }) {
  const repo = room.repo;
  const work = room.work;
  const findings = room.findings || [];
  if (!repo && !work && !findings.length) return null;

  return (
    <Card
      title="Trabajo conjunto sobre el repo"
      action={work
        ? <span className="tiny">
          {work.stats.integrated}/{work.stats.items} integradas
          {work.stats.reverted > 0 && <> · {plural(work.stats.reverted, 'deshecha')}</>}
        </span>
        : <span className="tiny">{repo?.branch}</span>}
    >
      <RepoPanel code={room.code} repo={repo} work={work} adminToken={adminToken} branch={work?.branch || repo?.branch} />
      {room.health && <div className="deliveryWarning" role="status">
        <b>{room.health.state === 'blocked' ? 'Bloqueado · necesita un participante' : 'Sin avance comprobado'}</b>
        <p>{room.health.reason}</p><p>{room.health.action}</p>
        <small>No se descarta el parche ni se declara terminada la entrega.</small>
      </div>}
      {work?.review && (work.review.total > 0 || work.review.proposals.length > 0) && (
        <ReviewPanel review={work.review} phase={room.phase} status={room.status} />
      )}
      {findings.length > 0 && <FindingsPanel findings={findings} />}
      {work && <TasksPanel work={work} code={room.code} adminToken={adminToken} />}
    </Card>
  );
}

function RepoPanel({
  code, repo, work, adminToken, branch,
}: { code: string; repo: RepoSummary | null; work: WorkState | null; adminToken: string | null; branch?: string }) {
  if (!repo) return null;
  const baseline = work?.baseline || repo.baseline;
  const stats = work?.stats;
  return (
    <div className="repoBox">
      <div className="row wrap" style={{ gap: 8 }}>
        <Tag tone="purple"><Icon name="branch" size={13} /> {branch || repo.branch}</Tag>
        <Tag tone="grey">{plural(repo.files, 'archivo')}</Tag>
        {repo.verify ? <Tag tone="blue">verifica: <span className="mono">{repo.verify}</span></Tag> : <Tag tone="amber">sin comando de verificación</Tag>}
        {baseline && (
          baseline.status === 'running'
            ? <Tag tone="amber">midiendo línea base…</Tag>
            : baseline.ran
              ? <Tag tone={baseline.ok ? 'green' : 'red'}>línea base {baseline.ok ? 'en verde' : `en rojo (${baseline.exitCode})`}</Tag>
              : null
        )}
        {stats && stats.files > 0 && (
          <Tag tone="green">diff: {plural(stats.files, 'archivo')} <span className="mono">+{stats.insertions}/-{stats.deletions}</span></Tag>
        )}
      </div>
      <p className="tiny" style={{ marginTop: 8 }}>
        El servidor clona tu repo en un espacio propio y trabaja en la rama <span className="mono">{branch || repo.branch}</span>.
        Tu repositorio original no se toca: al final te llevas el diff con un <span className="mono">git fetch</span>.
      </p>
      {baseline?.ran && baseline.ok === false && baseline.outputTail && (
        <details className="miniDetails">
          <summary>Por qué la línea base está en rojo</summary>
          <pre className="workPre">{baseline.outputTail}</pre>
        </details>
      )}
      {repo.pushTo && (
        <p className="tiny" style={{ marginTop: 8 }}>
          Destino de publicación: <span className="mono">{repo.pushTo}</span>
          {repo.pushedAt
            ? <> · publicado {dateTime(repo.pushedAt)} hasta <span className="mono">{String(repo.pushedHead || '').slice(0, 10) || '—'}</span></>
            : <> · todavía sin publicar</>}
          {repo.pushedOutdated && (
            <b style={{ color: 'var(--amber, #b45309)' }}>
              {' '}· el remoto se quedó atrás: hay commits nuevos (ahora <span className="mono">{String(repo.head || '').slice(0, 10)}</span>) sin publicar
            </b>
          )}
        </p>
      )}
      <VerifyCommandEditor code={code} repo={repo} adminToken={adminToken} />
      {adminToken && (
        <div className="row wrap" style={{ marginTop: 10, gap: 8 }}>
          <a className="btnGhost btnMini" href={`/api/rooms/${code}/work.diff?admin=${encodeURIComponent(adminToken)}`} target="_blank" rel="noreferrer">
            <Icon name="doc" size={14} /> Diff completo (.diff)
          </a>
          <a className="btnGhost btnMini" href={`/api/rooms/${code}/work.patch?admin=${encodeURIComponent(adminToken)}`} target="_blank" rel="noreferrer">
            <Icon name="doc" size={14} /> Parche para git am (.patch)
          </a>
          {repo.pushTo && <PushButton code={code} adminToken={adminToken} repo={repo} />}
        </div>
      )}
    </div>
  );
}

// El comando de verificación se puede declarar (o corregir) en cualquier momento: una
// sala sin comando integraba parches sin comprobar nada, y el usuario solo lo descubría
// al final. Aquí se dice de dónde salió el comando y se puede cambiarlo o quitarlo.
function VerifyCommandEditor({ code, repo, adminToken }: { code: string; repo: RepoSummary; adminToken: string | null }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(repo.verify || '');
  const [state, setState] = useState<'idle' | 'busy' | 'ok' | 'error'>('idle');
  const [message, setMessage] = useState<string | null>(null);
  if (!adminToken) return null;

  const save = async () => {
    setState('busy');
    setMessage(null);
    try {
      const res = await fetch(`/api/rooms/${code}/admin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adminToken, op: 'set-verify', command: value.trim(), rerunBaseline: true }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.ok === false) {
        setState('error');
        setMessage(String(body.message || body.error || `HTTP ${res.status}`).slice(0, 400));
        return;
      }
      setState('ok');
      setMessage(body.command
        ? `Guardado: «${body.command}». Se está midiendo la línea base otra vez.`
        : 'Guardado sin comando: los parches se integrarán sin comprobar (y se dirá así en el resultado).');
      setOpen(false);
    } catch (err) {
      setState('error');
      setMessage(String((err as Error)?.message || err));
    }
  };

  return (
    <div className="stack" style={{ marginTop: 10 }}>
      {repo.verifySource?.detected && !repo.verifySource.why.startsWith('fijado a mano') && (
        <p className="tiny">
          Este comando no lo declaraste tú: se detectó en <b>{repo.verifySource.why}</b>. Cámbialo si no es el correcto.
        </p>
      )}
      {!repo.verify && (
        <p className="tiny">
          Esta sala no tiene comando de verificación: los parches aprobados se integrarán <b>sin comprobar</b>.
        </p>
      )}
      {open ? (
        <div className="verifyEditor">
          <label className="field">
            <span>Comando de verificación <em>· se ejecuta en el clon, nunca lo ejecutan los agentes</em></span>
            <input
              className="input"
              value={value}
              onChange={e => setValue(e.target.value.slice(0, 300))}
              placeholder="npm test  ·  node check.mjs  ·  pytest -q  ·  vacío = sin verificación"
            />
          </label>
          <div className="row">
            <button className="btnMini btnBlue" onClick={save} disabled={state === 'busy'}>
              {state === 'busy' ? 'Guardando…' : 'Guardar y volver a medir'}
            </button>
            <button className="btnGhost btnMini" onClick={() => { setOpen(false); setValue(repo.verify || ''); }}>Cancelar</button>
          </div>
        </div>
      ) : (
        <button className="linkBtn" onClick={() => setOpen(true)}>
          <Icon name="check" size={13} /> {repo.verify ? 'Cambiar el comando de verificación' : 'Añadir un comando de verificación'}
        </button>
      )}
      {message && <p className="tiny" style={{ color: state === 'error' ? 'var(--red, #e03131)' : undefined }}>{message}</p>}
    </div>
  );
}

// Revisión posterior al trabajo: la sala no se cierra en cuanto cada pieza pasa su
// verificación. Se revisa el conjunto, y con «trabajo extraordinario» lo que se propone
// vuelve a la cola. Aquí se ve qué falta por revisar y qué quedó propuesto sin ejecutar.
function ReviewPanel({ review, phase, status }: { review: NonNullable<WorkState['review']>; phase: string; status: string }) {
  const active = review.active && status !== 'closed';
  return (
    <div className="reviewBox">
      <div className="reviewHead">
        <b style={{ fontSize: 13.5 }}>{active ? 'Revisión posterior del trabajo' : status !== 'closed' ? 'Revisión final pendiente' : 'Revisión posterior del trabajo (cerrada)'}</b>
        <Tag tone={review.reviewed === null ? 'grey' : review.pending.length ? 'amber' : 'green'}>
          {review.reviewed === null ? 'sin registro de veredictos' : `${review.reviewed}/${review.total} mejoras revisadas`}
        </Tag>
        {review.extraordinary && <Tag tone="purple">trabajo extraordinario</Tag>}
        {review.maxRounds > 0 && <Tag tone="grey">ronda {review.round}/{review.maxRounds}</Tag>}
      </div>
      <p className="tiny" style={{ marginTop: 6 }}>
        {active
          ? 'Cada mejora integrada la mira un agente que no la escribió, contra el diff real. Nadie aprueba su propio trabajo.'
          : status !== 'closed' ? 'Se realizará al terminar la ejecución. Todavía no certifica la entrega.' : review.unknown ? 'La sala cerró sin una revisión final demostrada.' : 'La revisión se cerró con la sala.'}
        {review.reviewed !== null && review.reviewedItems?.length
          ? ` Veredictos: ${review.reviewedItems.map(r => `${r.id} (${r.by.join(', ')})`).join(' · ')}.`
          : ''}
        {phase === 'review' ? ' Ahora mismo la sala está en esta etapa.' : ''}
      </p>
      {review.pending.length > 0 && (
        <div className="reviewItems">
          {review.pending.map(item => (
            <div className="reviewItem" key={item.id}>
              <Tag tone="amber">pendiente</Tag>
              <span className="mono tiny">{item.id}</span>
              <div className="who"><b>{item.title}</b></div>
              <span className="spacer" />
              {item.byName && <span className="tiny">trabajo de {item.byName}</span>}
            </div>
          ))}
        </div>
      )}
      {review.proposals.length > 0 && (
        <details className="miniDetails" open>
          <summary>{plural(review.proposals.length, 'mejora')} propuestas en la revisión, sin ejecutar</summary>
          <div className="reviewItems">
            {review.proposals.map((p, i) => (
              <div className="reviewItem" key={i}>
                <Tag tone={p.severity === 'high' ? 'red' : p.severity === 'med' ? 'amber' : 'grey'}>{p.severity}</Tag>
                <div className="who">
                  <b>{p.title}</b>
                  <small style={{ whiteSpace: 'normal' }}>→ {p.action}</small>
                </div>
                <span className="spacer" />
                {p.byName && <span className="tiny">{p.byName}</span>}
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

// Publicar es una acción explícita: el botón dice a dónde va y muestra la salida de git
// tal cual, incluidos los fallos de credenciales (que es lo que uno necesita ver).
function PushButton({ code, adminToken, repo }: { code: string; adminToken: string; repo: RepoSummary }) {
  const [state, setState] = useState<'idle' | 'busy' | 'ok' | 'error'>('idle');
  const [message, setMessage] = useState<string | null>(null);

  const push = async () => {
    setState('busy');
    setMessage(null);
    try {
      const res = await fetch(`/api/rooms/${code}/admin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adminToken, op: 'push' }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.ok === false) {
        setState('error');
        setMessage(String(body.message || body.error || `HTTP ${res.status}`).slice(0, 400));
        return;
      }
      setState('ok');
      setMessage(String(body.output || '').trim().slice(0, 400) || `rama ${body.branch} publicada en ${body.target}`);
    } catch (err) {
      setState('error');
      setMessage(String((err as Error)?.message || err));
    }
  };

  return (
    <>
      <button className="btnGhost btnMini" onClick={push} disabled={state === 'busy'} title={repo.pushTo || ''}>
        <Icon name="branch" size={14} /> {state === 'busy' ? 'Publicando…' : state === 'ok' ? 'Publicar de nuevo' : 'Publicar la rama'}
      </button>
      {message && (
        <pre className={state === 'error' ? 'workPre err' : 'workPre'}>{message}</pre>
      )}
    </>
  );
}

function FindingsPanel({ findings }: { findings: Room['findings'] }) {
  const [open, setOpen] = useState(true);
  const debated = findings.filter(f => f.pointId).length;
  return (
    <div className="stack" style={{ marginTop: 14 }}>
      <div className="row">
        <b style={{ fontSize: 13.5 }}>Hallazgos de la auditoría ({findings.length})</b>
        <span className="spacer" />
        <span className="tiny">{debated} llegaron a la agenda</span>
        <button className="linkBtn" onClick={() => setOpen(v => !v)}>{open ? 'Ocultar' : 'Ver'}</button>
      </div>
      {open && (
        <div className="stack" style={{ gap: 0 }}>
          {findings.map(finding => (
            <div className="findingRow" key={finding.id}>
              <Tag tone={SEV_TONE[finding.severity] || 'grey'}>{finding.severity}</Tag>
              <div className="who">
                <b>
                  <span className="mono">{finding.file || '(sin archivo)'}{finding.line ? `:${finding.line}` : ''}</span>
                  {finding.symbol ? <span className="muted"> · {finding.symbol}</span> : null}
                </b>
                <small style={{ whiteSpace: 'normal' }}>{finding.claim}</small>
                <small style={{ whiteSpace: 'normal', color: 'var(--ink)' }}>→ {finding.action}</small>
              </div>
              <span className="spacer" />
              <span className="tiny" style={{ whiteSpace: 'nowrap' }}>{finding.byName}</span>
              <Tag tone={finding.pointId ? 'green' : 'grey'}>{finding.pointId ? 'a debate' : 'fuera'}</Tag>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TasksPanel({ work, code, adminToken }: { work: WorkState; code: string; adminToken: string | null }) {
  return (
    <div className="stack" style={{ marginTop: 16 }}>
      <div className="row wrap" style={{ gap: 8 }}>
        <b style={{ fontSize: 13.5 }}>Tareas aprobadas por el debate</b>
        <span className="spacer" />
        <Tag tone="green">{plural(work.stats.integrated, 'integrada')}</Tag>
        {work.stats.reverted > 0 && <Tag tone="purple">{plural(work.stats.reverted, 'deshecha')}</Tag>}
        {work.stats.open > 0 && <Tag tone="blue">{work.stats.open} en curso</Tag>}
        {work.stats.failed > 0 && <Tag tone="red">{plural(work.stats.failed, 'fallida')}</Tag>}
        {work.stats.skipped > 0 && <Tag tone="amber">{work.stats.skipped} sin integrar</Tag>}
        {work.stats.unreviewed > 0 && <Tag tone="amber">{work.stats.unreviewed} sin revisar</Tag>}
      </div>

      {work.pending && (() => {
        const patch = work.patches.find(p => p.id === work.pending?.patchId);
        const verifying = patch?.verify?.status === 'running';
        return (
          <Note>
            <b>Parche {work.pending.patchId} de la tarea {work.pending.itemId}: {verifying ? 'verificando ahora mismo' : patch?.review ? 'en cola de integración' : 'esperando revisión'}</b>
            <div>
              {verifying
                ? <>El servidor está ejecutando <span className="mono">{patch?.verify?.command}</span> sobre el árbol con el parche aplicado. Si la verificación se corta (por ejemplo, al reiniciar el servidor), se retoma sola sobre el mismo árbol: no se da por buena sin correr.</>
                : <>El árbol del repo está ocupado hasta que se resuelva: otro agente lo revisa y, si lo aprueba, el servidor ejecuta la verificación antes de commitear. Nadie aplica dos parches a la vez.</>}
            </div>
          </Note>
        );
      })()}

      {work.items.length === 0
        ? <Empty icon="doc" title="Sin tareas" hint="El debate no aprobó ninguna mejora concreta sobre el repo." />
        : (
          <div className="stack" style={{ gap: 0 }}>
            {work.items.map(item => <TaskRow key={item.id} item={item} work={work} code={code} adminToken={adminToken} />)}
          </div>
        )}

      <div className="row wrap" style={{ gap: 8, marginTop: 4 }}>
        <span className="tiny">
          {plural(work.stats.verifyRuns, 'verificación', 'verificaciones')} ejecutada{work.stats.verifyRuns === 1 ? '' : 's'}{work.verifyCommand ? ` · ${work.verifyCommand}` : ''}
          {work.stats.deferredFindings ? ` · ${plural(work.stats.deferredFindings, 'hallazgo')} sin hueco en la agenda` : ''}
          {work.stats.skippedByCap ? ` · ${plural(work.stats.skippedByCap, 'mejora')} aplazadas por límite de tareas` : ''}
        </span>
      </div>
    </div>
  );
}

function TaskRow({ item, work, code, adminToken }: { item: WorkItem; work: WorkState; code: string; adminToken: string | null }) {
  const patches = work.patches.filter(p => p.itemId === item.id);
  const last = patches[patches.length - 1];
  const tone = WORK_STATUS_TONE[item.status] || 'grey';
  const badge = `tag ${tone}`;
  return (
    <div className="workRow">
      <div className="workHead">
        <span className="workId mono">{item.id}</span>
        <div className="who">
          <b>{item.title}</b>
          <small>
            {item.files.length ? item.files.join(', ') : 'sin archivo declarado'}
            {item.byName ? ` · trabaja ${item.byName}` : ''}
            {item.reviewerName ? ` · revisa ${item.reviewerName}` : ''}
            {item.attempt > 0 ? ` · ${plural(item.attempt, 'parche', 'parches')}` : ''}
          </small>
        </div>
        <span className="spacer" />
        {item.severity && item.severity !== 'low' && <Tag tone={SEV_TONE[item.severity]}>{item.severity}</Tag>}
        {item.unreviewed && <Tag tone="amber">sin revisar</Tag>}
        {item.verify?.ran && <Tag tone={item.verify.ok ? 'green' : 'red'}>verificación {item.verify.ok ? 'ok' : item.verify.exitCode}</Tag>}
        {item.verify?.preExisting && <Tag tone="amber">fallo preexistente</Tag>}
        <span className={badge}>{WORK_STATUS_LABEL[item.status] || item.status}</span>
      </div>

      {item.commit && (
        <div className="tiny" style={{ marginTop: 6 }}>
          commit <span className="mono">{item.commit.slice(0, 10)}</span>
          {item.finishedAt ? ` · ${dateTime(item.finishedAt)}` : ''}
        </div>
      )}
      {item.note && <p className="tiny" style={{ marginTop: 6 }}>{item.note}</p>}

      {(item.lastError || last) && (
        <details className="miniDetails">
          <summary>
            {item.lastError && !item.verify?.ok ? 'Qué falló' : 'Ver el parche'}
            {last ? ` · ${last.summary}` : ''}
          </summary>
          {item.lastError && <pre className="workPre">{item.lastError}</pre>}
          {last && (
            <>
              <div className="tiny" style={{ marginTop: 8 }}>
                Parche {last.id} por {last.authorName} ({last.mode})
                {last.stat ? ` · ${plural(last.stat.files, 'archivo')} +${last.stat.insertions}/-${last.stat.deletions}` : ''}
                {last.review ? ` · ${last.review.verdict === 'approve' ? 'aprobado' : 'cambios pedidos'} por ${last.review.byName}` : ' · pendiente de revisión'}
              </div>
              {last.stat?.list?.length ? (
                <div className="kv" style={{ marginTop: 6 }}>
                  {last.stat.list.map(file => (
                    <Tag key={file.path} tone="grey">
                      <span className="mono">{file.path}</span> +{file.insertions}/-{file.deletions}
                    </Tag>
                  ))}
                </div>
              ) : null}
              {last.review?.notes && <p className="tiny" style={{ marginTop: 6 }}><b>Revisión:</b> {last.review.notes}</p>}
              {last.verify?.outputTail && <pre className="workPre">{last.verify.outputTail}</pre>}
              {patches.length > 1 && (
                <p className="tiny" style={{ marginTop: 6 }}>
                  Intentos anteriores: {patches.slice(0, -1).map(p => `${p.id}${p.superseded ? ' (descartado)' : ''}`).join(', ')}
                </p>
              )}
            </>
          )}
        </details>
      )}
      {item.evidence && (
        <p className="tiny" style={{ marginTop: 6 }}><b>Evidencia del hallazgo:</b> {item.evidence}</p>
      )}
      {item.revert && <RevertDetail revert={item.revert} reapplied={item.reapplied} />}
      {adminToken && (item.status === 'integrated' || item.status === 'reverted') && (
        <RevertButton code={code} adminToken={adminToken} item={item} reapply={item.status === 'reverted'} />
      )}
    </div>
  );
}

// Lo que se deshizo, contado sin adornos: qué commit se revirtió, con cuál, por qué y
// cómo quedó la verificación después. Si deshacer dejó la suite en rojo, se ve el rojo.
function RevertDetail({ revert, reapplied }: { revert: NonNullable<WorkItem['revert']>; reapplied: WorkItem['reapplied'] }) {
  const v = revert.verify;
  return (
    <div className="revertBox">
      <div className="row wrap" style={{ gap: 6 }}>
        <Tag tone="purple">{reapplied ? 'vuelta a aplicar' : 'deshecha'}</Tag>
        <span className="tiny">
          revirtió <span className="mono">{String(revert.of || '').slice(0, 10)}</span>
          {revert.commit ? <> en <span className="mono">{revert.commit.slice(0, 10)}</span></> : null}
          {revert.by ? ` · ${revert.by}` : ''} · {dateTime(revert.at)}
        </span>
      </div>
      {revert.reason && <p className="tiny" style={{ marginTop: 4 }}><b>Motivo:</b> {revert.reason}</p>}
      {revert.files.length > 0 && (
        <p className="tiny" style={{ marginTop: 4 }}>
          Archivos devueltos: {revert.files.map(f => <span key={f} className="mono">{f} </span>)}
        </p>
      )}
      {v && (
        <p className="tiny" style={{ marginTop: 4 }}>
          Verificación tras deshacer:{' '}
          {v.status === 'running'
            ? <>ejecutando <span className="mono">{v.command}</span> ahora mismo…</>
            : v.ran
              ? (v.ok ? <b style={{ color: 'var(--green, #2f9e44)' }}>vuelve a pasar en verde</b>
                : <b style={{ color: 'var(--red, #e03131)' }}>queda en rojo (código {v.exitCode})</b>)
              : 'no se pudo ejecutar'}
        </p>
      )}
      {v?.outputTail && <pre className="workPre err">{v.outputTail}</pre>}
      {reapplied && (
        <p className="tiny" style={{ marginTop: 4 }}>
          <b>Vuelta a aplicar</b> en <span className="mono">{String(reapplied.commit || '').slice(0, 10)}</span>
          {reapplied.by ? ` · ${reapplied.by}` : ''} · {dateTime(reapplied.at)}
          {reapplied.verify
            ? <> · verificación tras volver a aplicarla: {reapplied.verify.status === 'running'
              ? 'ejecutándose ahora mismo'
              : reapplied.verify.ran
                ? (reapplied.verify.ok ? 'en verde' : `en rojo (código ${reapplied.verify.exitCode})`)
                : 'no se pudo ejecutar'}</>
            : null}
        </p>
      )}
    </div>
  );
}

// Deshacer no es un botón de pánico: se pregunta el motivo, se enseña lo que va a pasar
// (una reversión en el historial, no un borrado) y se muestra el error si el servidor lo
// rechaza, en vez de fingir que se deshizo.
function RevertButton({ code, adminToken, item, reapply = false }: { code: string; adminToken: string; item: WorkItem; reapply?: boolean }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [state, setState] = useState<'idle' | 'busy' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const verb = reapply ? 'reapply' : 'revert';

  const submit = async () => {
    setState('busy');
    setError(null);
    try {
      const res = await fetch(`/api/rooms/${code}/admin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adminToken, op: verb, itemId: item.id, reason: reason.trim() || undefined }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.ok === false) {
        setState('error');
        setError(String(body.message || body.error || `HTTP ${res.status}`).slice(0, 400));
        return;
      }
      setOpen(false);
      setReason('');
      setState('idle');
    } catch (err) {
      setState('error');
      setError(String((err as Error)?.message || err));
    }
  };

  if (!open) {
    return (
      <button className="linkBtn" style={{ marginTop: 6 }} onClick={() => setOpen(true)}>
        <Icon name="undo" size={13} /> {reapply ? 'Volver a aplicar esta mejora' : 'Deshacer esta mejora'}
      </button>
    );
  }
  return (
    <div className="revertAsk">
      <p className="tiny">
        {reapply
          ? <>Se añade un commit que revierte la reversión: la mejora vuelve al proyecto, tal como la aprobó el debate. El historial conserva los tres pasos y después se vuelve a verificar.</>
          : <>Se añade un commit que revierte la mejora en la rama del clon: el cambio sale del proyecto, pero el commit original y la reversión quedan en el historial. Después se vuelve a verificar.</>}
      </p>
      <input
        className="input inputMini"
        value={reason}
        onChange={e => setReason(e.target.value.slice(0, 400))}
        placeholder={reapply ? 'Motivo (opcional): por qué vuelve' : 'Motivo (opcional): por qué se deshace'}
      />
      <div className="row" style={{ gap: 8, marginTop: 6 }}>
        <button className="btnMini btnDanger" onClick={submit} disabled={state === 'busy'}>
          {state === 'busy' ? (reapply ? 'Devolviendo…' : 'Deshaciendo…') : 'Confirmar'}
        </button>
        <button className="btnGhost btnMini" onClick={() => { setOpen(false); setError(null); setState('idle'); }}>Cancelar</button>
      </div>
      {error && <pre className="workPre err">{error}</pre>}
    </div>
  );
}
