import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoom, joinRoom, startRoom, enterPhase, applyMove, currentTurn, publicRoom, finishRoom } from '../server/engine/index.mjs';
import { sharedImprovements, improvementResponses, collaborationReport } from '../server/engine/collaboration.mjs';

function fixture() {
  const room = createRoom({ task: 'Construir una herramienta profesional con pruebas medibles.', settings: { planOnly: true, requireDiversity: false } });
  const ids = ['Ada', 'Bruno'].map(name => joinRoom(room, { name }).agentId);
  startRoom(room); enterPhase(room, 'proposal');
  ids.forEach(id => applyMove(room, id, { kind: 'proposal', payload: { title: `Plan ${id}`, plan: `Plan ${id}: implementar una interfaz accesible, medir sus resultados y comprobar las interacciones con pruebas.`, approach: id } }));
  const target = currentTurn(room, ids[0]).targets[0].id;
  applyMove(room, ids[0], { kind: 'critique', payload: { target, improvements: [{ change: 'Añadir una prueba de navegación completa con teclado.', why: 'Comprueba la accesibilidad real de la interfaz.', validation: 'Recorrer todas las acciones sin ratón y sin trampas de foco.' }] } });
  const otherTarget = currentTurn(room, ids[1]).targets[0].id;
  applyMove(room, ids[1], { kind: 'critique', payload: { target: otherTarget, steelman: 'El plan hace verificable el resultado que propone.' } });
  return { room, ids, target };
}

test('constructive improvements alone require an author revision and arrive attributed', () => {
  const { room, ids, target } = fixture();
  assert.equal(room.phase.name, 'revise');
  const turn = currentTurn(room, ids[1]);
  assert.equal(turn.action, 'submit-revision-or-pass');
  assert.equal(turn.sharedImprovements[0].by, 'Ada');
  assert.equal(turn.sharedImprovements[0].target, target);
  assert.match(publicRoom(room).critiques[0].improvements[0].change, /teclado/);
});

test('responses cannot credit invented contributions or claim adoption without a reason', () => {
  const { room, target } = fixture();
  const idea = sharedImprovements(room, target)[0];
  const warnings = [];
  const answers = improvementResponses(room, [
    { contributionId: 'inventado', disposition: 'adopted', reason: 'No existe' },
    { contributionId: idea.id, disposition: 'adopted', reason: '' },
  ], warnings, target);
  assert.equal(answers.length, 0); assert.equal(warnings.length, 2);
});

test('proposal adoption is not silently presented as final synthesis adoption', () => {
  const { room, ids, target } = fixture();
  const idea = sharedImprovements(room, target)[0];
  applyMove(room, ids[1], { kind: 'revision', payload: {
    plan: 'Implementar la interfaz accesible con una prueba completa de teclado y comprobación de todos los puntos de foco.',
    contributionResponses: [{ contributionId: idea.id, disposition: 'adopted', reason: 'Se añade el recorrido de teclado a la verificación de la interfaz.' }],
  } });
  assert.equal(collaborationReport(room)[0].proposalResponse.disposition, 'adopted');
  assert.equal(collaborationReport(room)[0].finalResponse, null);
  enterPhase(room, 'synthesis', { winnerId: target, authorId: ids[1] });
  const turn = currentTurn(room, ids[1]);
  assert.ok(turn.peerPlans.length > 0);
  assert.equal(turn.sharedImprovements.length, 1);
  applyMove(room, ids[1], { kind: 'synthesis', payload: {
    final: 'Plan final compartido: interfaz accesible con recorrido de teclado y comprobación de todos los puntos de foco antes de la entrega.',
    contributionResponses: [{ contributionId: idea.id, disposition: 'adapted', reason: 'Se amplía la prueba propuesta a formularios y estados de error.' }],
  } });
  finishRoom(room, target);
  assert.equal(room.result.collaboration[0].finalResponse.disposition, 'adapted');
  assert.equal(room.result.collaboration[0].by, 'Ada');
});
