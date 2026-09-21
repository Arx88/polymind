import { useMemo, useState } from 'react';
import type { HallRoom } from '../lib/types';
import { PHASE_LABEL, timeAgo } from '../lib/format';
import { Icon } from '../components/Icons';
import { Empty, ErrorBox, Loading } from '../components/Ui';
import { DeleteWorkButton } from '../components/DeleteWork';

type Filter = 'all' | 'active' | 'waiting' | 'closed';
export function Workspace({ rooms, loading, error, onRefresh }: { rooms: HallRoom[]; loading: boolean; error: string | null; onRefresh: () => void }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(12);
  const counts = { all: rooms.length, active: rooms.filter(r => r.status === 'debate').length, waiting: rooms.filter(r => r.status === 'lobby').length, closed: rooms.filter(r => r.status === 'closed').length };
  const filtered = useMemo(() => rooms.filter(r => (filter === 'all' || (filter === 'active' ? r.status === 'debate' : filter === 'waiting' ? r.status === 'lobby' : r.status === 'closed')) && `${r.title} ${r.task} ${r.code}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())).sort((a,b) => Number(a.status === 'closed') - Number(b.status === 'closed') || b.createdAt - a.createdAt), [rooms, filter, query]);
  return <div className="workspacePage">
    <section className="workspaceHero">
      <div className="workspaceHeroCopy"><span className="eyebrow">TU ESPACIO DE COLABORACIÓN</span><h1>Distintas mentes.<br/><span>Resultados que importan.</span></h1><p>Reúne tus harnesses, contrasta sus propuestas y lleva las mejores ideas a una entrega verificable.</p><a className="btnBlue" href="#/nuevo"><Icon name="plus" size={19}/> Crear un trabajo</a></div>
      <img src="/images/polymind-minds.png" alt="" width="1536" height="1024" />
    </section>
    <div className="workspaceMetrics" aria-label="Estado de los trabajos">
      <button onClick={() => { setFilter('active'); setLimit(12); }}><span className="metricIcon"><Icon name="bolt"/></span><span><strong>{counts.active}</strong><small>En marcha</small></span><Icon name="arrow" size={17}/></button>
      <button onClick={() => { setFilter('waiting'); setLimit(12); }}><span className="metricIcon violet"><Icon name="users"/></span><span><strong>{counts.waiting}</strong><small>Esperando agentes</small></span><Icon name="arrow" size={17}/></button>
      <button onClick={() => { setFilter('closed'); setLimit(12); }}><span className="metricIcon mint"><Icon name="doc"/></span><span><strong>{counts.closed}</strong><small>Trabajos cerrados</small></span><Icon name="arrow" size={17}/></button>
    </div>
    <section className="workspaceCollection">
      <div className="collectionHeading"><div><h2>Tus trabajos</h2><p>Del objetivo a la entrega, sin perder el contexto.</p></div><button className="btnGhost" onClick={onRefresh} aria-label="Actualizar trabajos"><Icon name="refresh" size={18}/></button></div>
      <div className="collectionToolbar"><div className="filterGroup" aria-label="Filtrar trabajos">{([['all','Todos'],['active','En marcha'],['waiting','En espera'],['closed','Cerrados']] as const).map(([key,label]) => <button key={key} aria-pressed={filter === key} onClick={() => { setFilter(key); setLimit(12); }}>{label}<span>{counts[key]}</span></button>)}</div><label className="collectionSearch"><Icon name="search" size={18}/><input aria-label="Filtrar por título, objetivo o código" placeholder="Buscar un trabajo…" value={query} onChange={e => { setQuery(e.target.value); setLimit(12); }}/></label></div>
      {error && <ErrorBox message={error}/>}
      {loading ? <Loading label="Cargando trabajos…"/> : filtered.length ? <div className="workGrid">{filtered.slice(0,limit).map(room => <a key={room.code} className="workTile" href={`#/d/${room.code}`}>
        <div className="workTileTop"><span className={`metricIcon ${room.repo ? 'violet' : ''}`}><Icon name={room.repo ? 'code' : 'chat'} size={21}/></span><span className={`workState ${room.status}`}>{room.status === 'lobby' ? 'Esperando agentes' : room.status === 'debate' ? (PHASE_LABEL[room.phase] || room.phase) : room.outcome === 'decided' ? 'Decisión disponible' : 'Cerrado sin decisión'}</span></div>
        <h3>{room.title}</h3><p>{room.task}</p>
        {room.work && <div className="workProgress"><span>{room.work.integrated} de {room.work.items} mejoras integradas</span><progress value={room.work.integrated} max={Math.max(1,room.work.items)} aria-label="Mejoras integradas"/></div>}
        <div className="workTileBottom"><span><Icon name="users" size={15}/>{room.agents} agentes</span><span>{timeAgo(room.createdAt)}</span><DeleteWorkButton code={room.code} onDeleted={onRefresh}/><Icon name="arrow" size={17}/></div>
      </a>)}</div> : <Empty icon="search" title={query || filter !== 'all' ? 'No hay trabajos con este filtro' : 'Tu primer gran resultado empieza aquí'} hint={query || filter !== 'all' ? 'Prueba otro término o selecciona Todos.' : 'Crea un trabajo y conecta tus harnesses para empezar.'}/>}
      {filtered.length > limit && <button className="btnGhost collectionMore" onClick={() => setLimit(n => n+12)}>Mostrar más trabajos ({filtered.length-limit} restantes)</button>}
    </section>
    <aside className="workspacePrinciple"><Icon name="shield" size={23}/><p><b>El acuerdo no sustituye a la evidencia.</b> Polymind conserva las objeciones y distingue los planes de las comprobaciones ejecutadas.</p><a href="#/agente">Conectar un harness <Icon name="arrow" size={16}/></a></aside>
  </div>;
}
