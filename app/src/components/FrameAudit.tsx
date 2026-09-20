// El encuadre, auditado.
//
// El encuadre se hace a ciegas para que nadie ancle los ejes a los demás mientras escriben, y
// después hay una vuelta corta (el contraste) con la agenda entera a la vista para añadir el eje
// que falta e impugnar el que sobra. Ninguna de las dos cosas impide que el primer eje ordene
// todo el debate: eso solo se ve al final, comparando qué eje se discutió más. Aquí está, con
// nombres y con los números que ya calculó el servidor — nada de opiniones.

import { Card, Note, Tag } from './Ui';
import { plural } from '../lib/format';
import type { AgendaReview, ContrastView } from '../lib/types';

export function FrameAudit({ audit, contrast, flat = false }: {
  audit?: AgendaReview;
  contrast?: ContrastView;
  // Dentro del resultado congelado no se mete una tarjeta dentro de otra: se pinta plano.
  flat?: boolean;
}) {
  const challenged: AgendaReview['challenged'] = audit?.challenged || contrast?.challenged || [];
  // En vivo el contraste no conoce las opciones absorbidas (eso lo sabe el cierre): se rellena
  // vacío para que la forma sea la misma en los dos modos.
  const merged: AgendaReview['merged'] = audit?.merged
    || (contrast?.merged || []).map(m => ({ ...m, because: [], options: [] }));
  const open = !!contrast?.open && !audit;

  if (!audit && !challenged.length && !merged.length) return null;

  const marcas = open
    ? <Tag tone="blue">contraste en curso</Tag>
    : (audit?.anchored ? <Tag tone="amber">marco anclado</Tag> : <Tag tone="grey">marco repartido</Tag>);

  const cuerpo = (
    <>
      {audit ? (
        <>
          <p className="tiny" style={{ marginBottom: 12 }}>{audit.note}</p>
          <div className="row wrap" style={{ gap: 6, marginBottom: 12 }}>
            <Tag tone="grey">{plural(audit.agentAxes, 'eje de agente', 'ejes de agentes')}</Tag>
            <Tag tone="grey">{plural(audit.addedLate.length, 'eje llegó tarde', 'ejes llegaron tarde')}</Tag>
            <Tag tone={challenged.length ? 'amber' : 'grey'}>
              {plural(challenged.length, 'eje impugnado', 'ejes impugnados')}
            </Tag>
          </div>
        </>
      ) : (
        <p className="tiny" style={{ marginBottom: 12 }}>
          Con la agenda entera a la vista, el contraste es la última oportunidad de añadir un eje que
          faltó o de impugnar uno que sobra. Lo impugnado no se borra: se debate sabiendo que se discute.
        </p>
      )}

      {audit?.opened && (
        <div className="dissentPoint" style={{ marginBottom: 12 }}>
          <div className="dissentHead">
            <b>Abrió el marco: {audit.opened.label}</b>
            <span className="spacer" />
            <span className="tiny">{audit.opened.by || '—'}</span>
          </div>
          <div className="dissentRow">
            <span className={`dissentSide ${audit.opened.mostObjected ? 'lose' : 'win'}`}>
              {plural(audit.opened.objections, 'objeción anclada', 'objeciones ancladas')}
              {audit.opened.mostObjected ? ' · fue el eje más discutido del debate' : ' · no fue el eje más discutido'}
            </span>
          </div>
        </div>
      )}

      {audit?.concentration?.flagged && (
        <Note>
          <b>El marco se concentró en una sola cabeza.</b>
          <div>
            {audit.concentration.by} trajo {audit.concentration.count} de los {audit.agentAxes} ejes
            propuestos por agentes ({Math.round(audit.concentration.share * 100)}%).
          </div>
        </Note>
      )}

      {!!audit?.addedLate.length && (
        <Note>
          <b>Ejes que el encuadre no vio y entraron en el contraste.</b>
          <div className="stack" style={{ gap: 4, marginTop: 6 }}>
            {audit.addedLate.map(a => (
              <div className="tiny" key={a.id}>
                «{a.label}»{a.by ? ` · ${a.by}` : ''}
              </div>
            ))}
          </div>
        </Note>
      )}

      {!!merged.length && (
        <div className="stack" style={{ gap: 8, marginTop: 8 }}>
          {merged.map((m, i) => (
            <div className="agentRow" key={`${m.from}-${i}`}>
              <div className="who">
                <b>«{m.from}» → «{m.into}»</b>
                <small>
                  Fusión pedida por {m.by.join(', ')}
                  {m.options?.length ? ` · las opciones del eje absorbido siguen ahí: ${m.options.join(', ')}` : ''}
                </small>
              </div>
              <Tag tone="blue">fusionados</Tag>
            </div>
          ))}
        </div>
      )}

      {!!challenged.length && (
        <div className="stack" style={{ gap: 8, marginTop: 8 }}>
          {challenged.map(c => (
            <div className="agentRow" key={c.id}>
              <div className="who">
                <b>«{c.label}»</b>
                <small>
                  Impugnado por {c.by.join(', ')}
                  {c.because?.length ? `: ${c.because.join(' · ')}` : ' sin decir por qué'}
                </small>
              </div>
              <Tag tone="amber">en pie</Tag>
            </div>
          ))}
        </div>
      )}
    </>
  );

  if (flat) {
    return (
      <div style={{ marginTop: 18 }}>
        <div className="row wrap">
          <b style={{ fontSize: 14 }}>El encuadre, auditado</b>
          <span className="spacer" />
          {marcas}
        </div>
        {cuerpo}
      </div>
    );
  }
  return <Card title="El encuadre, auditado" action={marcas}>{cuerpo}</Card>;
}
