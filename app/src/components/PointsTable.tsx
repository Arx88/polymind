// Puntos de decisión: la tabla que convierte el debate en algo verificable.
// Cada fila es un punto de la agenda con su estado real de consenso.

import { Avatar } from './Avatar';
import { Empty } from './Ui';
import { POINT_STATUS_CLASS, POINT_STATUS_LABEL, pct0 } from '../lib/format';
import type { AgendaPoint } from '../lib/types';

const POINT_ICON_COLORS = ['#2563eb', '#16a34a', '#f59e0b', '#7c3aed', '#0891b2', '#db2777', '#65a30d'];

export function PointsTable({ points, compact = false }: { points: AgendaPoint[]; compact?: boolean }) {
  if (!points.length) {
    return (
      <Empty
        icon="target"
        title="Sin agenda de decisión"
        hint="Esta sala no declaró puntos de decisión: el consenso se calcula sobre las votaciones."
      />
    );
  }
  return (
    <table className="points">
      <tbody>
        {points.map((point, i) => (
          <tr key={point.id}>
            <td style={{ width: 42 }}>
              <span className="ic" style={{ background: POINT_ICON_COLORS[i % POINT_ICON_COLORS.length] }}>
                {point.label.slice(0, 2).toUpperCase()}
              </span>
            </td>
            <td>
              <b>{point.label}</b>
              {/* Un eje impugnado en el contraste se debate sabiendo que se discute su propia
                  existencia: quien se posiciona ahí tiene derecho a saberlo. */}
              {point.contested && (
                <span
                  className="dissentPerson lose"
                  style={{ marginLeft: 6 }}
                  title={`Impugnado por ${(point.challenged || []).map(c => c.by).join(', ') || '—'}`}
                >
                  eje impugnado
                </span>
              )}
              {!!point.mergedFrom?.length && (
                <span className="dissentPerson" style={{ marginLeft: 6 }} title={`Absorbió: ${point.mergedFrom.map(m => m.label).join(', ')}`}>
                  fusionado con {point.mergedFrom.map(m => m.label).join(', ')}
                </span>
              )}
              <small>
                {point.modal
                  ? <>Mayoritaria: <b style={{ color: 'var(--ink)' }}>{point.modal.label}</b> · {point.voters} de {point.voters + point.abstain} con posición</>
                  : 'Nadie se ha posicionado todavía'}
              </small>
              {!compact && point.choices.length > 1 && (
                <div className="choices">
                  {point.choices.map(choice => (
                    <span key={choice.id} className={`choicePill${point.modal?.id === choice.id ? ' win' : ''}`} title={choice.agents.join(', ')}>
                      {choice.label} · {choice.count}
                    </span>
                  ))}
                </div>
              )}
            </td>
            {!compact && (
              <td style={{ width: 150 }}>
                <div className="choices">
                  {point.modal && point.modal.agents.slice(0, 3).map((agent, idx) => (
                    <Avatar key={`${agent}-${idx}`} name={agent} size={22} />
                  ))}
                </div>
              </td>
            )}
            <td style={{ width: 132, textAlign: 'right' }}>
              <span className={`stChip ${POINT_STATUS_CLASS[point.status]}`}>
                {point.status === 'agreed' ? <IconCheck /> : point.status === 'pending' ? null : <IconClock />}
                {POINT_STATUS_LABEL[point.status]}{point.voters ? ` (${pct0(point.share)})` : ''}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function IconCheck() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function IconClock() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}
