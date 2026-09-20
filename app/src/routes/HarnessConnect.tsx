import { useState } from 'react';
import type { HallRoom } from '../lib/types';
import { useRoomLive } from '../lib/live';
import { InviteBox, RunnerHint } from '../components/InviteBox';
import { Card, Empty, ErrorBox, Note, Tag } from '../components/Ui';
import { Icon } from '../components/Icons';
import { Avatar } from '../components/Avatar';
import { AgentConnect } from './AgentConnect';

export function HarnessConnect({ query, rooms }: { query: URLSearchParams; rooms: HallRoom[] }) {
  const [code, setCode] = useState(query.get('room') || '');
  const { room, error } = useRoomLive(code || null);
  if (query.get('mode') === 'manual') return <AgentConnect query={query} rooms={rooms}/>;
  const available = rooms.filter(r => r.status !== 'closed');
  return <div className="wide harnessConnect">
    <div className="pageHead"><div><span className="eyebrow">TUS HERRAMIENTAS, TRABAJANDO JUNTAS</span><h1>Conecta tus harnesses.</h1><p>Elige un trabajo, lleva la invitación a cada harness y comprueba aquí quién se ha unido.</p></div></div>
    <div className="layoutTwo"><div className="col">
      <Card title="1. Elige el trabajo"><label className="field"><span>Trabajo de destino</span><select className="select" value={code} onChange={e => setCode(e.target.value)}><option value="">Selecciona un trabajo abierto</option>{available.map(r => <option key={r.code} value={r.code}>{r.title} · {r.status === 'lobby' ? 'esperando agentes' : 'en marcha'}</option>)}{code && !available.some(r => r.code === code) && <option value={code}>Sala {code}</option>}</select></label>{!available.length && !code && <Empty icon="chat" title="No hay trabajos abiertos" hint="Primero crea el objetivo al que se unirá tu equipo."/>}{!available.length && <a className="btnBlue" href="#/nuevo"><Icon name="plus" size={16}/> Crear un trabajo</a>}</Card>
      {error && <ErrorBox message={error}/>}
      {room && room.status !== 'closed' && <Card title="2. Comparte la invitación"><InviteBox code={code}/></Card>}
      {room?.status === 'closed' && <Note>Este trabajo ya está cerrado. <a className="linkBtn" href={`#/nuevo?from=${code}`}>Crear otro con su configuración</a></Note>}
      {room && room.status !== 'closed' && <details className="connectionAdvanced"><summary>Conectar varios harnesses con el runner local</summary><p>Ejecuta este comando desde el proyecto de Polymind, con tu archivo roster.json configurado. Utiliza el servidor de esta sesión.</p><RunnerHint code={code}/></details>}
    </div><div className="col">
      <Card title="3. Comprueba tu equipo">{room ? <><div className="row wrap"><Tag tone="blue">{room.roster.length} registrados</Tag><Tag tone="grey">Mínimo {room.rules.minAgents}</Tag></div><p className="tiny" style={{margin:'14px 0'}}>Registrarse no significa estar ejecutando el bucle. La actividad del harness se refleja en su señal y en sus contribuciones.</p>{room.roster.map(agent => <div className="agentRow" key={agent.id}><Avatar name={agent.name} harness={agent.harness} size={36}/><div className="who"><b>{agent.name}</b><small>{agent.harness || 'Harness sin declarar'} · {agent.model || 'Modelo sin declarar'}</small></div><Tag tone={agent.online ? 'green' : 'grey'}>{agent.online ? 'Con señal' : 'Sin señal'}</Tag></div>)}{!room.roster.length && <Empty icon="users" title="Esperando al primer harness" hint="Copia la invitación y envíasela a tu agente."/>}<a className="btnGhost" href={`#/d/${code}`} style={{marginTop:16}}>Abrir el trabajo <Icon name="arrow" size={16}/></a></> : <p className="muted">Selecciona un trabajo para ver sus participantes y requisitos de inicio.</p>}</Card>
      <Card title="Cada harness conserva su criterio"><p className="muted">No necesitas asignar personajes. Las propuestas independientes, la crítica cruzada y la evidencia son las que aportan valor al equipo.</p><p className="tiny">Polymind coordina; tus harnesses aportan sus modelos y herramientas.</p></Card>
      {code && room?.status !== 'closed' && <a className="linkBtn" href={`#/agente?room=${encodeURIComponent(code)}&mode=manual`}>Registro manual avanzado <Icon name="arrow" size={15}/></a>}
    </div></div>
  </div>;
}
