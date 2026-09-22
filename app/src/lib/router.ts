// Enrutador mínimo por hash: sin dependencias y compatible con el servidor
// estático (cualquier ruta la resuelve el propio index.html).

import { useEffect, useState } from 'react';

export interface Route {
  key: 'landing' | 'debates' | 'nuevo' | 'room' | 'agentes' | 'agente' | 'plantillas' | 'resultados' | 'ajustes';
  params: string[];
  query: URLSearchParams;
  raw: string;
}

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#\/?/, '');
  const [pathPart, queryPart] = raw.split('?');
  const parts = pathPart.split('/').filter(Boolean);
  const query = new URLSearchParams(queryPart || '');
  const head = parts[0] || '';
  switch (head) {
    case 'trabajos':
      return { key: 'debates', params: [], query, raw };
    case 'inicio':
      return { key: 'landing', params: [], query, raw };
    case 'd':
      return { key: 'room', params: [parts[1] || ''], query, raw };
    case 'nuevo':
      return { key: 'nuevo', params: parts.slice(1), query, raw };
    case 'agentes':
      return { key: 'agentes', params: [], query, raw };
    case 'agente':
      return { key: 'agente', params: [], query, raw };
    case 'plantillas':
      return { key: 'plantillas', params: [], query, raw };
    case 'resultados':
      return { key: 'resultados', params: [], query, raw };
    case 'ajustes':
      return { key: 'ajustes', params: [], query, raw };
    default:
      return { key: 'landing', params: [], query, raw };
  }
}

export function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export function navigate(hash: string) {
  if (window.location.hash === hash) return;
  window.location.hash = hash;
  window.scrollTo({ top: 0 });
}

// Guarda el token de administración de las salas creadas desde este navegador.
const ADMIN_KEY = 'agora.admin';

export function rememberAdmin(code: string, adminToken: string) {
  try {
    const map = JSON.parse(sessionStorage.getItem(ADMIN_KEY) || '{}') as Record<string, string>;
    map[code] = adminToken;
    sessionStorage.setItem(ADMIN_KEY, JSON.stringify(map));
  } catch { /* sesión sin almacenamiento */ }
}

export function adminOf(code: string): string | null {
  try {
    const map = JSON.parse(sessionStorage.getItem(ADMIN_KEY) || '{}') as Record<string, string>;
    return map[code] || null;
  } catch {
    return null;
  }
}

const AGENT_KEY = 'agora.agent.';

export function rememberAgent(code: string, agentId: string, token: string) {
  try {
    sessionStorage.setItem(AGENT_KEY + code, JSON.stringify({ agentId, token }));
  } catch { /* sesión sin almacenamiento */ }
}

export function agentOf(code: string): { agentId: string; token: string } | null {
  try {
    const raw = sessionStorage.getItem(AGENT_KEY + code);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
