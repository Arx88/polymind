// Disenso protegido: la parte del debate que un porcentaje de consenso esconde.
//
// Un debate que converge de más deja de aportar. Aquí se ve, con nombres y sin adjetivos:
// qué puntos llegaron con minoría real y quién la sostiene, qué se resolvió por autoridad
// de síntesis (sin dato nuevo), qué posiciones se movieron sin decir por qué, y si las
// propuestas llegaron casi idénticas a la votación. Nada de esto es una opinión: sale del
// recuento exacto de posiciones y votos que ya hizo el servidor.

import { Avatar } from './Avatar';
import { Card, Empty, Note, Tag } from './Ui';
import { POINT_STATUS_CLASS, POINT_STATUS_LABEL, pct0, plural } from '../lib/format';
import type { DissentProtection } from '../lib/types';

const BASIS_LABEL: Record<DissentProtection['resolutions'][number]['basis'], string> = {
  evidence: 'con evidencia',
  'adopted-dissent': 'adoptó la minoría',
  authority: 'por autoridad',
};

export function DissentPanel({ dissent, compact = false }: { dissent?: DissentProtection; compact?: boolean }) {
  if (!dissent) {
    return (
      <Card title="Disenso protegido">
        <Empty
          icon="scale"
          title="Esta sala no registró datos de disenso"
          hint="Las salas creadas con el protocolo actual mostrarán aquí minorías, cambios de posición y resoluciones."
        />
      </Card>
    );
  }
  const { contestedPoints, resolutions, convergenceWithoutEvidence: conv, vote } = dissent;
  const porAutoridad = resolutions.filter(r => r.basis === 'authority');
  const sinResolver = dissent.unresolved || [];
  const nadaQueContar = !contestedPoints.length && !porAutoridad.length && !conv.count && !vote.collapsed && !sinResolver.length;

  return (
    <>
      <Card
        title="Disenso protegido"
        action={dissent.measured
          ? <span className="tiny">{plural(dissent.contestedCount, 'punto disputado', 'puntos disputados')} · unanimidad {pct0(dissent.unanimity)}</span>
          : <span className="tiny">sin puntos medidos</span>}
      >
        <p className="tiny" style={{ marginBottom: 12 }}>
          El consenso mide cuánto se acercaron. Esto mide lo que <b>no</b> se acercó: converger no es acordar,
          y resolver un punto disputado sin dato nuevo se publica como tal.
        </p>

        {nadaQueContar ? (
          <Empty
            icon="scale"
            title="Sin disenso registrado todavía"
            hint="Cuando el debate tenga posiciones enfrentadas o alguien mueva una posición, aparecerá aquí con nombres."
          />
        ) : (
          <div className="stack" style={{ gap: 12 }}>
            {contestedPoints.map(point => (
              <div className="dissentPoint" key={point.id}>
                <div className="dissentHead">
                  <b>{point.label}</b>
                  <span className="spacer" />
                  <span className={`stChip ${POINT_STATUS_CLASS[point.status]}`}>
                    {POINT_STATUS_LABEL[point.status]}{point.share != null ? ` · ${pct0(point.share)}` : ''}
                  </span>
                </div>
                <div className="dissentRow">
                  <span className="dissentSide win">
                    {point.majority ? `${point.majority.label} · ${point.majority.by.join(', ')}` : 'sin mayoría'}
                  </span>
                </div>
                {point.minority.map((alt, i) => (
                  <div className="dissentRow" key={`${point.id}-${i}`}>
                    <span className="dissentSide lose">
                      {alt.label} · {alt.by.join(', ')}
                    </span>
                    <span className="tiny">{pct0(alt.share)}</span>
                  </div>
                ))}
              </div>
            ))}

            {porAutoridad.length > 0 && (
              <Note>
                <b>Resuelto por autoridad de síntesis: {porAutoridad.map(r => r.pointLabel).join(', ')}.</b>
                <div>
                  Alguien tiene que cerrar, pero quedó sin dato nuevo que lo justifique. Si tenías la otra
                  mitad, tu alternativa sigue abajo, en el resultado congelado.
                </div>
              </Note>
            )}

            {sinResolver.length > 0 && (
              <Note>
                <b>Sin resolver en la síntesis: {sinResolver.map(u => u.label).join(', ')}.</b>
                <div>
                  Un punto abierto que la síntesis no menciona tampoco se cierra: se queda abierto
                  con su minoría, y aquí está dicho en vez de desaparecer.
                </div>
              </Note>
            )}

            {conv.count > 0 && (
              <Note>
                <b>{plural(conv.count, 'posición se movió', 'posiciones se movieron')} sin citar qué la movió.</b>
                <div className="stack" style={{ gap: 6, marginTop: 8 }}>
                  {conv.moves.filter(m => !m.evidenced).map((move, i) => (
                    <div className="tiny" key={i}>
                      <b style={{ color: 'var(--ink)' }}>{move.by}</b> en «{move.point}»: {move.from} → {move.to}
                    </div>
                  ))}
                </div>
              </Note>
            )}

            {vote.collapsed && vote.closest && (
              <Note>
                <b>Aviso de diversidad: la votación llegó casi decidida de antemano.</b>
                <div>
                  «{vote.closest.a}» y «{vote.closest.b}» coincidían en el {pct0(vote.closest.similarity)} de las
                  decisiones de agenda, por encima del {pct0(vote.threshold)} que exige la sala. La votación
                  decidió matices, no direcciones.
                </div>
              </Note>
            )}
          </div>
        )}
      </Card>

      {!compact && resolutions.length > 0 && (
        <Card title="Cómo se cerró cada punto abierto" action={<span className="tiny">{plural(resolutions.length, 'resolución', 'resoluciones')}</span>}>
          <div className="stack" style={{ gap: 8 }}>
            {resolutions.map(r => (
              <div className="agentRow" key={r.pointId}>
                <div className="who">
                  <b>{r.pointLabel}</b>
                  <small>
                    {r.choiceLabel || r.choiceId || 'sin opción fijada'}
                    {r.evidence ? ` · ${r.evidence}` : ''}
                    {r.note ? ` · ${r.note}` : ''}
                  </small>
                </div>
                <Tag tone={r.basis === 'authority' ? 'amber' : r.basis === 'adopted-dissent' ? 'blue' : 'green'}>
                  {BASIS_LABEL[r.basis]}
                </Tag>
              </div>
            ))}
          </div>
        </Card>
      )}

      {!compact && dissent.measured && (
        <Card title="Quién quedó en minoría" action={<span className="tiny">cómo votó cada uno en los puntos disputados</span>}>
          <div className="stack" style={{ gap: 10 }}>
            {contestedPoints.map(point => (
              <div key={point.id}>
                <div className="tiny"><b style={{ color: 'var(--ink)' }}>{point.label}</b></div>
                <div className="row wrap" style={{ marginTop: 6, gap: 6 }}>
                  {point.majority?.by.map(name => (
                    <span className="dissentPerson win" key={`maj-${name}`}><Avatar name={name} size={18} /> {name}</span>
                  ))}
                  {point.minority.flatMap(alt => alt.by.map(name => (
                    <span className="dissentPerson lose" key={`min-${name}`}><Avatar name={name} size={18} /> {name}</span>
                  )))}
                </div>
              </div>
            ))}
            {!contestedPoints.length && <p className="tiny">Todos coincidieron en cada punto votado. Unanimidad al {pct0(dissent.unanimity)} no es un logro por sí solo: significa que nadie sostuvo la otra mitad.</p>}
          </div>
        </Card>
      )}
    </>
  );
}
