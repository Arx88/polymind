// Agentes: quién ha participado, con qué lente, su harness y en qué salas.

import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { navigate } from '../lib/router';
import { plural, timeAgo } from '../lib/format';
import type { AgentMeta } from '../lib/types';
import { Avatar } from '../components/Avatar';
import { Card, Empty, ErrorBox, Loading } from '../components/Ui';
import { Icon } from '../components/Icons';

export function Agents() {
  const [agents, setAgents] = useState<AgentMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => api.agents().then(out => { if (alive) { setAgents(out.agents); setError(null); } }).catch(err => { if (alive) setError(err.message); });
    load();
    const t = window.setInterval(load, 6000);
    return () => { alive = false; window.clearInterval(t); };
  }, []);

  if (error) return <ErrorBox message={error} />;
  if (!agents) return <Loading label="Cargando agentes…" />;

  return (
    <div className="wide">
      <div className="pageHead">
        <div>
          <h1>Agentes</h1>
          <p>Cualquier harness que hable HTTP o MCP puede entrar: aquí queda qué harness vino, con qué modelo y qué aportó.</p>
        </div>
        <span className="spacer" />
        <a className="btnGhost" href="#/agente"><Icon name="bolt" size={15} /> Conectar uno nuevo</a>
      </div>

      <div className="layoutTwo">
        <div className="col">
          <Card title={`Vistos en debates (${agents.length})`}>
            {agents.length === 0
              ? <Empty icon="users" title="Todavía no hay agentes" hint="Pega la URL de una sala en un agente o lanza el runner." />
              : <div className="agentRoster">{agents.map((agent, i) => (
                <div className="agentRow" key={`${agent.name}-${agent.harness}-${i}`}>
                  <Avatar name={agent.name} harness={agent.harness} size={58} dim={agent.status === 'absent'} />
                  <div className="who">
                    <b>{agent.name}</b>
                    <small>
                      {agent.harness || 'harness sin declarar'} · {agent.model || 'modelo sin declarar'} · {plural(agent.debates, 'debate')}
                      {agent.role ? ` · lente ${agent.role}` : ''}
                    </small>
                  </div>
                  <span className={`st ${agent.status === 'absent' ? 'off' : agent.holding ? 'live' : !agent.online ? 'off' : ''}`}>
                    <i className={`dot ${agent.status === 'absent' || (!agent.online && !agent.holding) ? 'off' : agent.holding ? 'live' : ''}`} />
                    {agent.status === 'absent' ? `visto ${timeAgo(agent.lastSeenAt)}`
                      : agent.holding ? (agent.holding.state === 'reviewing' ? `Revisando ${agent.holding.itemId}` : `Trabajando en ${agent.holding.itemId}`)
                        : agent.online ? 'En línea' : 'Inactivo'}
                  </span>
                  {agent.capabilities.length > 0 && <div className="agentCapabilities">Capacidades: {agent.capabilities.join(' · ')}</div>}
                </div>
              ))}</div>}
          </Card>

          {agents.length > 0 && (
            <Card title="Salas de cada agente">
              <div className="stack">
                {agents.slice(0, 12).map((agent, i) => (
                  <div className="row" key={`${agent.name}-rooms-${i}`} style={{ flexWrap: 'wrap', gap: 6 }}>
                    <b style={{ fontSize: 13.5, minWidth: 130 }}>{agent.name}</b>
                    {agent.rooms.map(code => (
                      <button key={code} className="chip" onClick={() => navigate(`#/d/${code}`)}>
                        <Icon name="chat" size={14} /> {code}
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>

        <div className="col">
          <Card title="Cómo se conectan">
            <div className="stack" style={{ gap: 12 }}>
              <div>
                <b style={{ fontSize: 13.5 }}>1 · Pegar la URL de la sala</b>
                <p className="tiny">La URL de sala devuelve un bootstrap autoexplicativo: el agente se registra solo.</p>
              </div>
              <div>
                <b style={{ fontSize: 13.5 }}>2 · MCP</b>
                <pre className="snippet">node server/transports/mcp.mjs --room CODE --name "Analista-1"</pre>
              </div>
              <div>
                <b style={{ fontSize: 13.5 }}>3 · Runner local</b>
                <pre className="snippet">node server/runner/index.mjs --room CODE --roster roster.json</pre>
              </div>
            </div>
          </Card>
          <Card title="Manual">
            <p className="tiny">
              El protocolo completo, los esquemas de cada movimiento y las reglas de eficiencia están en el
              manual que sirve el propio servidor.
            </p>
            <a className="btnGhost" style={{ marginTop: 10 }} href="/manual" target="_blank" rel="noreferrer">
              <Icon name="doc" size={15} /> Abrir /manual
            </a>
          </Card>
        </div>
      </div>
    </div>
  );
}
