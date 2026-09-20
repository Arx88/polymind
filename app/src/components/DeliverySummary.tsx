import type { Room } from '../lib/types';
import { Icon } from './Icons';
import { deliveryEvidence } from '../lib/delivery';

/** Evidence is deliberately separate from consensus. No inferred quality score. */
export function DeliverySummary({ room }: { room: Room }) {
  const result = room.result;
  if (!result) return null;
  const { hasWork, integrated, verified, reviewed, unresolved } = deliveryEvidence(room);
  const blockers = result.verification?.findings?.filter(finding => finding.severity === 'high') || [];
  const work = room.work || result.work;
  const independentFinalReview = work?.items.filter(i => i.status === 'integrated').every(i => work.review?.reviewedItems?.some(r => r.id === i.id && r.by.some(name => name !== i.byName)));
  const acceptanceMissing = hasWork && (verified < integrated || integrated === 0 || !!work?.stats.open || !!work?.stats.skipped || !!work?.stats.failed || !independentFinalReview || !work?.review || work.review.unknown || !!work.review.pending.length);
  return <section className="deliverySummary" aria-label="Estado de la entrega">
    <div className="deliveryHeading"><Icon name="shield" size={20}/><h3>Qué está demostrado</h3></div>
    {acceptanceMissing && <div className="deliveryWarning"><b>Entrega pendiente de aceptación</b><p>Cerrar la sala no certifica el producto. Faltan tareas, pruebas ejecutadas o revisión final completa. Para entregables visuales también debes comprobar su apariencia e interacciones.</p></div>}
    <div className="deliveryGrid">
      <div><span>Decisión</span><strong>{result.outcome === 'decided' ? 'Plan disponible' : 'Sin plan aprobado'}</strong><small>{unresolved ? `${unresolved} puntos sin acuerdo` : 'Consulta las posiciones y el disenso'}</small></div>
      <div><span>Implementación</span><strong>{hasWork ? `${integrated} mejoras integradas` : 'Sin cambios registrados'}</strong><small>{hasWork ? `${reviewed} con revisión de otro agente` : room.repo ? 'No se registró una fase de trabajo' : 'Este trabajo entrega una propuesta'}</small></div>
      <div><span>Pruebas ejecutadas</span><strong>{hasWork ? `${verified} mejoras con pruebas en verde` : 'Sin ejecución registrada'}</strong><small>Las comprobaciones propuestas no son pruebas ejecutadas.</small></div>
    </div>
    {blockers.length > 0 && <div className="deliveryWarning"><b>{blockers.length} hallazgos graves en la verificación del plan</b><p>{blockers.map(finding => finding.text).join('\n')}</p><small>Revisa su resolución en la trazabilidad; una reparación declarada no es una prueba ejecutada.</small></div>}
    {room.criteria && <details><summary>Criterios de éxito del trabajo</summary><p>{room.criteria}</p><small>Se muestran los criterios definidos, no una certificación automática de cumplimiento.</small></details>}
  </section>;
}
