// Vista previa del trabajo: lo que los agentes están construyendo, MIENTRAS lo construyen.
//
// El servidor sirve el árbol de trabajo de la sala en solo lectura (mismas rutas, mismo tipo de
// contenido) y aquí se carga en un iframe con `sandbox` y sin `allow-same-origin`: el código de
// los agentes corre en su propio origen opaco y no alcanza este panel ni la sesión de nadie.
//
// Lo que hace que esto sea EN VIVO, y no una foto:
//   1. La sala llega por SSE (`useRoomLive`), así que cada movimiento rehace la consulta: se pide
//      el estado del proyecto en cuanto cambia el trabajo, no cada X segundos a ciegas.
//   2. El servidor devuelve los cambios SIN commitear con la hora de cada archivo: los archivos
//      aparecen en la lista mientras un agente los escribe, antes de que nadie los commitee.
//   3. La URL del iframe se DERIVA del contenido del proyecto (cabeza del repo, último archivo
//      escrito, líneas). No hay contador que incrementar: si el contenido no se movió, el
//      navegador no vuelve a cargar nada — y ningún evento repetido puede desbocar la vista.
//   4. Queda un sondeo lento de seguridad mientras hay trabajo abierto (los agentes también
//      escriben entre movimientos), y un botón para recargar a mano.
//
// Y también vive DENTRO de la pestaña de Trabajo (`compact`): ahí es donde el humano mira mientras
// la sala trabaja, y la vista previa no es un anexo, es el trabajo enseñándose. Cuando el proyecto
// no tiene página propia, el servidor sirve una PÁGINA DE PRUEBA que carga sus módulos de verdad
// (y el panel lo dice, en vez de fingir que eso es el entregable).
//
// Y una cosa que un navegador de verdad tiene y esto no tenía: LA CONSOLA. El iframe está aislado,
// así que su interior no se puede leer; la página devuelve sus errores por `postMessage` y aquí se
// cuentan, se agrupan y se enseñan. Una vista previa en blanco deja de ser un misterio.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import { Card, Empty, ErrorBox, Loading, Note, Tag } from './Ui';
import { Icon } from './Icons';
import { plural, timeAgo } from '../lib/format';
import type { PreviewChange, PreviewInfo, Room as RoomType } from '../lib/types';

const REFRESH_MS = 6_000;      // sondeo de seguridad mientras hay trabajo abierto
const FRESH_MS = 30_000;       // desde cuándo un archivo escrito cuenta como «ahora»
const RELOAD_GAP_MS = 700;     // un clic de recarga no se repite antes de esto
const CONSOLE_MAX = 20;        // líneas de consola que se guardan (con su contador)
const TERMINAL: string[] = ['integrated', 'reverted', 'failed', 'skipped'];

const STATUS_TONE: Record<PreviewChange['status'], 'green' | 'blue' | 'amber' | 'grey'> = {
  nuevo: 'green',
  editado: 'blue',
  borrado: 'amber',
  renombrado: 'grey',
};

function urlOf(code: string, entry: string, stamp: string) {
  const rel = entry.split('/').map(encodeURIComponent).join('/');
  return `/api/rooms/${code}/preview/${rel}?v=${encodeURIComponent(stamp)}`;
}

// Segundos, no minutos: en una vista en vivo «hace 8 s» dice mucho más que «ahora».
function since(at: number | null | undefined): string {
  if (!at) return '';
  const secs = Math.round((Date.now() - at) / 1000);
  if (secs < 0) return 'ahora';
  if (secs < 60) return `hace ${secs} s`;
  return timeAgo(at);
}

function counts(change: PreviewChange): string {
  const plus = change.insertions;
  const minus = change.deletions;
  if (plus == null && minus == null) return '';
  return `${plus != null ? `+${plus}` : '+'}${minus ? `/−${minus}` : ''}`;
}

// Lo que la página devuelve por `postMessage`: su consola y, si es la página de prueba, el informe
// de carga de cada módulo. Se agrupa por texto: un error que se repite es un contador, no 40 líneas.
type ConsoleLine = { level: 'error' | 'warn'; text: string; at: number; n: number };
type HarnessReport = { modules: { path: string; ok: boolean; exports?: string[]; error?: string }[]; packages?: string[] };

export function PreviewPanel({
  room, compact = false, active = true, onOpenFull,
}: { room: RoomType; compact?: boolean; active?: boolean; onOpenFull?: () => void }) {
  const [info, setInfo] = useState<PreviewInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [entry, setEntry] = useState<string | null>(null);
  const [manual, setManual] = useState(0);
  const [lines, setLines] = useState<ConsoleLine[]>([]);
  const [ready, setReady] = useState(false);
  const [viewport, setViewport] = useState('responsive');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [renderStamp, setRenderStamp] = useState('');
  const previewFrame = useRef<HTMLIFrameElement>(null);
  const [report, setReport] = useState<HarnessReport | null>(null);
  const [, setNow] = useState(0);
  const lastReload = useRef(0);

  const head = room.repo?.head || null;
  const open = (room.work?.items || []).filter(i => !TERMINAL.includes(i.status));
  const working = room.status !== 'closed' && open.length > 0;

  // Firma del trabajo de la sala: cuando se mueve algo (una tarea, un archivo, un commit), se
  // vuelve a preguntar por el proyecto. Es lo que convierte el SSE en una vista en vivo.
  const workSignature = useMemo(() => [
    room.log.length,
    head || '',
    (room.work?.items || []).map(i => `${i.id}:${i.status}:${(i.files || []).join(',')}`).join('|'),
    room.work?.stats?.integrated ?? 0,
  ].join('·'), [room.log.length, head, room.work]);

  const load = useCallback(async () => {
    try {
      const out = await api.preview(room.code);
      setInfo(out.preview);
      // La página elegida se conserva mientras siga existiendo; si no, manda la detectada.
      setEntry(current => (current && out.preview.pages?.includes(current) ? current : (out.preview.entry || null)));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo leer el proyecto de la sala');
    }
  }, [room.code]);

  useEffect(() => { if (active) void load(); }, [active, load, workSignature]);

  // Los agentes escriben entre movimientos, y una sala también se prepara antes de trabajar: un
  // sondeo lento mientras la sala no ha cerrado evita que la vista se quede atrás sin que nadie lo
  // note. Una sala cerrada ya no cambia sola, y ahí manda el botón de recargar. Una pestaña que no
  // se ve no sondea: el trabajo de fondo es de la sala, no del panel.
  const live = active && room.status !== 'closed';
  useEffect(() => {
    if (!live) return undefined;
    const timer = setInterval(() => { void load(); }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load, live]);

  // Y un tic para que los «hace N s» envejezcan solos.
  useEffect(() => {
    if (!live) return undefined;
    const timer = setInterval(() => setNow(n => n + 1), 5_000);
    return () => clearInterval(timer);
  }, [live]);

  // La consola de la página. Solo se escuchan los mensajes que llevan la marca de la vista previa:
  // cualquier otra cosa que llegue por `postMessage` se ignora.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== previewFrame.current?.contentWindow) return;
      const data = event.data as { agoraPreview?: number; level?: string; text?: string; ready?: boolean; report?: HarnessReport } | null;
      if (!data || data.agoraPreview !== 1) return;
      if (data.report) { setReport(data.report); return; }
      if (data.ready) { setReady(true); return; }
      if (data.level !== 'error' && data.level !== 'warn') return;
      const text = String(data.text || '').slice(0, 600);
      if (!text) return;
      setLines(prev => {
        const i = prev.findIndex(l => l.level === data.level && l.text === text);
        if (i !== -1) {
          const copy = prev.slice();
          copy[i] = { ...copy[i], n: copy[i].n + 1, at: Date.now() };
          return copy;
        }
        return [...prev, { level: data.level as 'error' | 'warn', text, at: Date.now(), n: 1 }].slice(-CONSOLE_MAX);
      });
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // Cambiar de página es limpiar la consola: lo que diga la página nueva no es lo que dijo la vieja.
  useEffect(() => { setLines([]); setReport(null); setReady(false); }, [entry]);

  // La URL se DERIVA del contenido: mismo contenido, misma URL, sin recargas que nadie pidió. Y el
  // botón solo cuenta cuando el humano lo pulsa (con un freno para que un clic nervioso no
  // encadene recargas).
  const contentStamp = info
    ? `${info.head || ''}-${info.lastWrite?.at || 0}-${info.changed?.files ?? 0}-${info.changed?.insertions ?? 0}`
    : '';
  useEffect(() => { if (autoRefresh) setRenderStamp(contentStamp); }, [autoRefresh, contentStamp]);
  const src = info?.available && entry ? urlOf(room.code, entry, `${renderStamp}-${manual}`) : null;
  useEffect(() => { setLines([]); setReport(null); setReady(false); }, [src]);
  const reload = () => {
    const now = Date.now();
    if (now - lastReload.current < RELOAD_GAP_MS) return;
    lastReload.current = now;
    void load();
    setRenderStamp(contentStamp);
    setManual(m => m + 1);
  };

  // El código que se está escribiendo. En un proyecto de módulos (una librería, un shader, un
  // servicio) el nombre del archivo dice qué se toca; el código dice qué se hace.
  const sourceFresh = !!info?.source?.at && Date.now() - info.source.at < FRESH_MS;
  const sourceBox = info?.source?.code ? (
    <div style={{ marginTop: 12 }}>
      <div className="row" style={{ gap: 8, marginBottom: 6 }}>
        {/* «Escribiéndose ahora» solo si lo es: si el archivo lleva media hora quieto, se dice. */}
        <span className="tiny muted">{sourceFresh ? 'Escribiéndose ahora' : 'Lo último que se escribió'}</span>
        <span className="mono tiny">{info.source.path}</span>
        <span className="spacer" />
        <span className="tiny muted">
          {info.source.lines != null ? plural(info.source.lines, 'línea') : ''}
          {info.source.at ? ` · ${since(info.source.at)}` : ''}
          {info.source.truncated ? ' · recortado' : ''}
        </span>
      </div>
      <pre className="snippet" style={{ maxHeight: compact ? 180 : 320 }}>
        {info.source.code}{info.source.truncated ? '\n…' : ''}
      </pre>
    </div>
  ) : null;

  const changes = info?.changes || [];
  const written = changes.filter(c => c.at && Date.now() - c.at < FRESH_MS);
  const last = info?.lastWrite || null;
  const fresh = !!last?.at && Date.now() - last.at < FRESH_MS;
  const softErrors = lines.filter(l => l.level === 'error').length;
  const warned = lines.length - softErrors;

  const statusChip = (
    <div className="row wrap" style={{ gap: 8 }}>
      {info?.head && <Tag tone="purple"><Icon name="branch" size={13} /> {(info.head || '').slice(0, 7)}</Tag>}
      {(working || fresh) && (
        <Tag tone="green">
          <span className="dot live" style={{ marginRight: 6 }} />
          {fresh && last ? `escribiendo · ${since(last.at)}` : 'trabajo en curso'}
        </Tag>
      )}
      {!working && !fresh && <Tag tone="grey">{room.status === 'closed' ? (info?.available && !info.synthetic ? 'vista del proyecto cerrado' : 'proyecto cerrado · sin app visible') : 'último estado'}</Tag>}
    </div>
  );

  const changesList = (limit: number) => (
    <div className="stack" style={{ gap: 4 }}>
      {changes.slice(0, limit).map(c => (
        <div key={c.path} className="row" style={{ gap: 8, fontSize: 12.5 }}>
          <span className={`dot${c.at && Date.now() - c.at < FRESH_MS ? ' live' : ' off'}`} />
          <span className="mono" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.path}</span>
          <span className="spacer" />
          <Tag tone={STATUS_TONE[c.status] || 'grey'}>{c.status}</Tag>
          {counts(c) && <span className="tiny muted mono">{counts(c)}</span>}
          <span className="tiny muted" style={{ minWidth: 62, textAlign: 'right' }}>{since(c.at)}</span>
        </div>
      ))}
      {changes.length > limit && (
        <span className="tiny muted">y {changes.length - limit} archivo(s) más sin commitear</span>
      )}
    </div>
  );

  const openTasks = (
    <div className="stack" style={{ gap: 6 }}>
      {open.slice(0, compact ? 2 : 4).map(i => (
        <div key={i.id} className="row" style={{ gap: 8, fontSize: 13 }}>
          <Tag tone={i.status === 'claimed' ? 'blue' : 'grey'}>{i.id}</Tag>
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{i.title}</span>
          <span className="spacer" />
          <span className="tiny muted">
            {i.byName || 'sin reclamar'}{i.files?.length ? ` · ${i.files.slice(0, 2).join(', ')}` : ''}
          </span>
        </div>
      ))}
      {open.length > (compact ? 2 : 4) && <span className="tiny muted">y {open.length - (compact ? 2 : 4)} tarea(s) más en curso</span>}
    </div>
  );

  // La consola de la página: lo que un navegador te enseña cuando la vista no aparece. Agrupada por
  // texto (con su contador) y con la hora: un error que se repite en cada recarga se ve como uno.
  const consoleBox = ready || lines.length > 0 ? (
    <div style={{ marginTop: 12 }}>
      <div className="row" style={{ gap: 8, marginBottom: 6 }}>
        <span className="tiny muted">Consola de la vista previa</span>
        <span className="spacer" />
        <span className="tiny muted">
          {softErrors > 0 ? `${plural(softErrors, 'error')}` : 'sin errores'}
          {warned > 0 ? ` · ${warned} aviso(s)` : ''}
        </span>
      </div>
      {lines.length === 0 ? (
        <p className="tiny" style={{ margin: 0 }}>
          No se han recibido errores de la página. Esto no certifica que el resultado funcione: comprueba las interacciones y las pruebas de la entrega.
        </p>
      ) : (
        <div className="stack" style={{ gap: 4 }}>
          {lines.map(l => (
            <div key={`${l.level}-${l.text}`} className="row" style={{ gap: 8, alignItems: 'baseline', fontSize: 12.5 }}>
              <Tag tone={l.level === 'error' ? 'amber' : 'grey'}>{l.level === 'error' ? 'error' : 'aviso'}</Tag>
              <span className="mono" style={{ minWidth: 0, wordBreak: 'break-word', flex: 1 }}>{l.text}</span>
              {l.n > 1 && <span className="tiny muted">×{l.n}</span>}
              <span className="tiny muted" style={{ minWidth: 62, textAlign: 'right' }}>{since(l.at)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  ) : null;

  // El informe de la página de prueba: qué módulos entran en el navegador y cuáles no, con su error.
  const reportBox = info?.synthetic && report ? (
    <div style={{ marginTop: 12 }}>
      <div className="row" style={{ gap: 8, marginBottom: 6 }}>
        <span className="tiny muted">Prueba de carga de los módulos</span>
        <span className="spacer" />
        <span className="tiny">
          {report.modules.filter(m => m.ok).length}/{report.modules.length} entran en el navegador
        </span>
      </div>
      <div className="stack" style={{ gap: 4 }}>
        {report.modules.map(m => (
          <div key={m.path} className="row" style={{ gap: 8, fontSize: 12.5 }}>
            <Tag tone={m.ok ? 'green' : 'amber'}>{m.ok ? 'carga' : 'no carga'}</Tag>
            <span className="mono" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.path}</span>
            <span className="spacer" />
            <span className="tiny muted" style={{ minWidth: 0, textAlign: 'right', maxWidth: compact ? 200 : 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {m.ok ? (m.exports?.length ? m.exports.slice(0, 4).join(', ') : 'sin exports') : m.error}
            </span>
          </div>
        ))}
      </div>
    </div>
  ) : null;

  // Una pestaña que no se ve no carga nada: ni iframe, ni sondeo, ni consola de fondo.
  if (!active) return null;

  // Sala sin proyecto (solo planificación, o una sala antigua): una línea, no una caja vacía.
  if (info && !info.available && (info.reason === 'solo-planificacion' || info.reason === 'sin-proyecto')) {
    if (!compact) {
      return (
        <Card title="Vista previa">
          <Empty
            icon="code"
            title={info.reason === 'solo-planificacion' ? 'Esta sala solo planifica' : 'Esta sala no tiene proyecto'}
            hint={info.reason === 'solo-planificacion'
              ? 'El resultado es el plan, sin código: no hay nada que previsualizar.'
              : 'Sin repositorio y sin proyecto nuevo no hay árbol de trabajo que servir. Reabre la sala para que cree uno.'}
          />
          {info.reason === 'sin-proyecto' && <a className="btnGhost" href={`#/nuevo?from=${room.code}`} style={{ margin: '0 20px 20px' }}>Crear otro proyecto para esta tarea <Icon name="arrow" size={16} /></a>}
        </Card>
      );
    }
    return null;
  }

  // Sin página NI módulos que probar: lo que sí hay es el trabajo, y eso se enseña.
  if (info && !info.available && info.reason === 'sin-pagina') {
    return (
      <Card
        title="Vista previa"
        action={statusChip}
      >
        {changes.length > 0 ? (
          <>
            <p className="tiny" style={{ marginBottom: 8 }}>
              Todavía no hay nada que cargar en un navegador (ni página, ni módulos), así que aquí se
              ve lo que sí está pasando: los archivos que los agentes están escribiendo ahora mismo.
            </p>
            {changesList(compact ? 6 : 12)}
          </>
        ) : (
          <p className="tiny">
            {plural(info.files || 0, 'archivo')} en el proyecto. {room.status === 'closed' ? 'La sala cerró sin una página o módulo previsualizable. Los archivos existentes no equivalen a una app terminada.' : <>Cuando los agentes escriban un <span className="mono">.html</span> o un módulo se cargará aquí en vivo</>}
            {onOpenFull ? <> · <button className="linkBtn" onClick={onOpenFull}>ver en la pestaña Vista previa</button></> : null}.
          </p>
        )}
        {sourceBox}
        {compact && onOpenFull && (
          <p className="tiny" style={{ marginTop: 10 }}>
            <button className="linkBtn" onClick={onOpenFull}>Ver en la pestaña Vista previa</button>
          </p>
        )}
        {open.length > 0 && <div style={{ marginTop: 12 }}><span className="tiny muted">En curso ahora mismo</span>{openTasks}</div>}
      </Card>
    );
  }

  return (
    <Card
      title={compact ? 'Vista previa en vivo' : 'Vista previa'}
      action={statusChip}
    >
      {error && <ErrorBox message={error} title="No se pudo abrir la vista previa" />}
      {!error && !info && <Loading label="Leyendo el proyecto de la sala…" />}

      {info?.available && (
        <>
          <div className="row wrap" style={{ gap: 8, marginBottom: 10 }}>
            {(info.pages || []).length > 1 && (
              <select
                aria-label="Página de la vista previa"
                className="input"
                style={{ maxWidth: 340 }}
                value={entry || ''}
                onChange={e => setEntry(e.target.value)}
              >
                {(info.pages || []).map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            )}
            <button className="chip" onClick={reload}>
              <Icon name="refresh" size={14} /> Recargar
            </button>
            {!compact && <label className="previewDevice"><span className="sr-only">Tamaño de vista previa</span><select className="select" value={viewport} onChange={e => setViewport(e.target.value)}>
              <option value="responsive">Ancho disponible</option><option value="768">Tablet · hasta 768 px</option><option value="390">Móvil · hasta 390 px</option>
            </select></label>}
            <button className="chip" aria-pressed={autoRefresh} onClick={() => setAutoRefresh(value => !value)}>{autoRefresh ? 'Actualización automática: sí' : 'Actualización automática: pausada'}</button>
            {!compact && entry && (
              <a className="chip" href={urlOf(room.code, entry, `${contentStamp}-${manual}`)} target="_blank" rel="noreferrer">
                <Icon name="link" size={14} /> Abrir en una pestaña
              </a>
            )}
            {compact && onOpenFull && (
              <button className="chip" onClick={onOpenFull}>
                <Icon name="arrow" size={14} /> Ampliar
              </button>
            )}
            <span className="spacer" />
            <span className="tiny muted">
              <span className="mono">{entry}</span> · {plural(info.files || 0, 'archivo')}
              {last?.at ? ` · última escritura ${since(last.at)}` : ''}
            </span>
          </div>

          {info.synthetic && (
            <p className="tiny" style={{ marginBottom: 8 }}>
              El proyecto todavía no tiene una página propia
              {info.modules?.length ? <> (de los suyos, {plural(info.modules.length, 'módulo')} aquí)</> : null}.
              Esto es una <strong>prueba de carga real</strong>: sus módulos importándose en el navegador,
              con lo que exportan y lo que falla. {room.status === 'closed'
                ? 'La sala cerró sin una interfaz propia; esta prueba de carga no acredita una aplicación terminada.'
                : <>Cuando los agentes escriban un <span className="mono">.html</span> se cargará ese archivo en su lugar.</>}
              {info.imports?.length ? <> Los paquetes que el proyecto importa por nombre
                (<span className="mono">{info.imports.join(', ')}</span>) se resuelven solos aquí.</> : null}
            </p>
          )}

          {!autoRefresh && <p className="tiny">Puedes probar formularios y navegación sin recargas automáticas. Pulsa Recargar para ver la última versión.</p>}
          <div className="previewStage">
          <iframe
            ref={previewFrame}
            title="Vista previa del proyecto"
            src={src || undefined}
            sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads"
            referrerPolicy="no-referrer"
            style={{
              width: compact || viewport === 'responsive' ? '100%' : `min(100%, ${viewport}px)`,
              display: 'block',
              margin: '0 auto',
              height: compact ? '38vh' : '68vh',
              minHeight: compact ? 220 : 260,
              border: '1px solid var(--line, #2a2f3a)',
              borderRadius: 14,
              background: '#fff',
            }}
          />
          </div>

          {consoleBox}
          {reportBox}
          {info.synthetic && sourceBox}

          {changes.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div className="row" style={{ gap: 8, marginBottom: 6 }}>
                <span className="tiny muted">Escrito y sin commitear</span>
                <span className="spacer" />
                <span className="tiny muted">
                  {plural(info.changed?.files || 0, 'archivo')}
                  {info.changed && (info.changed.insertions || info.changed.deletions)
                    ? ` · +${info.changed.insertions}/−${info.changed.deletions}`
                    : ''}
                  {written.length > 0 ? ` · ${written.length} en el último minuto` : ''}
                </span>
              </div>
              {changesList(compact ? 5 : 10)}
            </div>
          )}

          {compact ? (
            <p className="tiny" style={{ marginTop: 10 }}>
              El proyecto de la sala, en solo lectura, recargándose solo cuando los agentes escriben.
              Corre aislado en un <span className="mono">iframe</span>: míralo como una vista, no como
              un entorno de confianza.
            </p>
          ) : (
            <Note>
              Es el proyecto de la sala, servido en solo lectura desde su espacio de trabajo: tu copia
              original no se toca. Con la actualización automática activa, se recarga cuando los agentes escriben o entra un commit nuevo
              (la lista de arriba va con la hora de cada uno). El código corre aislado (sandbox sin
              acceso a esta página), así que míralo como una vista, no como un entorno de confianza.
              Los recursos del proyecto se sirven con sus rutas (<span className="mono">./src/app.js</span>),
              y los paquetes que importa por nombre se resuelven solos para que cargue igual que en un
              navegador.
            </Note>
          )}
        </>
      )}

      {open.length > 0 && (
        <div className="stack" style={{ marginTop: 14, gap: 6 }}>
          <span className="tiny muted">En curso ahora mismo</span>
          {openTasks}
        </div>
      )}
    </Card>
  );
}
