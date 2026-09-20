#!/usr/bin/env node
// AGORA — demostración viva.
//
// Crea una sala y mete cinco agentes de ejemplo que ejecutan el protocolo REAL
// por HTTP: encuadre, propuestas a ciegas, crítica asignada, revisión, voto
// secreto, veto, síntesis y verificación independiente. Sirve para ver la
// interfaz con datos de verdad y para comprobar que el protocolo cierra solo.
//
// Importante: son cinco HARNESSES distintos, no cinco personajes. Ninguno declara
// lente; cada uno defiende su criterio y el contraste sale del modelo, no del papel.
//
//   node scripts/demo.mjs                          # contra http://localhost:8787
//   node scripts/demo.mjs --pace 2                 # segundos de pausa por movimiento
//   node scripts/demo.mjs --url http://otro:9000   # otro servidor
//   node scripts/demo.mjs --agents 3 --quiet       # sin narración
//   node scripts/demo.mjs --phase 15               # fases de 15 s (para probar plazos y avisos)
//   node scripts/demo.mjs --task "..." --title "..."
//
// Al terminar imprime la URL de la sala, que queda en el salón y en Resultados.

import process from 'node:process';

// ----------------------------------------------------------------- argumentos
const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf('--' + name);
  if (i === -1) return def;
  const v = args[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const URL_BASE = String(flag('url', process.env.AGORA_URL || 'http://localhost:8787')).replace(/\/+$/, '');
const PACE_MS = Math.max(0, Number(flag('pace', 4)) * 1000);
const QUIET = !!flag('quiet', false);
const COUNT = Math.min(5, Math.max(3, Number(flag('agents', 5)) || 5));

const say = (...a) => { if (!QUIET) console.log(...a); };

const TASK = String(flag('task',
  'Diseñar la estrategia de lanzamiento del producto durante seis meses con presupuesto limitado y equipo de cinco personas.'));
// Título legible a partir de la tarea: si cambias --task, la sala no miente.
const TITLE = String(flag('title', TASK.length > 68 ? `${TASK.slice(0, 65).replace(/[ ,;]+$/, '')}…` : TASK));
// Fases cortas (segundos) para ver el directo con prisa: plazos, cierres y avisos.
const PHASE_SEC = Number(flag('phase', 0)) || 0;

const AGENDA = [
  { label: 'Segmento objetivo', options: ['PYME', 'Mid-market', 'Enterprise'] },
  { label: 'Propuesta de valor', options: ['Ahorro de tiempo', 'Cumplimiento', 'Integración sin fricción'] },
  { label: 'Canales de adquisición', options: ['Venta directa', 'Autoservicio', 'Partners'] },
  { label: 'Modelo de pricing', options: ['Suscripción por asiento', 'Uso medido', 'Freemium + plan de equipo'] },
  { label: 'Riesgos principales', options: ['Adquisición cara', 'Churn temprano', 'Dependencia de un partner'] },
];

// ------------------------------------------------------------------ harnesses
// Cinco formas distintas de atacar el mismo problema. Sin roles: cada harness
// aporta su criterio propio (y así se ve si el debate converge de verdad).
const HARNESSES = [
  {
    name: 'Claude-1', harness: 'claude-code', model: 'claude-sonnet',
    capabilities: ['data', 'logic'],
    approach: 'medición primero, umbrales explícitos',
    plan: (t) => `1. Definir la métrica que decide continuar o revertir: activación a 7 días ≥ 35%.\n2. Instrumentar el embudo completo antes de gastar en adquisición (una semana).\n3. Escalonar el presupuesto: primera mitad en el canal más barato de probar.\n4. Revisión semanal con el umbral de reversión ya escrito.\n\nContexto: ${t}`,
    premortem: 'Falló a los seis meses porque el equipo optimizó una métrica que nadie había acordado y el presupuesto se fue en adquisición sin retención.',
    positions: { 'Segmento objetivo': 'PYME', 'Propuesta de valor': 'Ahorro de tiempo', 'Canales de adquisición': 'Autoservicio', 'Modelo de pricing': 'Uso medido', 'Riesgos principales': 'Churn temprano' },
    voice: {
      steelman: 'Su mejor virtud es que arranca esta semana y aprende rápido.',
      objection: (target) => ({ type: 'missing-info', severity: 'high', text: `El plan de ${target} no dice qué número decide seguir o frenar, así que no se puede evaluar si funcionó; si a los 60 días el indicador mejora un 5% parecerá éxito sin serlo.` }),
      revision: '1. Añado el umbral de activación ≥35% como condición de continuidad.\n2. La revisión de la semana 4 decide si se amplía presupuesto.\n3. Si no se alcanza, se revierte al canal de coste fijo.',
    },
  },
  {
    name: 'Codex-1', harness: 'codex', model: 'gpt-5-codex',
    capabilities: ['logic', 'risk'],
    approach: 'matar la idea barata antes de escalarla',
    plan: (t) => `1. Prueba letal de dos semanas: el canal más prometedor con presupuesto mínimo.\n2. Si el coste por cliente no baja del umbral, se abandona sin más debate.\n3. Contrato de reversión: qué se apaga, cuándo y a quién se avisa.\n4. Ningún compromiso de equipo antes de la prueba.\n\nContexto: ${t}`,
    premortem: 'Falló porque se contrató equipo y se firmaron compromisos antes de comprobar que el canal funcionaba.',
    positions: { 'Segmento objetivo': 'Mid-market', 'Propuesta de valor': 'Cumplimiento', 'Canales de adquisición': 'Venta directa', 'Modelo de pricing': 'Suscripción por asiento', 'Riesgos principales': 'Adquisición cara' },
    voice: {
      steelman: 'Tiene el mérito de no prometer lo que no controla.',
      objection: (target) => ({ type: 'cost', severity: 'high', text: `El plan de ${target} no cuantifica el coste del primer mes; en un escenario donde el coste por cliente se duplica, el presupuesto entero se consume antes del primer hito y no queda margen para corregir.` }),
      revision: '1. La prueba letal va primero y con techo de gasto.\n2. Añado el contrato de reversión firmado antes de la semana 2.\n3. Nada de contrataciones hasta superar el umbral.',
      blocker: 'Veto: el plan final no explica qué ocurre si el canal principal falla en la semana tres.',
    },
  },
  {
    name: 'Cursor-1', harness: 'cursor', model: 'gpt-5',
    capabilities: ['synthesis', 'creativity'],
    approach: 'integrar con lo que el equipo ya usa',
    plan: (t) => `1. Lanzar como extensión de la herramienta que el equipo ya tiene abierta, sin migrar datos.\n2. Una demo de cinco minutos que se pueda compartir dentro de la empresa.\n3. Comunidad de usuarios como canal: los primeros clientes traen el segundo.\n4. El precio se prueba como plan de equipo, no como asiento individual.\n\nContexto: ${t}`,
    premortem: 'Falló porque nadie fuera del equipo entendió qué hacía en la primera pantalla.',
    positions: { 'Segmento objetivo': 'PYME', 'Propuesta de valor': 'Integración sin fricción', 'Canales de adquisición': 'Partners', 'Modelo de pricing': 'Freemium + plan de equipo', 'Riesgos principales': 'Dependencia de un partner' },
    voice: {
      steelman: 'Lo mejor es que se puede probar sin permiso de nadie.',
      objection: (target) => ({ type: 'feasibility', severity: 'med', text: `El plan de ${target} asume que el equipo adoptará el flujo nuevo; si no reduce pasos manuales en la primera sesión, la adopción se queda en la demo y no en el uso diario.` }),
      revision: '1. El primer hito cabe en una sesión de cinco minutos.\n2. La integración con el partner es opcional, nunca requisito para usar el producto.\n3. Mantengo el plan de equipo como experimento de precio.',
    },
  },
  {
    name: 'ZCode-1', harness: 'zcode', model: 'glm-4',
    capabilities: ['synthesis', 'priority'],
    approach: 'secuencia por coste de aprendizaje',
    plan: (t) => `1. Ordenar las apuestas por coste de aprendizaje, no por tamaño de oportunidad.\n2. Semana 1-2: precio y propuesta. Semana 3-6: canal. Mes 2-3: segmento.\n3. Un solo frente abierto a la vez, con criterio de paso escrito.\n4. Decisión de escalado en el mes 4 con datos de embudo.\n\nContexto: ${t}`,
    premortem: 'Falló porque se abrieron tres frentes a la vez y ninguno llegó a conclusión.',
    positions: { 'Segmento objetivo': 'Mid-market', 'Propuesta de valor': 'Ahorro de tiempo', 'Canales de adquisición': 'Venta directa', 'Modelo de pricing': 'Freemium + plan de equipo', 'Riesgos principales': 'Adquisición cara' },
    voice: {
      steelman: 'El plan ordena bien los frentes y evita dispersión.',
      objection: (target) => ({ type: 'scope', severity: 'high', text: `El plan de ${target} abre demasiados frentes en paralelo para un equipo de cinco personas; con dos semanas de retraso se solapan los hitos y ninguna conclusión llega a tiempo.` }),
      revision: '1. Un único frente abierto por tramo, con criterio de paso escrito.\n2. Escalado condicionado a datos de embudo en el mes 4.\n3. Reordeno las apuestas por coste de aprendizaje.',
    },
  },
  {
    name: 'Gemini-1', harness: 'gemini', model: 'gemini-pro',
    capabilities: ['risk', 'ethics'],
    approach: 'impacto en el usuario como criterio de diseño',
    plan: (t) => `1. Publicar qué datos se recogen y para qué, antes del lanzamiento.\n2. Un botón real de exportación y borrado desde el primer día.\n3. Precio sin renovación automática silenciosa.\n4. Canal de reclamación con respuesta en 72 horas.\n\nContexto: ${t}`,
    premortem: 'Falló porque la primera queja pública fue sobre datos y el equipo no tenía respuesta preparada.',
    positions: { 'Segmento objetivo': 'PYME', 'Propuesta de valor': 'Cumplimiento', 'Canales de adquisición': 'Partners', 'Modelo de pricing': 'Uso medido', 'Riesgos principales': 'Dependencia de un partner' },
    voice: {
      steelman: 'Su enfoque de confianza reduce el riesgo reputacional del lanzamiento.',
      objection: (target) => ({ type: 'ethics', severity: 'med', text: `El plan de ${target} no menciona qué datos recoge ni cómo se borran; si el primer cliente enterprise pregunta por cumplimiento, el proceso de venta se atasca justo en el momento del lanzamiento.` }),
      revision: '1. Exportación y borrado desde el primer día.\n2. Declaración de datos publicada antes del lanzamiento.\n3. La confianza entra como criterio de paso, no como nota al pie.',
    },
  },
];

// ------------------------------------------------------------------ protocolo
let seq = 0;
async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch(URL_BASE + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await r.json().catch(() => ({}));
  return { status: r.status, ...json };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Traduce un turno real del protocolo en un movimiento. Nada depende de un rol:
// cada harness decide por su criterio y reparte su esfuerzo como quiere.
function decide(h, turn, index) {
  switch (turn.action) {
    case 'start-or-wait':
      return { kind: 'start' }; // el servidor solo ofrece esta acción si ya hay mínimo de agentes

    case 'frame-contribute':
      // Distinto en cada harness: uno añade un punto, otro propone una regla, otro ratifica.
      if (index === 0) {
        return { kind: 'point-proposal', payload: { label: 'Métrica de continuidad', options: ['Activación a 7 días', 'Retención a 30 días', 'Ingreso por cliente'] } };
      }
      if (index === 1) {
        return { kind: 'rule-change', payload: { op: 'consensusThreshold', value: 80, text: 'Subir el umbral de consenso al 80% para evitar mayorías débiles.' } };
      }
      if (index === 2) {
        const pending = (turn.pendingRules || [])[0];
        if (pending) return { kind: 'ratify', payload: { proposalId: pending.id, approve: true } };
        return { kind: 'point-proposal', payload: { label: 'Coste de reversión', options: ['Menos de una semana', 'Menos de un mes', 'Asumible a cualquier plazo'] } };
      }
      return { kind: 'pass' };

    case 'submit-proposal': {
      const positions = [];
      for (const point of turn.agenda || []) {
        const options = point.options || [];
        if (!options.length) continue;
        const chosen = options.find(o => o.label === h.positions[point.label]) || options[(seq++ + index) % options.length];
        positions.push({ pointId: point.id, choiceId: chosen.id });
      }
      return {
        kind: 'proposal',
        payload: {
          title: `${h.name}: ${h.approach}`,
          approach: h.approach, // el enfoque es del plan, no de un personaje
          plan: h.plan(turn.task || TASK),
          premortem: h.premortem,
          positions,
        },
      };
    }

    case 'submit-critique': {
      const target = (turn.targets || [])[0];
      if (!target) return null;
      return {
        kind: 'critique',
        payload: {
          target: target.id,
          steelman: h.voice.steelman,
          objections: [h.voice.objection(target.author || 'la propuesta')],
        },
      };
    }

    case 'submit-revision-or-pass': {
      if (index === 2) return { kind: 'concede', payload: { reason: 'Otra propuesta cubre mi ángulo con mejor secuencia.' } };
      return {
        kind: 'revision',
        payload: {
          proposalId: turn.proposalId,
          plan: h.voice.revision,
          note: `${h.name} incorpora lo señalado sin ceder en el criterio propio.`,
        },
      };
    }

    case 'submit-vote': {
      const ids = (turn.options || []).map(o => o.id);
      if (index === 1) return { kind: 'vote', payload: { ranking: [...ids].reverse() } };
      if (index === 4) {
        // Ranking parcial a propósito: el motor lo completa y avisa, no rechaza.
        return { kind: 'vote', payload: { ranking: ids.slice(0, 2) } };
      }
      return { kind: 'vote', payload: { ranking: ids.map((_, i) => ids[(i + index) % ids.length]) } };
    }

    case 'submit-argument': {
      const f = (turn.finalists || [])[0];
      if (!f) return null;
      return { kind: 'argument', payload: { target: f.id, text: `${h.name}: elige esta porque su criterio de paso se puede comprobar en dos semanas.` } };
    }

    case 'objection-or-pass':
      return index === 1
        ? { kind: 'objection', payload: { text: h.voice.blocker, severity: 'blocker' } }
        : { kind: 'pass' };

    case 'submit-synthesis': {
      const merges = (turn.objections || []).slice(0, 3).map(o => o.id);
      const pointResolutions = (turn.unresolved || []).map(p => ({ pointId: p.id, note: `se adopta «${p.leading || 'la opción mayoritaria'}»` }));
      const w = turn.winner || {};
      return {
        kind: 'synthesis',
        payload: {
          final: `PLAN FINAL — ${w.title || 'plan ganador'}\n\n${w.plan || ''}\n\n` +
            `Decisiones por punto:\n${(pointResolutions || []).map(p => `· ${p.pointId}: ${p.note}`).join('\n') || '· sin puntos abiertos'}\n\n` +
            'Correcciones incorporadas de la crítica: coste del primer mes acotado, métrica de continuidad explícita, ' +
            'contrato de reversión firmado antes de escalar y declaración de datos publicada antes del lanzamiento.',
          merges,
          pointResolutions,
        },
      };
    }

    case 'submit-verification':
      return {
        kind: 'verification',
        payload: {
          verdict: 'pass',
          checks: [
            { claim: 'El coste del primer mes respeta el presupuesto aprobado', method: 'medir el gasto real a las dos semanas de la prueba', expectation: 'por debajo de un tercio del total' },
            { claim: 'La métrica de continuidad mejora con el canal elegido', method: 'comparar activación a 7 días antes y después del primer hito', expectation: 'mejora sostenida dos semanas' },
            { claim: 'Existe un plan de reversión ejecutable', method: 'simulacro de apagado del canal en una sesión de 30 minutos', expectation: 'sin dependencia de una sola persona' },
          ],
        },
      };

    default:
      return null;
  }
}

// ------------------------------------------------------------------ un agente
async function joinAgent(code, h) {
  const joined = await api(`/api/rooms/${code}/join`, {
    method: 'POST',
    // Sin «role» y sin «lens»: aquí entra un harness, no un personaje.
    body: { name: h.name, harness: h.harness, model: h.model, capabilities: h.capabilities },
  });
  if (!joined.ok) throw new Error(`${h.name}: no pudo entrar (${joined.message || joined.error})`);
  say(`   · ${h.name} dentro como ${joined.harness}${joined.role ? ` (lente declarada: ${joined.role})` : ''}`);
  return { h, ...joined };
}

async function playLoop(code, joined, index) {
  const q = `agent=${joined.agentId}&token=${joined.token}`;
  const h = joined.h;
  await sleep(index * 400); // escalona las primeras respuestas
  let rejectedTwice = false;

  for (let i = 0; i < 80; i++) {
    const r = await api(`/api/rooms/${code}/turn?${q}&wait=25`);
    const turn = r.turn;
    if (!turn) throw new Error(`${h.name}: turno vacío ${JSON.stringify(r).slice(0, 200)}`);
    if (turn.action === 'done') return;

    await sleep(PACE_MS);
    let move = decide(h, turn, index);
    if (move && rejectedTwice) {
      say(`   ~ ${h.name} cambia de estrategia tras dos rechazos seguidos.`);
      move = fallback(turn);
    }
    if (!move) continue;

    const out = await api(`/api/rooms/${code}/move`, { method: 'POST', body: { agentId: joined.agentId, token: joined.token, ...move } });
    const rejected = !out.ok && !['wrong_phase', 'duplicate'].includes(out.error);
    if (rejected) {
      say(`   ! ${h.name} ${move.kind} → ${out.error}: ${out.message}`);
    } else {
      const warn = (out.warnings || []).length ? ` (aviso: ${out.warnings.join('; ')})` : '';
      say(`   → ${h.name} ${label(move.kind)}${warn}`);
    }
    // Si el servidor ya me dijo que ese movimiento fue rechazado dos veces, cambio de plan.
    rejectedTwice = rejected && turn.previousRejection?.kind === move.kind;
  }
}

// Movimiento de rescate cuando el propio ya fue rechazado dos veces seguidas:
// mejor pasar (o esperar) que repetir el mismo error hasta agotar el plazo.
function fallback(turn) {
  switch (turn.action) {
    case 'frame-contribute':
    case 'submit-revision-or-pass':
    case 'objection-or-pass':
      return { kind: 'pass' };
    default:
      return null;
  }
}

const LABELS = {
  start: 'arranca el debate', pass: 'pasa', proposal: 'presenta propuesta', critique: 'critica',
  revision: 'revisa su propuesta', concede: 'cede', vote: 'vota', argument: 'argumenta',
  objection: 'presenta veto', synthesis: 'sintetiza', verification: 'verifica',
  'point-proposal': 'propone un punto de decisión', 'rule-change': 'propone cambiar una regla', ratify: 'ratifica',
};
const label = (k) => LABELS[k] || k;

// ---------------------------------------------------------------------- main
async function main() {
  const health = await api('/api/health').catch(() => null);
  if (!health?.ok) {
    console.error(`\n  No hay servidor en ${URL_BASE}.\n  Arráncalo con:  npm start\n`);
    process.exit(1);
  }

  console.log(`\n  AGORA · demostración viva contra ${URL_BASE}`);
  console.log(`  Cinco harnesses distintos, sin roles asignados.\n`);

  const created = await api('/api/rooms', {
    method: 'POST',
    body: {
      task: TASK,
      title: TITLE,
      criteria: 'Decidir con evidencia, coste acotado, reversión posible e impacto en el usuario explícito.',
      agenda: AGENDA,
      createdBy: 'demo',
      settings: {
        ...(PHASE_SEC > 0
          ? { phaseMs: Object.fromEntries(['lobby', 'frame', 'proposal', 'critique', 'revise', 'vote', 'tiebreak', 'objection', 'repair', 'synthesis', 'verify'].map(p => [p, Math.max(5000, PHASE_SEC * 1000)])) }
          : {}),
        // La sala arranca sola cuando han entrado los COUNT esperados: así todos
        // están dentro antes de la primera propuesta (nadie llega tarde).
        minAgents: COUNT,
        expectedAgents: COUNT,
        joinQuietMs: 20000,
        consensusThreshold: 70,
        tokenBudgetPerAgent: 120000,
        maxDurationMs: 45 * 60 * 1000,
      },
    },
  });
  if (!created.ok) {
    console.error('  No se pudo crear la sala:', created.message || created.error);
    process.exit(1);
  }
  const code = created.code;
  console.log(`  Sala ${code} — ${URL_BASE}/#/d/${code}`);
  console.log(`  Harnesses entrantes (${COUNT}):`);

  const harnesses = HARNESSES.slice(0, COUNT);
  const joined = await Promise.all(harnesses.map(h => joinAgent(code, h))); // entran juntos: el arranque lo dispara el último
  say('   Encuadre abierto: los agentes negocian puntos y reglas antes de debatir.');
  await Promise.all(joined.map((j, i) => playLoop(code, j, i)));

  const pub = await api(`/api/rooms/${code}/public`);
  const room = pub.room || {};
  const global = room.consensus?.global;
  const agreed = room.consensus?.agreed;
  const total = room.consensus?.total ?? room.agenda?.length;
  const winner = room.result?.winner?.title || '—';
  console.log(`\n  Debate cerrado · ${room.result?.outcome || room.status}`);
  console.log(`  Plan ganador: ${winner}`);
  console.log(`  Consenso: ${global == null ? '—' : Math.round(global * 100) + '%'} · puntos acordados: ${agreed ?? '—'}/${total ?? '—'}`);
  console.log(`  Checksum: ${room.result?.checksum || '—'}`);
  console.log(`  Resultado: ${URL_BASE}/#/d/${code}   (y en Resultados)\n`);
}

main().catch(err => { console.error('\n  Error en la demostración:', err.message, '\n'); process.exit(1); });
