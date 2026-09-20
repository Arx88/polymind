// AGORA v2 — CLI de mentira para probar el runner local.
// Lee el prompt por stdin, extrae el turno y responde SIEMPRE con un único JSON.
// Varía sus decisiones según su nombre para que los agentes no converjan.

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', () => {
  const match = input.match(/<<<AGORA_TURN>>>\s*([\s\S]*?)\s*<<<END_AGORA_TURN>>>/);
  let turn = null;
  try { turn = match ? JSON.parse(match[1]) : null; } catch { turn = null; }
  const name = (input.match(/Eres «([^»]+)»/) || [])[1] || 'fake';
  const move = decide(turn, name);
  process.stdout.write(JSON.stringify(move));
});

function hash(s) {
  let h = 0;
  for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}

function decide(turn, name) {
  const seed = hash(name);
  const text = `(${name}) análisis determinista`;
  switch (turn?.action) {
    case 'confirm-phase-ready':
      return { kind: 'phase-ready', payload: { revision: turn.phaseAgreement.revision, ready: true } };
    case 'start-or-wait':
      return { kind: 'start' };
    case 'frame-contribute':
      if (seed % 3 === 1) {
        return { kind: 'point-proposal', payload: { label: `Criterio de ${name}`, options: ['opción A', 'opción B', 'opción C'] } };
      }
      return { kind: 'pass' };
    case 'submit-proposal': {
      const positions = [];
      for (const point of turn.agenda || []) {
        const options = point.options || [];
        if (!options.length) continue;
        // Si el punto viene de la auditoría (una mejora sobre un archivo concreto),
        // este CLI la apoya: es la mejora que él mismo dejó escrita.
        const apply = options.find(o => o.id === 'aplicar');
        const pick = (point.source === 'finding' && apply) ? apply : options[seed % options.length];
        positions.push({ pointId: point.id, choiceId: pick.id });
      }
      return {
        kind: 'proposal',
        payload: {
          title: `Plan de ${name}`,
          approach: `enfoque-${seed % 997}`,
          plan: `1. ${name} propone una secuencia concreta de trabajo con hitos semanales.\n2. Medir antes de escalar; ninguna pieza se añade sin una métrica que la justifique.\n3. Plan de reversión si el indicador principal no mejora en dos semanas.`,
          premortem: 'Si esto falla en seis meses será porque nadie midió el coste real del primer mes.',
          risks: 'dependencia de una sola métrica',
          assumptions: 'el equipo mantiene el ritmo actual',
          positions,
        },
      };
    }
    case 'submit-critique': {
      const target = (turn.targets || [])[0];
      if (!target) return { kind: 'pass' };
      return {
        kind: 'critique',
        payload: {
          target: target.id,
          steelman: `Lo mejor de «${target.title}» es que se puede empezar esta misma semana.`,
          objections: [
            {
              type: 'cost', severity: 'high',
              text: `(${name}) El plan no cuantifica el coste operativo del primer mes; escenario: dos semanas de uso real y el presupuesto se duplica.`,
            },
            {
              type: 'missing-info', severity: 'med',
              text: `(${name}) No define qué indicador decide continuar o revertir; sin ese umbral la decisión se pospone indefinidamente.`,
            },
          ],
        },
      };
    }
    case 'submit-revision-or-pass': {
      if (turn.blockers?.length) {
        return {
          kind: 'revision',
          payload: {
            proposalId: turn.proposalId,
            plan: `1. Versión corregida que aborda el bloqueo señalado (${turn.blockers[0].text.slice(0, 80)}).\n2. Se añade umbral explícito de reversión y medición semanal.\n3. Se reduce el alcance del primer mes para respetar el presupuesto.`,
            note: 'Abordé el bloqueo con un umbral explícito y menos alcance inicial.',
          },
        };
      }
      if (seed % 2 === 0) return { kind: 'pass' };
      return {
        kind: 'revision',
        payload: {
          plan: `1. Versión revisada de ${name}: incorpora el umbral de reversión pedido.\n2. Elimina la pieza más cara y mide antes de escalar.\n3. Deja explícito qué se sacrifica.`,
          note: 'Incorporé el umbral y recorté coste.',
        },
      };
    }
    case 'submit-vote': {
      const ids = (turn.options || []).map(o => o.id);
      const rotated = ids.length ? [...ids.slice(seed % ids.length), ...ids.slice(0, seed % ids.length)] : [];
      return { kind: 'vote', payload: { ranking: rotated } };
    }
    case 'submit-argument': {
      const finalist = (turn.finalists || [])[0];
      if (!finalist) return { kind: 'pass' };
      return { kind: 'argument', payload: { target: finalist.id, text: `Decisivo: ${finalist.title} es el único que explicita el umbral de reversión.` } };
    }
    case 'objection-or-pass': {
      if (seed % 4 === 0) {
        return {
          kind: 'objection',
          payload: {
            text: 'Veto: el plan ganador no explica qué pasa si el indicador principal no mejora en dos semanas; sin eso el compromiso queda abierto.',
            severity: 'blocker',
          },
        };
      }
      return { kind: 'pass' };
    }
    case 'submit-synthesis':
      return {
        kind: 'synthesis',
        payload: {
          final: `PLAN FINAL (síntesis de ${name})\n${turn.winner.plan}\n\nResuelve los puntos abiertos y conserva el umbral de reversión como condición de continuidad.`,
          merges: (turn.objections || []).map(o => o.id),
          pointResolutions: (turn.unresolved || []).map(p => ({ pointId: p.id, note: `se adopta «${p.leading || 'la mayoritaria'}» con umbral de reversión` })),
        },
      };
    case 'submit-verification':
      return {
        kind: 'verification',
        payload: {
          verdict: 'pass',
          checks: [
            { claim: 'El coste del primer mes no supera el presupuesto declarado', method: 'medir el gasto real durante dos semanas de uso controlado', expectation: 'gasto semanal por debajo de un tercio del presupuesto mensual' },
            { claim: 'El indicador principal mejora de forma sostenida', method: 'comparar la métrica antes y después del primer hito', expectation: 'mejora medible en dos semanas consecutivas' },
          ],
          findings: [],
        },
      };
    // ------------------------------------------------ auditoría y trabajo (con repo)
    case 'audit-repo': {
      return {
        kind: 'finding',
        payload: {
          // El proyecto de ejemplo de las pruebas es calc.mjs + check.mjs.
          file: 'calc.mjs',
          line: 3,
          symbol: 'total',
          severity: seed % 2 ? 'high' : 'med',
          claim: `(${name}) el total no multiplica por la cantidad de cada línea y cobra de menos.`,
          evidence: 'calc.mjs:3 acumula item.price sin usar item.qty; check.mjs no lo cubre.',
          action: `cubrir el cálculo con la cantidad por línea (${name})`,
        },
      };
    }
    case 'claim-item': {
      const free = (turn.openTasks || [])[0];
      if (!free) return { kind: 'pass' };
      return { kind: 'claim-item', payload: { itemId: free.id } };
    }
    case 'submit-patch': {
      // Hay OTRO parche en vuelo: el árbol no está en el estado del último commit y el
      // servidor rechazaría el mío. Se manda un latido y se espera (insistir quemaba
      // turnos del runner sin cambiar nada).
      if (turn.patchInFlight) {
        return { kind: 'progress', payload: { note: `esperando a que se resuelva ${turn.patchInFlight.patchId}` } };
      }
      // El parche se compone sobre el contenido ACTUAL que el servidor acaba de dar:
      // añade una línea de documentación al primer archivo de la tarea. Es un cambio
      // real y verificable (no rompe la comprobación del proyecto).
      const ctx = (turn.filesContext || []).find(f => !f.error && typeof f.text === 'string');
      if (!ctx) return { kind: 'pass' };
      const text = `${ctx.text.replace(/\s*$/, '')}\n// (${name}) revisado en la auditoría del debate\n`;
      return {
        kind: 'submit-patch',
        payload: {
          itemId: turn.task.id,
          summary: `${turn.task.title.slice(0, 80)} — parche de ${name}`,
          files: [{ path: ctx.path, content: text }],
        },
      };
    }
    // Revisión posterior al trabajo: se juzga lo YA integrado contra el diff real.
    // Con AGORA_MOCK_REVIEW=improve el CLI de mentira exige otra vuelta (solo se ejecuta
    // si la sala pide trabajo extraordinario).
    case 'postwork-review': {
      const next = (turn.assign || [])[0];
      if (!next) return { kind: 'pass' };
      if (process.env.AGORA_MOCK_REVIEW === 'improve') {
        return {
          kind: 'recheck',
          payload: {
            itemId: next.id,
            verdict: 'improve',
            claim: `(${name}) la mejora quedó a medias: el mismo cálculo sigue sin prueba propia.`,
            action: `(${name}) añadir una comprobación explícita del caso cantidad>1 en check.mjs`,
            evidence: 'el diff solo añade documentación; el caso límite sigue sin cubrir',
            file: (next.files || [])[0] || 'calc.mjs',
            severity: 'med',
          },
        };
      }
      return {
        kind: 'recheck',
        payload: {
          itemId: next.id,
          verdict: 'ok',
          evidence: `(${name}) el diff hace lo que el plan decía y la verificación del servidor quedó en verde`,
        },
      };
    }
    case 'review-patch': {
      const files = turn.patch?.stat?.list || [];
      return {
        kind: 'review-patch',
        payload: {
          itemId: turn.patch.itemId,
          verdict: files.length ? 'approve' : 'changes',
          notes: files.length
            ? `(${name}) el parche toca ${files.map(f => f.path).join(', ')} y no rompe la comprobación del proyecto.`
            : `(${name}) el parche no trae archivos: no hay nada que integrar.`,
        },
      };
    }
    default:
      return { kind: 'pass' };
  }
}
