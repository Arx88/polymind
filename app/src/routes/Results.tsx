// Resultados: histórico de debates cerrados, con su plan congelado y su checksum.

import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { navigate } from '../lib/router';
import { OUTCOME_LABEL, pct0, plural, timeAgo } from '../lib/format';
import type { HallRoom, Room, Tournament } from '../lib/types';
import { Card, Empty, ErrorBox, Loading, Tag } from '../components/Ui';
import { ResultCard } from '../components/ResultCard';
import { RoomConfigCard } from '../components/RoomConfigCard';
import { Icon } from '../components/Icons';
import { adminOf } from '../lib/router';

export function Results({ rooms }: { rooms: HallRoom[] }) {
  const closed = rooms.filter(r => r.status === 'closed');
  const [selected, setSelected] = useState<string | null>(null);
  const [room, setRoom] = useState<Room | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tournaments, setTournaments] = useState<Tournament[]>([]);

  useEffect(() => {
    if (!selected && closed.length) setSelected(closed[0].code);
  }, [closed, selected]);

  useEffect(() => {
    if (!selected) return;
    let alive = true;
    setRoom(null);
    setError(null);
    api.room(selected).then(out => { if (alive) { setRoom(out.room); setError(null); } })
      .catch(err => { if (alive) setError(err.message); });
    return () => { alive = false; };
  }, [selected]);

  useEffect(() => {
    api.tournaments().then(out => setTournaments(out.tournaments)).catch(() => setTournaments([]));
  }, [selected]);

  return (
    <div className="wide">
      <div className="pageHead">
        <div>
          <h1>Resultados</h1>
          <p>Plan final, comprobaciones, consenso por punto, disenso y checksum de cada debate cerrado.</p>
        </div>
      </div>

      {error && <ErrorBox message={error} />}

      <div className="layoutTwo">
        <div className="col">
          {!selected ? (
            <Card><Empty icon="chart" title="Aún no hay debates cerrados" hint="Los resultados aparecen aquí al cerrarse el debate." /></Card>
          ) : room ? (
            <ResultCard room={room} />
          ) : (
            <Loading label="Cargando resultado…" />
          )}

          {/* La configuración entera de la sala, con su prompt y sus reglas: desde aquí se
              vuelve a abrir un debate con ella o se guarda como plantilla. */}
          {room && <RoomConfigCard code={room.code} adminToken={adminOf(room.code)} />}

          {room?.status === 'closed' && (
            <Card title="Volver a mirar el debate">
              <div className="row wrap">
                <button className="btnGhost" onClick={() => navigate(`#/d/${room.code}`)}>
                  <Icon name="chat" size={15} /> Abrir la sala completa
                </button>
                <a className="btnGhost" href={`/api/rooms/${room.code}/export.md`} target="_blank" rel="noreferrer">
                  <Icon name="download" size={15} /> Descargar markdown
                </a>
                <a className="btnGhost" href={`/r/${room.code}`} target="_blank" rel="noreferrer">
                  <Icon name="link" size={15} /> Bootstrap para agentes
                </a>
              </div>
              <p className="tiny" style={{ marginTop: 10 }}>
                El checksum identifica exactamente la versión del resultado que vieron los agentes:
                sirve para detectar cualquier divergencia.
              </p>
            </Card>
          )}
        </div>

        <div className="col">
          <Card title={`Debates cerrados (${closed.length})`}>
            {closed.length === 0
              ? <Empty icon="doc" title="Sin histórico" />
              : closed.map(item => (
                <button
                  type="button"
                  key={item.code}
                  className="agentRow"
                  aria-pressed={selected === item.code}
                  style={{ cursor: 'pointer' }}
                  onClick={() => setSelected(item.code)}
                >
                  <div className="who">
                    <b>{item.title}</b>
                    <small>
                      {timeAgo(item.createdAt)} · {plural(item.agents, 'agente')} · {item.durationMin} min ·{' '}
                      {item.outcome === 'decided' ? `consenso ${pct0(item.consensus)}` : (OUTCOME_LABEL[item.outcome || ''] || 'cerrado')}
                    </small>
                  </div>
                  {/* Reabrir sin salir del histórico: hereda toda la configuración de esa
                      sala (tarea, agenda, reglas y repo) en el formulario. */}
                  <button
                    className="btnGhost btnMini"
                    title="Reabrir con esta configuración"
                    onClick={e => { e.stopPropagation(); navigate(`#/nuevo?from=${item.code}`); }}
                  >
                    <Icon name="refresh" size={14} /> reabrir
                  </button>
                  {selected === item.code && <Tag tone="blue">viendo</Tag>}
                  <span className={`st ${item.outcome === 'decided' ? '' : 'warn'}`}>
                    <i className={`dot ${item.outcome === 'decided' ? '' : 'off'}`} />
                    {item.outcome === 'decided' ? 'decidido' : (OUTCOME_LABEL[item.outcome || ''] || 'cerrado')}
                  </span>
                </button>
              ))}
          </Card>

          {tournaments.length > 0 && (
            <Card title="Torneos">
              {tournaments.map(tournament => (
                <div key={tournament.id} className="agentRow">
                  <div className="who">
                    <b>{tournament.title}</b>
                    <small>{plural(tournament.rooms.length, 'sala')} · {timeAgo(tournament.createdAt)}</small>
                  </div>
                  <Tag tone={tournament.status === 'closed' ? 'green' : tournament.status === 'final' ? 'blue' : 'amber'}>
                    {tournament.status === 'open' ? 'ronda 1' : tournament.status === 'final' ? 'final' : 'cerrado'}
                  </Tag>
                </div>
              ))}
              <p className="tiny" style={{ marginTop: 8 }}>
                Cada torneo debate la misma tarea desde tres ángulos y enfrenta después los ganadores.
              </p>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
