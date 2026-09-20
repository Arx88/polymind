import { Sidebar } from './components/Sidebar';
import { Topbar } from './components/Topbar';
import { useHall } from './lib/live';
import { useHashRoute } from './lib/router';
import { Workspace } from './routes/Workspace';
import { NewDebate } from './routes/NewDebate';
import { Room } from './routes/Room';
import { Agents } from './routes/Agents';
import { HarnessConnect } from './routes/HarnessConnect';
import { Templates } from './routes/Templates';
import { Results } from './routes/Results';
import { Settings } from './routes/Settings';

export function App() {
  const route = useHashRoute();
  const { rooms, loading, error, refresh } = useHall(5000);

  const activeNav = route.key === 'room' ? 'debates' : route.key;
  const counts: Record<string, number> = {
    debates: rooms.filter(r => r.status !== 'closed').length,
    resultados: rooms.filter(r => r.status === 'closed').length,
  };

  return (
    <div className="shell">
      <a className="skipLink" href="#main-content" onClick={event => { event.preventDefault(); document.getElementById('main-content')?.focus(); }}>Saltar al contenido</a>
      <Sidebar active={activeNav} counts={counts} />
      <div className="workspace">
        <Topbar rooms={rooms} active={activeNav} />
        <main className="main" id="main-content" tabIndex={-1}>
          {route.key === 'debates' && <Workspace rooms={rooms} loading={loading} error={error} onRefresh={refresh} />}
          {route.key === 'nuevo' && <NewDebate key={route.raw} query={route.query} />}
          {route.key === 'room' && <Room key={route.params[0]} code={route.params[0]} onChanged={refresh} />}
          {route.key === 'agentes' && <Agents />}
          {route.key === 'agente' && <HarnessConnect key={route.raw} query={route.query} rooms={rooms} />}
          {route.key === 'plantillas' && <Templates />}
          {route.key === 'resultados' && <Results rooms={rooms} />}
          {route.key === 'ajustes' && <Settings />}
        </main>
      </div>
    </div>
  );
}
