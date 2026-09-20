// La configuración de una sala, entera y en un solo sitio: qué se preguntó, con qué contexto
// y criterios, con qué agenda, con qué reglas y con qué repo, más el prompt que se pega en
// los agentes. Y desde aquí se vuelve a convocar: reabrir con esta configuración o guardarla
// como plantilla. Una sala cerrada deja de ser un callejón sin salida.

import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../lib/api';
import { navigate } from '../lib/router';
import { plural, timeAgo } from '../lib/format';
import type { RoomConfig } from '../lib/types';
import { Card, CopyButton, ErrorBox, Loading, Note, Tag } from './Ui';
import { Icon } from './Icons';
import { LongText } from './LongText';

export function RoomConfigCard({ code, adminToken = null, extra = null }: {
  code: string;
  adminToken?: string | null;
  extra?: ReactNode;
}) {
  const [config, setConfig] = useState<RoomConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    setConfig(null);
    setError(null);
    setSaved(null);
    api.roomConfig(code)
      .then(out => { if (alive) setConfig(out.config); })
      .catch(err => { if (alive) setError(err.message); });
    return () => { alive = false; };
  }, [code]);

  async function saveTemplate() {
    if (!adminToken) return;
    setBusy(true);
    setError(null);
    try {
      const out = await api.saveRoomTemplate(code, { adminToken });
      setSaved(out.template.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo guardar la plantilla');
    } finally {
      setBusy(false);
    }
  }

  if (error && !config) return <ErrorBox message={error} />;
  if (!config) return <Loading label="Cargando la configuración…" />;

  const s = config.settings || {};
  const minutes = s.maxDurationMs ? Math.round(s.maxDurationMs / 60_000) : null;

  return (
    <Card
      title="Prompt y configuración"
      action={<CopyButton text={config.prompt} label="Copiar el prompt" />}
    >
      <div className="row wrap" style={{ gap: 6, marginBottom: 12 }}>
        <button className="btnPrimary btnMini" onClick={() => navigate(`#/nuevo?from=${code}`)}>
          <Icon name="refresh" size={14} /> Reabrir con esta configuración
        </button>
        <a className="btnGhost btnMini" href={`/api/rooms/${code}/config`} target="_blank" rel="noreferrer">
          <Icon name="download" size={14} /> Ver el JSON
        </a>
        {adminToken && (
          <button className="btnGhost btnMini" onClick={saveTemplate} disabled={busy}>
            <Icon name="doc" size={14} /> {saved ? 'Guardada como plantilla' : 'Guardar como plantilla'}
          </button>
        )}
        {extra}
      </div>

      {saved && (
        <Note>
          Plantilla <span className="mono">{saved}</span> guardada: ya aparece en Plantillas y
          se abre con un clic, sin volver a escribir nada.
        </Note>
      )}
      {error && <p className="tiny" style={{ color: 'var(--red)' }}>{error}</p>}

      <div className="kv">
        <ConfigRow label="Sala de origen" value={`${config.from} · ${plural(config.origin.agents, 'agente')} · ${config.origin.at ? timeAgo(config.origin.at) : 'sin fecha'}`} />
        {config.template && <ConfigRow label="Plantilla" value={config.template} />}
        {config.tournament?.id && <ConfigRow label="Torneo" value={`${config.tournament.id} · ${config.tournament.angle || ''} · ronda ${config.tournament.round ?? 1}`} />}
        <ConfigRow label="Idioma y tono" value={`${config.language} · ${config.tone || '—'}`} />
        <ConfigRow
          label="Participación"
          value={`mínimo ${s.minAgents ?? '—'} · esperados ${s.expectedAgents ?? '—'} · consenso ${s.consensusThreshold != null ? Math.round(s.consensusThreshold * 100) : 75}%`}
        />
        <ConfigRow
          label="Ritmo"
          value={`${minutes ?? '—'} min de tope${s.extraordinary ? ' · trabajo extraordinario' : ''}${s.repo?.recursionRounds ? ` · mejora recursiva (${s.repo.recursionRounds} ronda${s.repo.recursionRounds === 1 ? '' : 's'} extra)` : ''}${s.tokenBudgetPerAgent ? ` · ${s.tokenBudgetPerAgent} tokens/agente` : ''}`}
        />
        {config.repo && (
          <ConfigRow
            label="Repositorio"
            value={`${config.repo.path || '—'}${config.repo.ref ? ` @ ${config.repo.ref}` : ''}${config.repo.verify ? ` · verifica ${config.repo.verify}` : ' · sin verificación'}`}
          />
        )}
      </div>

      <div style={{ marginTop: 12 }}>
        <b>Tarea</b>
        <LongText text={config.task} lines={6} label="la tarea" />
      </div>
      {config.context && (
        <div style={{ marginTop: 10 }}>
          <b>Contexto</b>
          <LongText text={config.context} lines={6} label="el contexto" />
        </div>
      )}
      {config.criteria && (
        <div style={{ marginTop: 10 }}>
          <b>Criterios de éxito</b>
          <LongText text={config.criteria} lines={6} label="los criterios" />
        </div>
      )}

      {config.agenda.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <b>Agenda de decisión</b>
          {config.agenda.map((point, i) => (
            <div key={`${point.label}-${i}`} style={{ marginTop: 6 }}>
              <div style={{ fontSize: 13.5 }}>{point.label}</div>
              <div className="row wrap" style={{ gap: 6, marginTop: 4 }}>
                {point.options.map(option => <Tag key={option} tone="grey">{option}</Tag>)}
              </div>
            </div>
          ))}
        </div>
      )}

      {config.roster.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <b>Quién lo debatió</b>
          <div className="row wrap" style={{ gap: 6, marginTop: 4 }}>
            {config.roster.map((agent, i) => (
              <Tag key={`${agent.name}-${i}`} tone="blue">
                {agent.name}{agent.harness ? ` · ${agent.harness}` : ''}{agent.model ? ` · ${agent.model}` : ''}
              </Tag>
            ))}
          </div>
        </div>
      )}

      <div style={{ marginTop: 14 }}>
        <div className="row">
          <b>Prompt para los agentes</b>
          <span className="spacer" />
          <span className="tiny muted">{config.prompt.length} caracteres</span>
        </div>
        <LongText text={config.prompt} lines={14} label="el prompt" />
      </div>
    </Card>
  );
}

function ConfigRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="row" style={{ fontSize: 13.5 }}>
      <span className="muted">{label}</span>
      <span className="spacer" />
      <b className="mono" style={{ fontWeight: 500 }}>{value}</b>
    </div>
  );
}
