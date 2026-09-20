// Plantilla de agentes: quién está, con qué lente, cuánto lleva gastado y si sigue vivo.

import { Avatar } from './Avatar';
import { Empty } from './Ui';
import { estimateTokens, timeAgo } from '../lib/format';
import type { RosterAgent } from '../lib/types';

export function AgentRoster({ agents, showTokens = false, empty = 'Aún no hay agentes en la sala.' }: {
  agents: RosterAgent[];
  showTokens?: boolean;
  empty?: string;
}) {
  if (!agents.length) return <Empty icon="users" title={empty} />;
  return (
    <div className="agentRoster">
      {agents.map(agent => {
        const holding = agent.holding || null;
        const status = agent.status === 'absent' || !agent.online ? 'off' : holding ? 'live' : agent.overBudget ? 'warn' : '';
        // Un agente con una tarea en la mano está trabajando, no desconectado: su señal es la tarea
        // (escribir un parche tarda más que cualquier umbral de latido), y decirlo es lo que evita
        // que el panel se contradiga con el tablero, que ya dice «trabaja Buffy».
        const label = agent.status === 'absent' ? 'Ausente'
          : !agent.online ? 'Sin señal reciente'
          : holding ? (holding.state === 'reviewing' ? `Revisión asignada · ${holding.itemId}` : `Trabajo asignado · ${holding.itemId}`)
            : agent.overBudget ? 'Presupuesto agotado'
              : agent.online ? 'En línea' : 'Desconectado';
        return (
          <div className="agentRow" key={agent.id} title={holding?.title || undefined}>
            <Avatar name={agent.name} harness={agent.harness} size={58} dim={agent.status === 'absent'} />
            <div className="who">
              <b>{agent.name}{agent.replacementOf ? ' ·' : ''}</b>
              <small>
                {/* Identidad real: el harness. La lente solo si el agente la declaró. */}
                {agent.harness || 'harness sin declarar'}
                {agent.model ? ` · ${agent.model}` : ''}
                {agent.roleLabel ? ` · lente ${agent.roleLabel}` : ''}
                {showTokens ? ` · ~${estimateTokens(0) + agent.tokens} tok` : ''}
                {holding ? ` · ${holding.state === 'reviewing' ? 'revisa' : 'escribe'} ${holding.itemId}${holding.since ? ` desde ${timeAgo(holding.since)}` : ''}` : ''}
                {(holding?.also || []).map(extra => ` · ${extra.state === 'reviewing' ? 'revisa' : 'escribe'} ${extra.itemId}`).join('')}
                {` · última señal ${timeAgo(agent.lastSeenAt)}`}
              </small>
            </div>
            <span className={`st ${status}`}>
              <i className={`dot ${!agent.online ? 'off' : holding ? 'live' : ''}`} />
              {label}
            </span>
            {holding?.title && <div className="agentTask">{holding.title}</div>}
            {agent.capabilities.length > 0 && <div className="agentCapabilities">Capacidades: {agent.capabilities.join(' · ')}</div>}
          </div>
        );
      })}
    </div>
  );
}
