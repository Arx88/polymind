// Suscripción en vivo: SSE con respaldo de sondeo. La sala se refresca sola.

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api';
import type { HallRoom, Room } from './types';

export function useRoomLive(code: string | null) {
  const [room, setRoom] = useState<Room | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [updatedAt, setUpdatedAt] = useState(0);
  const esRef = useRef<EventSource | null>(null);
  const lastEventRef = useRef(0);
  const closedRef = useRef(false);
  // La sala dejó de existir (la borró alguien): insistir con el sondeo no la va a traer de
  // vuelta, solo llena la consola de 404. Se dice una vez y se para.
  const goneRef = useRef(false);

  const load = useCallback(async () => {
    if (!code || goneRef.current) return;
    try {
      const out = await api.room(code);
      setRoom(out.room);
      setError(null);
      setUpdatedAt(Date.now());
      lastEventRef.current = Date.now();
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        goneRef.current = true;
        esRef.current?.close();
        esRef.current = null;
        setRoom(null);
        setConnected(false);
        setError('Esta sala ya no existe: se ha borrado.');
        return;
      }
      setError(err instanceof Error ? err.message : 'Error al cargar la sala');
    }
  }, [code]);

  // Sin dependencia: el vigilante solo necesita saber si la sala ya cerró, y eso no puede
  // volver a montar el SSE cada vez que cambia de fase.
  useEffect(() => { closedRef.current = !room || room.status === 'closed'; }, [room]);

  useEffect(() => {
    goneRef.current = false;
    if (!code) { setRoom(null); return; }
    let cancelled = false;
    let poll: number | undefined;
    load();

    const startPolling = () => {
      if (poll !== undefined || cancelled || goneRef.current) return;
      poll = window.setInterval(() => {
        if (goneRef.current) { window.clearInterval(poll); poll = undefined; return; }
        load();
      }, 3000);
    };

    try {
      const es = new EventSource(`/api/rooms/${code}/stream`);
      esRef.current = es;
      es.onopen = () => { setConnected(true); if (poll) { window.clearInterval(poll); poll = undefined; } };
      es.onmessage = ev => {
        try {
          const data = JSON.parse(ev.data) as { type: string; room: Room };
          lastEventRef.current = Date.now();
          if (data.type === 'update' && !cancelled) { setRoom(data.room); setUpdatedAt(Date.now()); }
        } catch { /* mensaje ilegible: se ignora */ }
      };
      es.onerror = () => { setConnected(false); startPolling(); };
    } catch {
      startPolling();
    }

    // Red de seguridad: hay proxies (Vite en modo dev, túneles) que dejan el SSE «abierto»
    // sin entregar nada. Sin esto, la sala se quedaba congelada y había que recargar a mano.
    // Si el flujo lleva un rato sin dar señales, se refresca por HTTP, y si se acumulan dos
    // avisos seguidos, se pasa a sondeo y se suelta el SSE (que ya no sirve de nada).
    const watchdog = window.setInterval(() => {
      if (cancelled || goneRef.current) return;
      const quietFor = Date.now() - (lastEventRef.current || 0);
      if (closedRef.current || quietFor < 8000) return;
      load();
      if (quietFor > 20_000) { setConnected(false); startPolling(); }
    }, 4000);

    return () => {
      cancelled = true;
      esRef.current?.close();
      esRef.current = null;
      window.clearInterval(watchdog);
      if (poll) window.clearInterval(poll);
      setConnected(false);
    };
  }, [code, load]);

  return { room, error, connected, updatedAt, refresh: load };
}

export function useHall(intervalMs = 4000) {
  const [rooms, setRooms] = useState<HallRoom[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const out = await api.hall();
      setRooms(out.rooms);
      setError(null);
    } catch {
      setError('No se pudo actualizar la lista. Comprueba que el servidor está conectado y pulsa Actualizar.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = window.setInterval(load, intervalMs);
    return () => window.clearInterval(t);
  }, [load, intervalMs]);

  return { rooms, loading, error, refresh: load };
}

// Tic para cuentas atrás (una vez por segundo, solo cuando hay plazo).
export function useTick(active: boolean) {
  const [, setN] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = window.setInterval(() => setN(n => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [active]);
}
