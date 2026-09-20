// Caja de invitación: la URL que se pega en cada agente, el prompt listo y el
// fragmento exacto por harness (MCP, HTTP, runner). Es lo único que hace el usuario.

import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { CopyButton, Note } from './Ui';
import { Icon } from './Icons';
import type { SnippetBundle } from '../lib/types';

const HARNESSES = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'zcode', label: 'ZCode' },
  { id: 'generic', label: 'Cualquiera' },
];

export function InviteBox({ code }: { code: string }) {
  const [harness, setHarness] = useState('claude');
  const [bundle, setBundle] = useState<SnippetBundle | null>(null);
  const [failed, setFailed] = useState(false);
  const url = `${window.location.origin}/r/${code}`;
  const prompt = `Conéctate al debate Polymind de la sala ${code} y participa hasta el final. Protocolo:\n`
    + `1) POST ${window.location.origin}/api/rooms/${code}/join con {"name":"tu-nombre","model":"tu-modelo","harness":"tu-harness"} (no hay rol que aceptar: debatimos entre harness, cada uno con su criterio)\n`
    + `2) Bucle: GET ${window.location.origin}/api/rooms/${code}/turn?agent=A&token=T&wait=120 → POST .../move, hasta action:"done".\n`
    + `3) Al cerrar: GET .../result y repórtame el plan final con su checksum.\n`
    + `Manual completo: ${window.location.origin}/manual`;

  useEffect(() => {
    let alive = true;
    setBundle(null);
    setFailed(false);
    api.snippets(harness, code)
      .then(out => { if (alive) setBundle(out); })
      .catch(() => { if (alive) { setBundle(null); setFailed(true); } });
    return () => { alive = false; };
  }, [harness, code]);

  return (
    <div className="stack">
      <div className="urlBox">
        <code>{url}</code>
        <CopyButton text={url} label="Copiar URL" />
      </div>
      <div className="row">
        <span className="tiny">El registro manual reserva una identidad; no ejecuta tu harness.</span>
        <span className="spacer" />
        <a className="linkBtn" href={`#/agente?room=${code}&mode=manual`}>Registro avanzado <Icon name="arrow" size={14} /></a>
      </div>
      <div>
        <div className="row" style={{ marginBottom: 8 }}>
          <b style={{ fontSize: 13.5 }}>Prompt para pegar en el agente</b>
          <span className="spacer" />
          <CopyButton text={prompt} label="Copiar prompt" ghost />
        </div>
        <pre className="snippet" style={{ maxHeight: 150 }}>{prompt}</pre>
      </div>

      <div>
        <div className="row" style={{ marginBottom: 8 }}>
          <b style={{ fontSize: 13.5 }}>Conexión por harness</b>
          <span className="spacer" />
          <div className="tabs">
            {HARNESSES.map(h => (
              <button key={h.id} className={`tab${harness === h.id ? ' on' : ''}`} onClick={() => setHarness(h.id)}>{h.label}</button>
            ))}
          </div>
        </div>
        {bundle?.files?.length ? bundle.files.map(file => (
          <div key={file.name} style={{ marginBottom: 8 }}>
            <div className="row">
              <span className="tiny mono">{file.name}</span>
              <span className="spacer" />
              <CopyButton text={file.content} label="Copiar" ghost />
            </div>
            <pre className="snippet">{file.content}</pre>
          </div>
        )) : (
          <Note>
            Este harness usa el bucle HTTP directo; copia el prompt de arriba o el comando:
            <pre className="snippet" style={{ marginTop: 8 }}>{bundle?.curl || (failed ? 'No se pudo obtener el fragmento. Puedes usar el prompt HTTP de arriba.' : 'Cargando…')}</pre>
          </Note>
        )}
      </div>

      <Note>
        El agente se une solo con esa URL: el servidor le devuelve su manual, la agenda y el esquema
        de cada movimiento. No necesitas configurar nada más.
      </Note>
    </div>
  );
}

export function RunnerHint({ code }: { code: string }) {
  const command = `node server/runner/index.mjs --room ${code} --roster roster.json --url ${window.location.origin}`;
  return (
    <div className="row" style={{ gap: 8 }}>
      <Icon name="bolt" size={16} />
      <code className="mono tiny" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{command}</code>
      <CopyButton text={command} label="Copiar" ghost />
    </div>
  );
}
