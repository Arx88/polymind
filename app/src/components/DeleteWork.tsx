// Borrar un trabajo: definitivo, así que el botón no borra nada por sí solo. Abre una
// confirmación que pide el código de la sala (el mismo trato que un borrado de verdad, no un
// clic afortunado) y respeta a quien esté dentro: si hay agentes con señal reciente, el servidor
// lo dice y hay que insistir a propósito.

import { useState } from 'react';
import { createPortal } from 'react-dom';
import { api, ApiError } from '../lib/api';
import { adminOf, rememberAdmin } from '../lib/router';
import { Icon } from './Icons';
import { Modal, Note } from './Ui';

export function DeleteWorkButton({ code, label = 'Borrar este trabajo', full = false, onDeleted }: {
  code: string;
  label?: string;
  full?: boolean;
  onDeleted?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [canForce, setCanForce] = useState(false);
  // El token se guarda en la sesión del navegador que creó la sala. Si esta sesión no lo tiene
  // (otro equipo, otra sesión cerrada), se puede pegar aquí: sin él no hay borrado posible, y
  // decir «no puedes» sin ofrecer la puerta sería mentir a medias.
  const [pasted, setPasted] = useState('');
  const token = adminOf(code) || pasted.trim();
  const confirmed = typed.trim().toLowerCase() === code.toLowerCase();

  function openDialog(e: React.MouseEvent) {
    // En la lista, la tarjeta entera es un enlace: el botón no debe navegar.
    e.preventDefault();
    e.stopPropagation();
    setTyped('');
    setPasted('');
    setError(null);
    setCanForce(false);
    setOpen(true);
  }

  async function remove(force: boolean) {
    if (!token) {
      setError('Falta el token de administración de la sala: pégalo para poder borrarla. Se guarda en la configuración de la sala y en el navegador donde la creaste.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.deleteRoom(code, { adminToken: token, op: 'delete', confirm: typed.trim().toLowerCase(), force });
      rememberAdmin(code, token); // la sala ya no está; el token sirve para lo que quede de la sesión
      setOpen(false);
      onDeleted?.();
    } catch (err) {
      setCanForce(err instanceof ApiError && err.code === 'busy');
      setError(err instanceof Error ? err.message : 'No se pudo borrar el trabajo');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className={`btnGhost btnDanger${full ? '' : ' btnMini'}`}
        title="Borrar este trabajo definitivamente"
        onClick={openDialog}
      >
        <Icon name="trash" size={full ? 15 : 14} />{full ? ` ${label}` : ''}
      </button>
      {/* Fuera del enlace de la tarjeta (en la lista, la tarjeta entera es un <a>): un modal
          dentro navegaría a la sala en cuanto se pulsara un botón. */}
      {createPortal(<Modal open={open} onClose={() => { if (!busy) setOpen(false); }} title={`Borrar el trabajo ${code}`}>
        <p style={{ fontSize: 13.5 }}>
          Se borra <b>definitivamente</b>: la sala, su registro, su repositorio de trabajo y su copia en la
          memoria durable. No se puede deshacer, y los agentes que esperen turno se sueltan.
        </p>
        <Note>
          Si el trabajo todavía importa, ciérralo en vez de borrarlo: el resultado queda congelado,
          consultable y con su checksum.
        </Note>
        <label className="tiny" style={{ display: 'block', marginTop: 12 }}>
          Escribe el código de la sala para confirmar
          <input
            autoFocus
            value={typed}
            placeholder={code}
            onChange={e => setTyped(e.target.value)}
            style={{ marginTop: 6, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
          />
        </label>
        {!adminOf(code) && (
          <label className="tiny" style={{ display: 'block', marginTop: 12 }}>
            Token de administración de la sala (el navegador donde la creaste lo guarda; también está
            en su configuración)
            <input
              value={pasted}
              placeholder="adminToken"
              onChange={e => setPasted(e.target.value)}
              style={{ marginTop: 6, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
            />
          </label>
        )}
        {error && <p className="tiny" style={{ color: 'var(--red)', marginTop: 10 }}>{error}</p>}
        <div className="row wrap" style={{ marginTop: 14 }}>
          <button className="btnGhost" disabled={busy} onClick={() => setOpen(false)}>Cancelar</button>
          {canForce && (
            <button className="btnGhost btnDanger" disabled={busy} onClick={() => void remove(true)}>
              Borrar de todas formas
            </button>
          )}
          <span className="spacer" />
          <button
            className="btnGhost btnDanger"
            disabled={busy || !token || !confirmed}
            onClick={() => void remove(false)}
          >
            <Icon name="trash" size={15} /> Borrar definitivamente
          </button>
        </div>
      </Modal>, document.body)}
    </>
  );
}
