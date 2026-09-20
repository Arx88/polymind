import { FormEvent, useMemo, useState } from 'react';
import { Icon } from './Icons';
import { navigate } from '../lib/router';
import type { HallRoom } from '../lib/types';

const SECTION_LABELS: Record<string, string> = {
  debates: 'Debates',
  room: 'Sala',
  nuevo: 'Nuevo debate',
  agentes: 'Agentes',
  agente: 'Conectar agente',
  plantillas: 'Plantillas',
  resultados: 'Resultados',
  ajustes: 'Ajustes',
};

export function Topbar({ rooms, active }: { rooms: HallRoom[]; active: string }) {
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(false);
  const normalized = query.trim().toLocaleLowerCase();
  const matches = useMemo(() => {
    if (!normalized) return [];
    return rooms
      .filter(room => `${room.code} ${room.title} ${room.task}`.toLocaleLowerCase().includes(normalized))
      .slice(0, 5);
  }, [normalized, rooms]);

  function openRoom(code: string) {
    setQuery('');
    setFocused(false);
    navigate(`#/d/${code}`);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (matches[0]) openRoom(matches[0].code);
  }

  return (
    <header className="topbar">
      <div className="topbarContext">
        <span className="topbarEyebrow">Polymind</span>
        <b>{SECTION_LABELS[active] || 'Espacio de decisión'}</b>
      </div>

      <form className="globalSearch" role="search" onSubmit={submit}>
        <Icon name="search" size={18} />
        <input
          aria-label="Buscar debates por título, tarea o código"
          placeholder="Buscar debates, salas o resultados…"
          value={query}
          onChange={event => setQuery(event.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => window.setTimeout(() => setFocused(false), 120)}
          onKeyDown={event => { if (event.key === 'Escape') event.currentTarget.blur(); }}
        />
        {query && (
          <button type="button" className="searchClear" onClick={() => setQuery('')} aria-label="Limpiar búsqueda">
            ×
          </button>
        )}
        {focused && normalized && (
          <div className="searchResults" role="listbox" aria-label="Debates encontrados">
            {matches.length ? matches.map(room => (
              <button key={room.code} type="button" onMouseDown={event => event.preventDefault()} onClick={() => openRoom(room.code)} role="option">
                <span className="searchResultIcon"><Icon name={room.status === 'closed' ? 'check' : 'chat'} size={15} /></span>
                <span>
                  <b>{room.title || room.task}</b>
                  <small>{room.code} · {room.status === 'closed' ? 'resultado congelado' : 'debate abierto'}</small>
                </span>
                <Icon name="arrow" size={15} />
              </button>
            )) : (
              <div className="searchEmpty">No hay debates que coincidan.</div>
            )}
          </div>
        )}
      </form>

      <a className="topbarSettings" href="#/ajustes"><Icon name="gear" size={20} /> Ajustes</a>
    </header>
  );
}
