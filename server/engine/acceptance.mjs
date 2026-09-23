// Closing a conversation is not proof that its artifact is deliverable.
import { previewEntry } from './preview.mjs';
import { git } from './repo.mjs';
import { evidenceList } from './ledger.mjs';
import { workBacklog } from './work.mjs';
import { visualState, shotFreshness, judgmentsOf, closesNow, judgmentVerdictFor } from './visual.mjs';
import { buildObligations } from './obligations.mjs';

export function deliveryAcceptance(room, { preview } = {}) {
  if (room.settings?.planOnly) return { state: 'plan', blockers: [], preview: null };
  const blockers = [];
  const add = (code, title, action) => blockers.push({ code, title, action });
  if (!room.repo) {
    add('project', 'No hay proyecto', 'Preparar un proyecto donde construir el entregable.');
    return { state: 'incomplete', blockers, preview: null };
  }
  const text = `${room.task || ''} ${room.criteria || ''}`;
  // Existing non-visual repositories are not required to invent a web UI.
  const visual = /\b(visual|web|html|ui|ux|3d|juego|game|landing|dashboard|interfaz|navegable|shader|animaci[oó]n)\b/i.test(text)
    || !!room.settings?.visual?.shots?.length;
  const p = preview ?? previewEntry(room);
  const page = !!p.available && !p.synthetic && !!p.entry;
  if (visual && !page) add('preview', 'Falta una vista previa del producto',
    'Construir y conectar el punto de entrada del producto. Una prueba de imports no es el entregable. Abrirlo y comprobar sus interacciones.');
  const items = Object.values(room.work?.items || {});
  const backlog = workBacklog(room);
  if (backlog.length) add('scope', `${backlog.length} partes aprobadas todavía no se construyeron`,
    'Continuar la cola por lotes hasta implementar todo el alcance aprobado: ' + backlog.map(i => i.title).join('; '));
  if (!items.length || items.some(i => i.status !== 'integrated')) add('work', 'La implementación está incompleta',
    'Resolver las tareas pendientes o fallidas y comprobar el resultado integrado.');
  const head = room.repo.head;
  // Per-patch tests do not certify the combined final tree. Capture probes are not tests.
  const entries = evidenceList(room);
  const candidateTrees = entries.filter(e => e.kind === 'patch' && e.verifiedTree && e.ok === true && e.exitCode === 0
    && room.work?.items?.[e.itemId]?.status === 'integrated' && room.work.items[e.itemId].commit === head);
  const finalTree = candidateTrees.length && room.repo.dir ? git(room.repo, ['rev-parse', 'HEAD^{tree}']) : null;
  const verified = entries.some(e => ['verify', 'baseline'].includes(e.kind) && e.ok === true && e.exitCode === 0
    && !e.itemId && !e.dirty && !!head && e.commit === head)
    || !!(finalTree?.ok && candidateTrees.some(e => e.verifiedTree === finalTree.output.trim()));
  if (!verified) add('tests', 'Falta verificar el proyecto final',
    'Configurar y ejecutar la verificación del proyecto completo sobre el commit final; registrar resultados reales, no comprobaciones propuestas.');
  const shots = visualState(room).shots.filter(s => shotFreshness(room, s) === 'fresca');
  if (visual && !shots.length) add('capture', 'No hay capturas actuales del producto',
    'Abrir el producto y capturarlo sobre el commit final. Si no hay navegador disponible, declarar la limitación sin aprobar la entrega.');
  const visualClaims = room.agenda && room.artifacts?.proposals ? buildObligations(room).claims.filter(c => c.type === 'juicio') : [];
  const reviewed = visualClaims.length ? visualClaims.every(c => judgmentVerdictFor(room, c).state === 'juzgada')
    : judgmentsOf(room).some(j => closesNow(room, j));
  if (visual && !reviewed) add('visual-review', 'Falta una revisión visual independiente',
    'Un harness con visión que no haya escrito el artefacto debe inspeccionar las capturas actuales y registrar su juicio con evidencia.');
  const rejected = visualClaims.length ? visualClaims.some(c => judgmentVerdictFor(room, c).state === 'no-pasa')
    : judgmentsOf(room).some(j => j.verdict === 'no-pasa');
  if (visual && rejected) add('visual-rejected', 'La revisión visual detectó problemas',
    'Resolver cada defecto señalado y registrar una revisión independiente posterior del mismo criterio con captura actual; una aprobación de otro criterio no lo resuelve.');
  return { state: blockers.length ? 'incomplete' : 'evidenced', blockers,
    preview: { available: page, synthetic: !!p.synthetic, entry: page ? p.entry : null }, visual, verified };
}
