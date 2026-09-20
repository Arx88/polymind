// Primitivas compartidas: tarjetas, vacíos, etiquetas, copiar y modal.

import { useState, type ReactNode } from 'react';
import { copyText } from '../lib/api';
import { Icon, type IconName } from './Icons';

export function Card({ title, action, children, pad = true, head }: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  pad?: boolean;
  head?: ReactNode;
}) {
  return (
    <section className="card">
      {(title || action || head) && (
        <div className="cardHead">
          {typeof title === 'string' ? <h3>{title}</h3> : title}
          <span className="spacer" />
          {action}
        </div>
      )}
      <div className={pad ? 'cardBody' : undefined}>{children}</div>
      {head}
    </section>
  );
}

export function Empty({ icon = 'chat', title, hint }: { icon?: IconName; title: string; hint?: string }) {
  return (
    <div className="empty">
      <div className="big"><Icon name={icon} size={32} /></div>
      <b>{title}</b>
      {hint && <p className="tiny" style={{ marginTop: 6 }}>{hint}</p>}
    </div>
  );
}

export function Tag({ tone = 'grey', children }: { tone?: 'grey' | 'blue' | 'green' | 'amber' | 'red' | 'purple'; children: ReactNode }) {
  return <span className={`tag ${tone}`}>{children}</span>;
}

export function Bar({ value }: { value: number }) {
  return (
    <div className="bar">
      <i style={{ width: `${Math.max(2, Math.min(100, Math.round(value * 100)))}%` }} />
    </div>
  );
}

export function CopyButton({ text, label = 'Copiar', ghost = false }: { text: string; label?: string; ghost?: boolean }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className={`copyBtn${ghost ? ' ghost' : ''}`}
      onClick={async () => {
        const ok = await copyText(text);
        setDone(ok);
        window.setTimeout(() => setDone(false), 1600);
      }}
    >
      {done ? '¡Copiado!' : label}
    </button>
  );
}

export function Modal({ open, onClose, title, children }: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  if (!open) return null;
  return (
    <div className="modalBack" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="cardHead">
          <h3>{title}</h3>
          <span className="spacer" />
          <button className="btnGhost btnMini" onClick={onClose}>Cerrar</button>
        </div>
        <div className="cardBody">{children}</div>
      </div>
    </div>
  );
}

export function Note({ children }: { children: ReactNode }) {
  return (
    <div className="note">
      <Icon name="info" size={17} />
      <div>{children}</div>
    </div>
  );
}

export function Loading({ label = 'Cargando…' }: { label?: string }) {
  return <div className="empty"><p className="muted">{label}</p></div>;
}

export function ErrorBox({ message, title = 'No se pudo completar la acción' }: { message: string; title?: string }) {
  return (
      <div className="card pad" role="alert" style={{ borderColor: '#fecaca', background: 'var(--red-soft)' }}>
      <div className="row">
        <Icon name="info" size={18} />
        <div>
            <b>{title}</b>
          <div className="tiny" style={{ color: 'var(--red)' }}>{message}</div>
        </div>
      </div>
    </div>
  );
}
