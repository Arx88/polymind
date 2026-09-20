// Cliente HTTP de la interfaz. Sin dependencias: fetch nativo.

import type {
  AgentMeta, CreateRoomResponse, HallRoom, JoinResponse, Meta, PreviewInfo, Room, RoomConfig, SnippetBundle, Template, Tournament,
} from './types';

export class ApiError extends Error {
  code: string;
  status: number;
  constructor(message: string, code = 'error', status = 0) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

async function req<T>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw new ApiError('No se pudo contactar con el servidor de AGORA.', 'network', 0);
  }
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  const obj = (data ?? {}) as Record<string, unknown>;
  if (!res.ok || obj.ok === false) {
    throw new ApiError(
      typeof obj.message === 'string' ? obj.message : `Error HTTP ${res.status}`,
      typeof obj.error === 'string' ? obj.error : 'error',
      res.status,
    );
  }
  return obj as T;
}

export const api = {
  health: () => req<{ ok: true; rooms: number; waiters: number; subscribers: number; uptimeSec: number }>('/api/health'),
  hall: () => req<{ ok: true; rooms: HallRoom[] }>('/api/hall'),
  meta: () => req<{ ok: true } & Meta>('/api/meta'),
  templates: () => req<{ ok: true; templates: Template[] }>('/api/templates'),
  agents: () => req<{ ok: true; agents: AgentMeta[] }>('/api/agents'),
  room: (code: string) => req<{ ok: true; room: Room }>(`/api/rooms/${code}/public`),
  // Qué se puede previsualizar del trabajo de la sala (y por qué no, si no se puede).
  preview: (code: string) => req<{ ok: true; preview: PreviewInfo }>(`/api/rooms/${code}/preview`),
  // La configuración completa de una sala (con el prompt listo para pegar en los agentes) y
  // su guardado como plantilla reutilizable.
  roomConfig: (code: string) => req<{ ok: true; config: RoomConfig }>(`/api/rooms/${code}/config`),
  saveRoomTemplate: (code: string, body: Record<string, unknown>) =>
    req<{ ok: true; template: Template; templates: Template[] }>(`/api/rooms/${code}/template`, { method: 'POST', body }),
  createRoom: (body: Record<string, unknown>) => req<CreateRoomResponse>('/api/rooms', { method: 'POST', body }),
  join: (code: string, body: Record<string, unknown>) => req<JoinResponse>(`/api/rooms/${code}/join`, { method: 'POST', body }),
  move: (code: string, body: Record<string, unknown>) =>
    req<{ ok: true; warnings: string[]; turn: { action: string; message?: string } }>(`/api/rooms/${code}/move`, { method: 'POST', body }),
  admin: (code: string, body: Record<string, unknown>) => req<{ ok: true; room: Room }>(`/api/rooms/${code}/admin`, { method: 'POST', body }),
  snippets: (harness: string, code: string) => req<{ ok: true } & SnippetBundle>(`/api/snippets?harness=${encodeURIComponent(harness)}&room=${encodeURIComponent(code)}`),
  tournaments: () => req<{ ok: true; tournaments: Tournament[] }>('/api/tournaments'),
  createTournament: (body: Record<string, unknown>) =>
    req<{ ok: true; id: string; rooms: { code: string; angle: string; url: string }[]; adminToken: string }>('/api/tournaments', { method: 'POST', body }),
  exportUrl: (code: string) => `/api/rooms/${code}/export.md`,
  bootstrapUrl: (code: string) => `/r/${code}`,
};

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}
