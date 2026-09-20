// La plataforma no recorta lo que escribe un agente, así que aquí llegan planes y
// objeciones que pueden ser largos de verdad. Eso no puede convertirse en una página
// interminable: se muestra el principio con la cifra exacta a la vista y el texto entero
// a un clic. El contenido nunca se pierde; simplemente no se despliega todo de golpe.

import { useMemo, useState } from 'react';

export function LongText({
  text, lines = 16, className, label = 'texto',
}: { text: string; lines?: number; className?: string; label?: string }) {
  const [open, setOpen] = useState(false);
  const value = String(text ?? '');
  const parts = useMemo(() => {
    const all = value.split('\n');
    return {
      total: all.length,
      head: all.slice(0, lines).join('\n'),
      hidden: Math.max(0, all.length - lines),
    };
  }, [value, lines]);

  if (parts.hidden === 0) return <pre className={className}>{value}</pre>;

  // Plegado no lleva scroll interno; desplegado se limita a la ventana (ver .longText).
  const cls = [className, open ? 'longTextOpen' : 'longText'].filter(Boolean).join(' ');
  return (
    <>
      <pre className={cls}>{open ? value : `${parts.head}\n…`}</pre>
      <button className="linkBtn" onClick={() => setOpen(o => !o)}>
        {open ? `Contraer ${label}` : `Ver ${label} completo (${parts.total} líneas)`}
      </button>
    </>
  );
}
