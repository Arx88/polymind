import type { Room } from '../lib/types';
import './delivery-journey.css';

/** Product evidence, never a synthetic quality percentage or simulated activity. */
export function DeliveryJourney({ room }: { room: Room }) {
  const acceptance = room.delivery?.acceptance || room.result?.delivery?.acceptance;
  const work = room.work || room.result?.work;
  if (!work || !acceptance || acceptance.state === 'plan') return null;
  const codes = new Set(acceptance.blockers.map(b => b.code));
  const backlog = work.backlog?.length || work.stats.backlog || work.stats.skippedByCap || 0;
  const total = work.stats.items + backlog;
  const integrated = work.stats.integrated;
  const review = room.phase === 'review' || room.status === 'closed';
  const complete = acceptance.state === 'evidenced';
  const steps = [
    { id: 'build', title: 'Construcción', ok: integrated > 0 && integrated === total && !codes.has('work') && !codes.has('scope'),
      value: `${integrated} de ${total} tareas`, detail: backlog ? `${backlog} todavía en el backlog` : 'Alcance aprobado, no solo el primer lote', art: 'build' },
    { id: 'tests', title: 'Pruebas', ok: !!acceptance.verified, value: acceptance.verified ? 'Ejecución comprobada' : 'Sin prueba final válida',
      detail: work.verifyCommand || 'Falta una suite ejecutable', art: 'plan' },
    ...(acceptance.visual ? [
      { id: 'capture', title: 'Capturas', ok: !codes.has('capture'), value: codes.has('capture') ? 'Pendientes' : 'Commit actual capturado',
        detail: 'La imagen debe corresponder a esta versión', art: 'prepare' },
      { id: 'review', title: 'Revisión visual', ok: !codes.has('visual-review') && !codes.has('visual-rejected'),
        value: codes.has('visual-rejected') ? 'Cambios solicitados' : codes.has('visual-review') ? 'Sin aprobación independiente' : 'Juicio registrado',
        detail: 'Otro harness mira el resultado', art: 'review' },
    ] : []),
  ];
  return <section className="deliveryJourney" aria-label="Ruta de aceptación del producto">
    <div className="deliveryJourneyIntro">
      <div className="deliveryJourneyCopy">
        <span className="deliveryJourneyEyebrow">DEL PLAN AL PRODUCTO</span>
        <h3>{complete ? 'Evidencias a la vista.' : review ? 'Construir. Probar. Mirar.' : 'Lo que el equipo está construyendo.'}</h3>
        <p>{complete ? 'Consulta qué se ejecutó y qué se revisó antes de aceptar el resultado.' : 'Un archivo integrado no es una promesa cumplida. Así avanza el trabajo hacia una entrega comprobable.'}</p>
        <div className="deliveryJourneyMeter">
          <span><b>{integrated}</b> / {total} tareas integradas</span>
          <progress value={integrated} max={Math.max(1, total)} aria-label="Tareas integradas del alcance aprobado" />
          <small>Integración de código · no es una puntuación de calidad</small>
        </div>
      </div>
      <img className="deliveryJourneyArt" src={review ? '/images/polymind-quality-lab-v1.png' : '/images/polymind-workshop-v1.png'}
        alt="" width="1536" height="1024" loading="lazy" />
    </div>
    <ol className="deliveryEvidenceSteps">
      {steps.map((step, index) => <li key={step.id} className={step.ok ? 'evidenceComplete' : 'evidencePending'}>
        <div className="evidenceStepTop"><img src={`/images/stages/${step.art}-v2.png`} alt="" width="44" height="44" loading="lazy" /><span>{String(index + 1).padStart(2, '0')}</span></div>
        <h4>{step.title}</h4><b>{step.value}</b><small>{step.detail}</small>
        <span className="evidenceState">{step.ok ? 'Comprobado' : 'Pendiente'}</span>
      </li>)}
    </ol>
    {!!work.backlog?.length && <details className="deliveryBacklog"><summary>{work.backlog.length} partes aprobadas esperan su lote</summary>
      <p>Se incorporan al liberarse espacio en la cola. No quedan descartadas por el límite de tareas.</p>
      <ul>{work.backlog.map((item, index) => <li key={item.pointId || index}>{item.title}</li>)}</ul>
    </details>}
  </section>;
}
