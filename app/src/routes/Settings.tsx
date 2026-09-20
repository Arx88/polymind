// Ajustes y diagnóstico: estado del servidor, límites del protocolo y exposición.

import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { Meta } from '../lib/types';
import { Card, ErrorBox, Note, Tag } from '../components/Ui';
import { Icon } from '../components/Icons';

export function Settings() {
  const [health, setHealth] = useState<{ rooms: number; waiters: number; subscribers: number; uptimeSec: number } | null>(null);
  const [meta, setMeta] = useState<(Meta & { caps?: Record<string, number> }) | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = () => {
      api.health().then(out => { setHealth(out); setError(null); }).catch(err => setError(err.message));
      api.meta().then(setMeta).catch(() => setMeta(null));
    };
    load();
    const t = window.setInterval(load, 5000);
    return () => window.clearInterval(t);
  }, []);

  if (error) return <ErrorBox message={error} />;

  const caps = meta?.caps || {};

  return (
    <div className="wide">
      <div className="pageHead">
        <div>
          <h1>Ajustes</h1>
          <p>Estado del servidor, límites del protocolo y cómo se exponen las salas a los agentes.</p>
        </div>
      </div>

      <div className="layoutTwo">
        <div className="col">
          <Card title="Servidor">
            <div className="stack" style={{ gap: 8 }}>
              <Row label="Salas persistidas" value={health ? String(health.rooms) : '—'} />
              <Row label="Agentes esperando turno (long-poll)" value={health ? String(health.waiters) : '—'} />
              <Row label="Interfaces suscritas (SSE)" value={health ? String(health.subscribers) : '—'} />
              <Row label="En marcha desde" value={health ? `${Math.round(health.uptimeSec / 60)} min` : '—'} />
              <Row label="Almacenamiento" value="data/*.json (sin base de datos, sin dependencias)" />
            </div>
            <Note>
              El servidor no tiene dependencias de ejecución: Node ≥ 18 y nada más. La interfaz se compila
              aparte y el servidor la sirve desde app/dist.
            </Note>
          </Card>

          <Card title="Límites por contribución">
            <div className="stack" style={{ gap: 8 }}>
              {Object.entries(caps).map(([key, value]) => (
                <Row key={key} label={key} value={String(value)} />
              ))}
              {Object.keys(caps).length === 0 && <p className="tiny">Cargando topes del servidor…</p>}
            </div>
            <p className="tiny" style={{ marginTop: 10 }}>
              Los topes se aplican por coerción: un mensaje demasiado largo se recorta en lugar de
              rechazarse, para no gastar un turno entero de LLM en un error de formato.
            </p>
          </Card>

          <Card title="Fases del protocolo">
            <div className="stepLine">
              {(meta?.phases || []).map(phase => (
                <span key={phase} className={`phasePill${phase === 'closed' ? ' done' : ''}`}>{phase}</span>
              ))}
            </div>
            <p className="tiny" style={{ marginTop: 10 }}>
              El orden lo impone el servidor con reglas deterministas: no hay un LLM moderador.
            </p>
          </Card>
        </div>

        <div className="col">
          <Card title="Exposición de las salas">
            <div className="stack" style={{ gap: 12 }}>
              <div>
                <b style={{ fontSize: 13.5 }}>Local</b>
                <p className="tiny">Todo funciona en tu máquina: el panel y los agentes comparten <code>localhost</code>.</p>
              </div>
              <div>
                <b style={{ fontSize: 13.5 }}>Red local</b>
                <p className="tiny">Los agentes de otra máquina entran con tu IP de LAN; el servidor la imprime al arrancar.</p>
              </div>
              <div>
                <b style={{ fontSize: 13.5 }}>Público</b>
                <p className="tiny">
                  Para agentes fuera de tu red, expón el puerto con un túnel (ngrok, Cloudflare) y no abras el
                  runner local: ejecuta procesos de tu máquina.
                </p>
              </div>
            </div>
            <Note>
              El runner local tiene allowlist de CLIs y escucha en loopback por defecto. La CLI «custom»
              exige el flag <code>--allow-custom</code> de forma explícita.
            </Note>
          </Card>

          <Card title="Documentación">
            <div className="row wrap">
              <a className="btnGhost" href="/manual" target="_blank" rel="noreferrer"><Icon name="doc" size={15} /> Manual de agentes</a>
              <a className="btnGhost" href="/api/hall" target="_blank" rel="noreferrer"><Icon name="link" size={15} /> /api/hall</a>
              <a className="btnGhost" href="/api/meta" target="_blank" rel="noreferrer"><Icon name="link" size={15} /> /api/meta</a>
              <a className="btnGhost" href="/api/templates" target="_blank" rel="noreferrer"><Icon name="link" size={15} /> /api/templates</a>
            </div>
          </Card>

          <Card title="Capacidades declarables">
            <div className="chips">
              {Object.entries(meta?.capabilities || {}).map(([id, label]) => (
                <Tag key={id} tone="grey">{label}</Tag>
              ))}
            </div>
            <p className="tiny" style={{ marginTop: 10 }}>
              Declarar de menos es mejor que declarar de más: el servidor usa lo declarado para no exigir a
              un agente lo que ha dicho que no puede hacer. No condiciona su identidad ni su papel.
            </p>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="row" style={{ fontSize: 13.5 }}>
      <span className="muted">{label}</span>
      <span className="spacer" />
      <b>{value}</b>
    </div>
  );
}
