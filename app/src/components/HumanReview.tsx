// El juicio humano, al final y SOLO sobre lo entregado.
//
// El reparto es deliberado: durante el trabajo juzgan los modelos que declararon la capacidad
// «vision» (miran las capturas del commit y firman, y lo que les falta se cuenta como obligación
// abierta). Acá, con la entrega congelada, decide quien recibe: aprueba tal como está, o pide
// cambios concretos — y cada pedido se convierte en una tarea y la sala vuelve a trabajar.
//
// El formulario no envía nada sin token de administración: aceptar una entrega no puede ser un clic
// anónimo.

import { useState } from 'react';
import { api, ApiError } from '../lib/api';
import { adminOf, rememberAdmin } from '../lib/router';
import { Icon } from './Icons';
import { Tag } from './Ui';
import { dateTime, plural } from '../lib/format';
import type { Room } from '../lib/types';

const REQUEST_STATUS_TONE: Record<string, 'green' | 'amber' | 'red' | 'grey'> = {
  atendido: 'green',
  'en-curso': 'amber',
  revertido: 'red',
  'sin-tarea': 'grey',
};

export function HumanReviewBlock({ room, onChanged }: { room: Room; onChanged?: () => void }) {
  const human = room.result?.humanReview || null;
  const delivered = room.status === 'closed' && !!room.result;
  const [pasted, setPasted] = useState('');
  const [verdict, setVerdict] = useState<'aprobado' | 'cambios'>('aprobado');
  const [reason, setReason] = useState('');
  const [requests, setRequests] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  if (!delivered) return null;
  const token = adminOf(room.code) || pasted.trim();
  const pedidos = requests.split('\n').map(t => t.trim()).filter(Boolean);

  async function send() {
    if (!token) {
      setError('Falta el token de administración de la sala: el navegador donde la creaste lo guarda, y también está en su configuración.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const out = await api.admin(room.code, {
        adminToken: token,
        op: 'human-review',
        verdict,
        reason,
        requests: verdict === 'cambios' ? pedidos : [],
      });
      rememberAdmin(room.code, token);
      const extra = (out as { reopened?: boolean; items?: string[] }).reopened
        ? ` La sala volvió al trabajo: ${((out as { items?: string[] }).items || []).join(', ')}.`
        : '';
      setSent(verdict === 'aprobado' ? `Entrega aprobada.${extra}` : `Cambios pedidos, convertidos en tareas.${extra}`);
      setRequests('');
      setReason('');
      onChanged?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err instanceof Error ? err.message : 'No se pudo registrar tu veredicto'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="obligations">
      <div className="row wrap" style={{ marginTop: 18, gap: 8 }}>
        <b className="resultSectionTitle" style={{ marginTop: 0 }}>
          <span className="sectionIcon"><Icon name="check" size={20} /></span>
          Revisión humana (al final)
        </b>
        <span className="spacer" />
        {human ? (
          <Tag tone={human.verdict === 'aprobado' ? 'green' : human.open.length ? 'red' : 'amber'}>
            {human.verdict === 'aprobado' ? 'aprobado' : 'cambios pedidos'}
          </Tag>
        ) : (
          <Tag tone="amber">sin veredicto humano</Tag>
        )}
      </div>
      <p className="tiny">
        Los modelos que declararon visión ya juzgaron las capturas durante el trabajo.
        Acá decide quien recibe, sobre lo <b>entregado</b>: aprobar, o pedir cambios concretos que la sala
        vuelve a ejecutar.
        {human ? ` ${human.note}` : ''}
      </p>

      {human && (
        <>
          <div className="tiny" style={{ marginTop: 4 }}>
            {human.by} · {dateTime(human.at)}
            {human.deliveredHead ? ` · sobre ${human.deliveredHead}` : ''}
            {human.deliveredChecksum ? ` · entrega ${String(human.deliveredChecksum).slice(0, 16)}` : ''}
            {human.rounds ? ` · ${plural(human.rounds, 'ronda')} de trabajo posterior` : ''}
            {human.shots.length ? ` · ${plural(human.shots.length, 'captura')} a la vista` : ''}
          </div>
          {human.requests.map(req => (
            <div className="agentRow" key={req.id}>
              <Tag tone={REQUEST_STATUS_TONE[req.status] || 'grey'}>{req.status}</Tag>
              <div className="who">
                <small style={{ whiteSpace: 'normal' }}>{req.text}</small>
                <small style={{ whiteSpace: 'normal' }}>{req.because}</small>
              </div>
            </div>
          ))}
          {human.history.length > 1 && (
            <details className="deliveryDetails">
              <summary>Veredictos anteriores <span>{human.history.length - 1}</span></summary>
              {human.history.slice(0, -1).reverse().map(h => (
                <div className="agentRow" key={h.id}>
                  <Tag tone={h.verdict === 'aprobado' ? 'green' : 'amber'}>{h.verdict}</Tag>
                  <div className="who">
                    <small style={{ whiteSpace: 'normal' }}>{h.by} · {dateTime(h.at)}{h.reopened ? ' · la sala volvió al trabajo' : ''}</small>
                    <small style={{ whiteSpace: 'normal' }}>{h.reason || h.requests.join(' · ') || 'sin motivo escrito'}</small>
                  </div>
                </div>
              ))}
            </details>
          )}
        </>
      )}

      {sent && <p className="tiny" style={{ color: 'var(--green, #15803d)' }}>{sent}</p>}

      {!open ? (
        <div className="row wrap" style={{ marginTop: 10 }}>
          <button className="btnGhost btnMini" type="button" onClick={() => setOpen(true)}>
            <Icon name="check" size={14} /> {human ? 'Firmar otro veredicto' : 'Juzgar la entrega'}
          </button>
        </div>
      ) : (
        <div style={{ marginTop: 10 }}>
          <div className="row wrap" style={{ gap: 8 }}>
            <button
              type="button"
              className={verdict === 'aprobado' ? 'btnGhost btnMini' : 'btnGhost btnMini muted'}
              onClick={() => setVerdict('aprobado')}
            >
              {verdict === 'aprobado' ? '● ' : ''}Aprobar
            </button>
            <button
              type="button"
              className={verdict === 'cambios' ? 'btnGhost btnMini' : 'btnGhost btnMini muted'}
              onClick={() => setVerdict('cambios')}
            >
              {verdict === 'cambios' ? '● ' : ''}Pedir cambios
            </button>
          </div>
          {verdict === 'cambios' && (
            <label className="tiny" style={{ display: 'block', marginTop: 10 }}>
              Qué cambiar (una petición por línea; cada una se convierte en una tarea)
              <textarea
                value={requests}
                rows={3}
                placeholder={'El casco se pierde contra el agua a 200 m: subir la luz de contorno.\nLa espuma no se lee: endurecer el contraste del mar.'}
                onChange={e => setRequests(e.target.value)}
                style={{ marginTop: 6, width: '100%', fontFamily: 'inherit' }}
              />
            </label>
          )}
          <label className="tiny" style={{ display: 'block', marginTop: 8 }}>
            Por qué (queda en el acta)
            <input value={reason} onChange={e => setReason(e.target.value)} style={{ marginTop: 6, width: '100%' }} />
          </label>
          {!adminOf(room.code) && (
            <label className="tiny" style={{ display: 'block', marginTop: 8 }}>
              Token de administración de la sala
              <input
                value={pasted}
                placeholder="adminToken"
                onChange={e => setPasted(e.target.value)}
                style={{ marginTop: 6, width: '100%', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
              />
            </label>
          )}
          {error && <p className="tiny" style={{ color: 'var(--red, #b91c1c)', marginTop: 8 }}>{error}</p>}
          <div className="row wrap" style={{ marginTop: 10 }}>
            <button className="btnGhost btnMini" type="button" disabled={busy} onClick={() => setOpen(false)}>Cancelar</button>
            <span className="spacer" />
            <button
              className="btnGhost btnMini"
              type="button"
              disabled={busy || !token || (verdict === 'cambios' && pedidos.length === 0)}
              onClick={() => void send()}
            >
              {busy ? 'Enviando…' : verdict === 'aprobado' ? 'Aprobar la entrega' : `Pedir ${pedidos.length || ''} cambio(s)`}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
