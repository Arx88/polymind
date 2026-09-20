import './agents.css';

// Personajes Polymind: la ilustración no asigna roles ni representa al proveedor.
function portraitIndex(name: string, harness?: string | null): number {
  let value = 0;
  for (const char of `${harness || ''}:${name}`) value = (value * 31 + char.charCodeAt(0)) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  return ((value ^ (value >>> 16)) >>> 0) % 5;
}
export function Avatar({ name, harness, size = 36, dim = false }: {
  name: string; harness?: string | null; size?: number; dim?: boolean;
}) {
  const index = portraitIndex(name, harness);
  return <span className={`polymindAvatar${dim ? ' isAbsent' : ''}`} role="img" aria-label={name}
    style={{ width: size, height: size, backgroundPosition: `${(index % 3) * 50}% ${Math.floor(index / 3) * 100}%` }} />;
}
export function FaceStack({ agents, max = 5 }: { agents: { name: string; harness?: string | null }[]; max?: number }) {
  const shown = agents.slice(0, Math.max(0, max));
  const remaining = agents.length - shown.length;
  return <div className="faces polymindFaces">
    {shown.map((agent, index) => <span className="face" key={`${agent.name}-${index}`} title={agent.name}
      style={{ position: 'relative', zIndex: shown.length - index }}>
      <Avatar name={agent.name} harness={agent.harness} size={30} />
    </span>)}
    {remaining > 0 && <span className="remainingAgents" aria-label={`${remaining} agentes más`}>+{remaining}</span>}
  </div>;
}
