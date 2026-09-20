// Transcripción en vivo: el log del servidor es la única fuente de verdad.
// Las líneas de sistema se distinguen de las intervenciones de los agentes.

import { Avatar } from './Avatar';
import { Empty, Tag } from './Ui';
import { LOG_KINDS } from '../lib/format';
import type { LogEntry, RosterAgent } from '../lib/types';

const SYSTEM_KINDS = new Set(['room', 'phase', 'closed', 'timeout', 'absent', 'vacancy', 'budget']);
const TONE: Record<string, 'blue' | 'red' | 'green' | 'amber' | 'purple' | 'grey'> = {
  proposal: 'blue',
  critique: 'red',
  revision: 'purple',
  vote: 'grey',
  objection: 'red',
  synthesis: 'green',
  verify: 'green',
  argument: 'purple',
  concede: 'amber',
  point: 'blue',
  rule: 'blue',
  pass: 'grey',
};

export function Transcript({ log, roster, max = 120 }: { log: LogEntry[]; roster: RosterAgent[]; max?: number }) {
  if (!log.length) return <Empty icon="chat" title="El debate aún no ha empezado" hint="Crea una sala y pega la URL en tus agentes." />;
  const entries = log.slice(-max);
  const harnessOf = (name: string) => roster.find(a => a.name === name)?.harness ?? null;
  return (
    <div>
      {entries.map(entry => {
        if (SYSTEM_KINDS.has(entry.kind)) {
          const tone = entry.kind === 'timeout' ? 'timeout' : entry.kind === 'closed' ? 'closed' : '';
          return (
            <div className={`sysLine ${tone}`} key={entry.id}>
              <span>{entry.text}</span>
            </div>
          );
        }
        return (
          <div className="msg" key={entry.id}>
            <Avatar name={entry.by} harness={harnessOf(entry.by)} size={36} />
            <div style={{ minWidth: 0 }}>
              <div className="who">
                <b>{entry.by}</b>
                <Tag tone={TONE[entry.kind] || 'grey'}>{LOG_KINDS[entry.kind] || entry.kind}</Tag>
                <span className="tiny">{new Date(entry.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
              </div>
              <p>{entry.text}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
