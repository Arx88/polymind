// AGORA v2 — obligaciones de prueba: el plan convertido en lo que hay que medir, y el veredicto
// generado desde los artefactos.
//
// El resultado de una sala deja de ser prosa: cada afirmación del plan sale tipada, con su
// dueño, su evidencia (o su ausencia) y un veredicto de tres valores que NO puede subir por
// mayoría. Lo que la sala votó y nadie construyó se publica como incumplido, no se omite.
//
// El módulo no ejecuta nada ni escribe nada: lee el estado de la sala (plan, agenda, trabajo,
// evidencia que generó el servidor) y devuelve el libro. La evidencia la produce `runVerify`.

import { now, clampStr, gist, plural } from './util.mjs';
import { nameOf, activeAgents } from './state.mjs';
import { claimsInPlan, classifyClaim, claimRefs, askClauses, coverageOf, containmentOf,
  evidenceOf, vacuousChecks, stemsOf } from './ledger.mjs';
import { planText, workFrom } from './work.mjs';
import { judgmentVerdictFor, visualState, judgmentsOf, shotFreshness, visualMarkdown, visionMarkdown,
  visionDuty, closesNow } from './visual.mjs';
import { humanReviewReport } from './human.mjs';

const MAX_CLAIMS = 44;
const BRIEF_TARGETS = 12;

function judgeOf(room, item) {
  if (!item || item.status !== 'integrated') return null;
  const names = [];
  const snap = room.artifacts?.reviewSnapshot;
  const live = room.phase?.data?.review?.revisados || {};
  const soloAutor = !!room.phase?.data?.review?.soloAutor;
  const collect = (agentId, porItem) => {
    if (!porItem?.[item.id]) return;
    if (agentId === item.claimant && !soloAutor) return;          // su autor no se juzga a sí mismo
    names.push(nameOf(room, agentId));
  };
  for (const [agentId, porItem] of Object.entries(live)) collect(agentId, porItem);
  for (const r of snap?.reviewedItems || []) {
    if (r.id !== item.id) continue;
    for (const n of r.by || []) if (!names.includes(n)) names.push(n);
  }
  return names.length ? names : null;
}

function itemsOf(room) {
  const work = room.work;
  if (!work) return [];
  return (work.order || []).map(id => work.items[id]).filter(Boolean);
}

// El dueño de una afirmación: la tarea que la implementa. Se empareja por punto de agenda (si
// lo hay) y, si no, por texto: la tarea cita la decisión que la originó.
function ownerFor(room, claim, items) {
  if (claim.pointId) {
    const byPoint = items.find(i => i.pointId === claim.pointId);
    if (byPoint) return byPoint;
  }
  let best = null;
  for (const item of items) {
    const texto = `${item.title} ${item.claim} ${item.evidence}`;
    const ratio = containmentOf(claim.text, texto);
    const words = stemsOf(claim.text);
    let shared = 0;
    for (const w of words) if (stemsOf(texto).has(w)) shared += 1;
    if (!best || ratio > best.ratio) best = { item, ratio };
  }
  return best && best.ratio >= 0.5 ? best.item : null;
}

function pointFor(room, claim) {
  let best = null;
  for (const p of room.agenda || []) {
    const ratio = containmentOf(claim.text, p.label);
    if (!best || ratio > best.ratio) best = { p, ratio };
  }
  return best && best.ratio >= 0.5 ? best.p : null;
}

// Las afirmaciones del plan + lo que la síntesis declaró al cerrar cada punto. Ambas son texto
// del que salen obligaciones: si el plan dice «el parser devuelve 63/63» y el acta dice «resuelto
// con evidencia», lo que hay que medir es el parser, no el acta.
function rawClaims(room) {
  const out = [];
  const plan = planText(room);
  for (const text of claimsInPlan(plan, { limit: MAX_CLAIMS })) out.push({ text, source: 'plan', pointId: null });
  for (const r of room.artifacts?.synthesis?.pointResolutions || []) {
    const text = clampStr(r.evidence || r.note || '', 400);
    if (!text || text.length < 25) continue;
    out.push({ text, source: 'sintesis', pointId: r.pointId || null });
  }
  return out;
}

// Cómo miramos una afirmación frente a la evidencia que existe.
function statusOf(claim, { room, type, owner, ownEvidence, anyEvidence, judge }) {
  const integrated = owner && owner.status === 'integrated';
  if (type === 'executable') {
    if (integrated && ownEvidence && ownEvidence.status === 'fresca') {
      return { status: 'medida', because: `medida por el servidor: «${gist(ownEvidence.command, 60)}» → ${ownEvidence.exitCode === 0 ? 'verde' : `rojo (${ownEvidence.exitCode})`} sobre ${String(ownEvidence.commit || '').slice(0, 8) || 'el árbol de la tarea'}` };
    }
    if (integrated) {
      return { status: 'integrada-sin-evidencia', because: 'la tarea está integrada y ninguna medición del servidor certifica ese árbol (sin comando de verificación, o la suya quedó vieja)' };
    }
    if (owner) {
      return { status: 'en-trabajo', because: `la tarea ${owner.id} («${gist(owner.title, 50)}») está en estado «${owner.status}»` };
    }
    if (anyEvidence) {
      return { status: 'medida-sin-tarea', because: `hay una medición del servidor («${gist(anyEvidence.command, 50)}», ${anyEvidence.status}) pero ninguna tarea del plan la reclamó` };
    }
    return { status: 'sin-evidencia', because: 'nadie la convirtió en tarea y el servidor no ejecutó nada que la mida' };
  }
  if (type === 'juicio') {
    // El juicio visual tiene su propio camino: el servidor captura el artefacto y firma quien no
    // lo escribió. La independencia y la frescura de la imagen las calcula el servidor, así que
    // aquí no se acepta una declaración: se lee el estado real.
    const visual = judgmentVerdictFor(room, claim);
    if (visual.state === 'juzgada') return { status: 'juzgada', because: visual.because, judgment: visual };
    if (visual.state === 'no-pasa') return { status: 'no-pasa', because: visual.because, judgment: visual };
    if (visual.state === 'juzgada-por-autor') return { status: 'juzgada-por-autor', because: visual.because, judgment: visual };
    if (visual.state === 'caducada') return { status: 'caducada', because: visual.because, judgment: visual };
    if (visual.state === 'sin-captura' && integrated) {
      return { status: 'sin-captura', because: 'se integró y no hay una sola captura del artefacto: nadie puede decir si cumple lo que promete porque no hay imagen que mirar', judgment: visual };
    }
    if (judge) {
      return { status: 'juzgada', because: `la juzgó quien no la escribió: ${judge.join(', ')}` };
    }
    if (integrated && !judge) {
      return { status: 'sin-juez', because: visual.because || 'se integró y nadie que no la escribiera ha dicho si cumple lo que promete', judgment: visual };
    }
    if (owner) return { status: 'en-trabajo', because: `está en la tarea ${owner.id} y todavía no la ha mirado nadie` };
    return { status: 'sin-juez', because: visual.because || 'nadie la construyó y hace falta un juicio humano o de otro agente para cerrarla', judgment: visual };
  }
  if (type === 'cifra') {
    return { status: 'cifra-declarada', because: 'es un número declarado sin instrumento: se publica como objetivo, nunca como resultado' };
  }
  return { status: 'sin-clasificar', because: 'no declara nada medible ni juzgable' };
}

export function buildObligations(room) {
  const plan = planText(room);
  const items = itemsOf(room);
  const ev = evidenceOf(room);
  const evidenceById = new Map(ev.entries.map(e => [e.id, e]));

  const claims = rawClaims(room).map((raw, i) => {
    const { type, because, refs } = classifyClaim(raw.text);
    const owner = ownerFor(room, raw, items);
    const point = raw.pointId ? (room.agenda || []).find(p => p.id === raw.pointId) || null : pointFor(room, raw);
    // Evidencia propia: la medición que se hizo sobre el árbol de la tarea que la implementa.
    // Evidencia ajena: cualquier medición cuyo comando aparezca citado en la afirmación.
    const ownEvidence = owner ? ev.entries.find(e => e.itemId === owner.id) || null : null;
    const anyEvidence = refs.commands.length
      ? ev.entries.find(e => refs.commands.some(c => containmentOf(c, e.command) >= 0.6)) || null
      : null;
    const judge = judgeOf(room, owner);
    // El objeto se arma primero porque el juicio visual necesita la afirmación CON id (es lo que
    // se firma y lo que el servidor resuelve contra las capturas del commit actual).
    const claim = {
      id: `o${i + 1}`,
      text: clampStr(raw.text, 400),
      type,
      pointId: point?.id || null,
      ownerId: owner?.id || null,
      ownerTitle: owner ? clampStr(owner.title, 120) : null,
    };
    const { status, because: why, judgment } = statusOf(claim, { room, type, owner, ownEvidence, anyEvidence, judge });
    return {
      judgment: judgment || null,
      id: `o${i + 1}`,
      text: clampStr(raw.text, 400),
      source: raw.source,
      type,
      typeBecause: because,
      status,
      statusBecause: why,
      pointId: point?.id || null,
      pointLabel: point?.label || null,
      ownerId: owner?.id || null,
      ownerTitle: owner ? clampStr(owner.title, 120) : null,
      ownerStatus: owner?.status || null,
      judge: judge || null,
      evidenceId: (ownEvidence || anyEvidence)?.id || null,
      evidenceHash: (ownEvidence || anyEvidence)?.hash || null,
      evidenceStatus: (ownEvidence || anyEvidence)?.status || null,
      commands: refs.commands,
      files: refs.files,
    };
  });

  const porTipo = t => claims.filter(c => c.type === t);
  const sinEvidencia = claims.filter(c => c.type === 'executable' && ['sin-evidencia', 'integrada-sin-evidencia'].includes(c.status));
  const sinDueno = claims.filter(c => !c.ownerId && ['executable', 'juicio'].includes(c.type));
  // Pendientes de juicio: lo que promete algo que hay que MIRAR y no lo ha cerrado un ojo
  // externo sobre una captura fresca. Cada estado se separa porque significa una cosa distinta
  // («no hay imagen», «la miró su autor», «el commit se movió»).
  const juicios = porTipo('juicio');
  const sinJuez = juicios.filter(c => ['sin-juez', 'sin-captura', 'juzgada-por-autor', 'caducada'].includes(c.status));
  const juzgadas = juicios.filter(c => c.status === 'juzgada');
  const caducados = juicios.filter(c => c.status === 'caducada');
  const contradichas = juicios.filter(c => c.status === 'no-pasa');
  const cifras = porTipo('cifra');
  const visual = visualState(room);
  // La obligación de ver: quién declaró visión y qué firma le falta. No es una recomendación —
  // un modelo que ve y no firma deja la entrega sin cerrar, y eso se cuenta como cualquier otro
  // incumplimiento, no se omite.
  const duty = visionDuty(room, claims);
  const debeFirmar = duty.claims.filter(c => !contradichas.some(x => x.id === c.claimId));
  // El humano juzga al final, sobre lo entregado. Un cambio pedido y no cerrado es una obligación
  // abierta como cualquier otra: la sala volvió a trabajar precisamente por eso.
  const human = humanReviewReport(room);
  const humanOpen = (human?.requests || []).filter(r => r.status !== 'atendido');

  // El encargo crudo contra el plan y el trabajo: derivación independiente, mecánica y honesta.
  const ask = askCoverage(room, claims);

  // Lo que la sala decidió y nadie construyó. Una decisión votada tiene que materializarse en
  // una tarea (o quedar aquí, contada): votar es gratis si el artefacto no se entera.
  const decisions = decisionsReport(room, items);

  const vacuous = vacuousChecks(room.artifacts?.checks || []);
  const worlds = worldsOf(room);
  const delivery = !room.repo || room.settings?.planOnly ? 'plan' : 'code';

  const blockers = [
    ...sinEvidencia.map(c => ({ kind: 'sin-evidencia', text: c.text, because: c.statusBecause })),
    // Un ojo que miró la imagen y dice que no cumple bloquea: es peor que la ausencia de juicio,
    // porque ya hay evidencia de que lo prometido no está delante.
    ...contradichas.map(c => ({ kind: 'juicio-no-pasa', text: c.text, because: c.statusBecause })),
    // Firmar es parte del trabajo de quien ve. Si declaró visión y no firmó, la entrega no está
    // cerrada: la omisión se publica con el nombre de quien debía mirar.
    ...debeFirmar.map(c => ({
      kind: 'visión-sin-firmar',
      text: c.text,
      because: `declaró visión y no firmó: ${c.missing.join(', ')} — mirar el artefacto era su parte de la obligación, no un extra`,
    })),
    ...decisions.unmaterialized.map(d => ({ kind: 'decision-sin-obra', text: d.title, because: d.reason })),
    ...ask.uncovered.map(a => ({ kind: 'encargo-sin-cobertura', text: a.clause, because: 'no aparece en el plan ni en el trabajo aprobado' })),
    ...humanOpen.map(r => ({
      kind: 'humano-pide-cambios',
      text: clampStr(r.text, 300),
      because: `${r.because} — el humano pidió este cambio al revisar la entrega y la sala no lo cerró`,
    })),
  ];
  const pendings = [
    ...sinJuez.map(c => ({ kind: c.status === 'sin-captura' ? 'juicio-sin-captura' : 'juicio-pendiente', text: c.text, because: c.statusBecause })),
    ...cifras.map(c => ({ kind: 'cifra-declarada', text: c.text, because: c.statusBecause })),
    ...vacuous.map(v => ({ kind: 'comprobacion-no-falsable', text: v.claim, because: v.because })),
  ];

  let verdict = 'cumplido';
  let note = '';
  if (delivery === 'plan') {
    verdict = blockers.length ? 'no-cumplido' : 'no-verificable';
    note = 'La sala no trabajó sobre un proyecto: ninguna afirmación del plan puede tener evidencia ejecutable. El veredicto no mide la calidad del plan, mide que no hay nada que lo respalde.';
  } else if (blockers.length) {
    verdict = 'no-cumplido';
    note = `${plural(blockers.length, 'obligación')} sin cerrar: ${blockers.slice(0, 3).map(b => b.kind).join(', ')}${blockers.length > 3 ? ', …' : ''}.`;
  } else if (pendings.length) {
    verdict = 'cumplido-con-pendientes';
    note = `${plural(pendings.length, 'afirmación')} esperando un juez o declaradas como cifra de diseño. No bloquean el código entregado, pero no cuentan como probadas.`;
  } else {
    note = 'Todas las afirmaciones del plan tienen evidencia del servidor o un juicio de alguien que no las escribió.';
  }

  return {
    generatedAt: now(),
    delivery,
    head: room.repo?.head || null,
    verdict,
    note,
    claims,
    counts: {
      total: claims.length,
      ejecutables: porTipo('executable').length,
      juicios: juicios.length,
      cifras: cifras.length,
      sinClasificar: porTipo('sin-clasificar').length,
      medidas: claims.filter(c => c.status === 'medida').length,
      sinEvidencia: sinEvidencia.length,
      sinDueno: sinDueno.length,
      sinJuez: sinJuez.length,
      juzgadas: juzgadas.length,
      caducados: caducados.length,
      contradichas: contradichas.length,
      conDueno: claims.filter(c => c.ownerId).length,
      capturas: visual.shots.length,
      vision: duty.judges.length,
      sinFirmar: duty.missing,
    },
    // La evidencia visual, tal cual: lo que el servidor capturó, quién lo miró y qué dijo. Va
    // aquí y no en un anexo porque «no debe verse cutre» es una afirmación del plan como cualquier
    // otra, y sin esto quedaba declarada y sin mirar.
    visual: {
      available: !!visual.shots.length,
      running: !!visual.running,
      head: visual.head || null,
      renderer: visual.renderer || null,
      viewport: visual.viewport || null,
      note: visual.note || null,
      notTested: room.artifacts.visualNotTested?.because || null,
      shots: visual.shots.map(s => ({
        id: s.id, label: s.label, hash: s.hash, file: s.file, bytes: s.bytes,
        freshness: shotFreshness(room, s),
        brightness: s.stats?.brightness ?? null, contrast: s.stats?.contrast ?? null,
        alive: s.stats?.alive ?? null, blank: !!s.blank, error: s.error || null,
        url: `/api/rooms/${room.code}/visual/${encodeURIComponent(s.id)}`,
      })),
      // Quién VE y qué debe: cada modelo que declaró visión, con su firma puesta o pendiente.
      vision: {
        seers: duty.judges.map(j => ({ name: j.name, harness: j.harness, model: j.model, signed: j.signed, pending: j.pending })),
        missing: duty.missing,
        note: duty.note,
      },
      judgments: judgmentsOf(room).map(j => ({
        id: j.id, claimId: j.claimId, verdict: j.verdict, reason: j.reason,
        judge: nameOf(room, j.judge), independence: j.independence,
        visionDeclared: j.visionDeclared !== false,
        // `closes` se recalcula ahora, no se copia de cuando se firmó: si la rama avanzó, el
        // juicio que cerraba deja de cerrar y el panel no puede seguir diciendo «cierra».
        closes: closesNow(room, j),
        captures: (j.captures || []).map(c => ({ id: c.id, freshness: c.freshness })), at: j.at,
      })),
    },
    // El veredicto humano, si ya lo hubo: quién lo firmó, qué pidió y en qué quedó cada cambio.
    human: human ? {
      verdict: human.verdict,
      at: human.at,
      by: human.by,
      rounds: human.rounds,
      reviewed: human.reviewed,
      open: human.open,
      // Cada cambio pedido con su estado real (atendido / en la cola / sin tarea posible).
      requests: human.requests.slice(-12).map(q => ({ id: q.id, text: q.text, status: q.status, because: q.because, itemIds: q.itemIds })),
      note: human.note,
    } : null,
    blockers,
    pendings,
    ask,
    decisions,
    evidence: {
      total: ev.total, frescas: ev.frescas, provisionales: ev.provisionales, caducas: ev.caducas,
      reutilizadas: ev.reutilizadas, porComando: ev.porComando,
      // Las mediciones, sin la salida completa: el resultado lleva su huella y su comando, la
      // salida se pide al registro cuando hace falta. Las que fallaron conservan su cola.
      entries: ev.entries.map(e => ({
        id: e.id, hash: e.hash, kind: e.kind, command: e.command, exitCode: e.exitCode, ok: e.ok,
        commit: e.commit ? String(e.commit).slice(0, 12) : null, itemId: e.itemId, status: e.status,
        uses: e.uses || 1, at: e.at,
        outputTail: e.ok === false ? String(e.outputTail || '').slice(0, 400) : null,
      })),
    },
    vacuous,
    worlds,
  };
}

// ---------------------------------------------------------------- encargo
function askClausesOf(room) {
  const crit = room.criteria ? String(room.criteria).split('\n') : [];
  const tarea = String(room.task || '').split('\n').filter(l => !/^\s*[-*•]\s*/.test(l)).join('\n');
  return [...askClauses(tarea), ...crit.flatMap(l => askClauses(l))].slice(0, 18);
}

export function askCoverage(room, claims = null) {
  const clauses = askClausesOf(room);
  if (!clauses.length) return { clauses: [], covered: 0, uncovered: [], coverage: 1 };
  const items = itemsOf(room);
  const against = [
    { id: 'plan', text: planText(room) },
    ...(claims || []).map(c => ({ id: c.id, text: `${c.text} ${c.pointLabel || ''} ${c.ownerTitle || ''}` })),
    ...items.map(i => ({ id: i.id, text: `${i.title} ${i.claim} ${i.evidence}` })),
    ...(room.agenda || []).map(p => ({ id: p.id, text: p.label })),
  ];
  const res = coverageOf(clauses, against);
  return {
    clauses: res.map(r => ({ clause: r.clause, covered: r.covered, by: r.by, ratio: r.ratio })),
    covered: res.filter(r => r.covered).length,
    uncovered: res.filter(r => !r.covered).map(r => ({ clause: r.clause, ratio: r.ratio })),
    coverage: res.length ? Math.round((res.filter(r => r.covered).length / res.length) * 100) / 100 : 1,
  };
}

// ---------------------------------------------------------------- decisiones
function decisionsReport(room, items) {
  let approved = [];
  try { approved = workFrom(room) || []; } catch { approved = []; }
  const matched = [];
  const unmaterialized = [];
  const cap = Number(room.settings?.repo?.maxWorkItems) || 6;
  approved.forEach((imp, i) => {
    const owner = items.find(it => (imp.pointId && it.pointId === imp.pointId)
      || containmentOf(imp.title, `${it.title} ${it.claim}`) >= 0.6);
    if (owner) matched.push({ pointId: imp.pointId || null, title: clampStr(imp.title, 140), itemId: owner.id, status: owner.status });
    else {
      unmaterialized.push({
        pointId: imp.pointId || null,
        title: clampStr(imp.title, 140),
        reason: i >= cap
          ? `la cola de trabajo de la sala es de ${cap} tareas y esta quedó fuera`
          : 'la sala la aprobó en el debate y ninguna tarea la recogió',
      });
    }
  });
  return { approved: approved.length, materialized: matched.length, items: matched, unmaterialized };
}

// ---------------------------------------------------------------- mundos
// De dónde salen los números. La sala puede tener cuatro harnesses distintos y aun así medir
// todo en la misma máquina: eso no es una distribución, es un punto. El registro lo dice.
function worldsOf(room) {
  const declared = activeAgents(room).map(id => {
    const a = room.agents[id] || {};
    return { name: a.name || id, harness: a.harness || null, capabilities: [...(a.capabilities || [])].sort() };
  });
  const firmas = new Set(declared.map(a => `${a.harness || '?'}|${a.capabilities.join(',')}`));
  const measuredBy = `node ${process.version} · ${process.platform} ${process.arch}`;
  const single = firmas.size <= 1;
  return {
    declared: declared.length,
    signatures: firmas.size,
    list: [...firmas],
    measuredBy,
    single,
    note: single
      ? `Un solo mundo declarado (${declared.length ? [...firmas][0] : 'sin harness declarado'}) y todas las mediciones del mismo proceso: los números son un PUNTO, no una distribución.`
      : `${plural(firmas.size, 'mundo')} declarado(s) en la sala, pero toda cifra ejecutada viene del mismo proceso del servidor (${measuredBy}): la diversidad es de criterio, no de capacidad.`,
  };
}

// ---------------------------------------------------------------- para los turnos
// Lo que el verificador necesita para atacar: las afirmaciones que nadie cerró con una medición.
// Sin esto, la verificación dependía de que el agente releyera el plan entero para adivinar
// dónde estaba el hueco.
export function obligationsBrief(room) {
  const led = buildObligations(room);
  const targets = [];
  const push = (kind, text, because) => {
    if (targets.length >= BRIEF_TARGETS) return;
    targets.push({ kind, text: clampStr(text, 300), because });
  };
  for (const b of led.blockers) push(b.kind, b.text, b.because);
  for (const p of led.pendings) push(p.kind, p.text, p.because);
  for (const c of led.claims) {
    if (c.type === 'executable' && c.status === 'en-trabajo') push('en-trabajo', c.text, c.statusBecause);
  }
  return {
    verdict: led.verdict,
    counts: led.counts,
    note: led.note,
    targets,
    askCoverage: { covered: led.ask.covered, total: led.ask.clauses.length, uncovered: led.ask.uncovered.map(u => u.clause) },
    decisions: led.decisions.unmaterialized.map(d => ({ title: d.title, reason: d.reason })),
    evidence: { frescas: led.evidence.frescas, provisionales: led.evidence.provisionales, caducas: led.evidence.caducas },
    vacuous: led.vacuous,
    // El veredicto humano del final viaja al turno de quien trabaja: si pidió cambios, la sala está
    // trabajando por eso y el motivo tiene que estar delante de quien los ejecuta.
    human: led.human ? { verdict: led.human.verdict, open: led.human.open, rounds: led.human.rounds, note: led.human.note } : null,
    worlds: { signatures: led.worlds.signatures, single: led.worlds.single, note: led.worlds.note },
    // Lo visual también se le entrega al verificador: sin esto el plan podía prometer un aspecto
    // y el verificador no tenía ni la imagen ni la forma de firmar sobre ella.
    visual: led.visual.available || led.visual.notTested ? {
      available: led.visual.available,
      notTested: led.visual.notTested,
      shots: led.visual.shots.map(s => ({ id: s.id, label: s.label, hash: s.hash, freshness: s.freshness, url: s.url })),
      judgments: led.visual.judgments.map(j => ({ claimId: j.claimId, verdict: j.verdict, judge: j.judge, independence: j.independence, closes: j.closes, visionDeclared: j.visionDeclared !== false })),
      // Quién declaró visión y qué firma debe: el verificador tiene que saber a quién le falta
      // mirar, porque una firma que falta no se cierra con prosa.
      vision: {
        seers: led.visual.vision.seers.map(s => ({ name: s.name, signed: s.signed, pending: s.pending })),
        missing: led.visual.vision.missing,
        note: led.visual.vision.note,
      },
      how: 'Para firmar un juicio visual usa {kind:"judgment", payload:{claimId, verdict:"pasa"|"no-pasa"|"dudoso", reason, captures:["id de la captura"]}} en la fase de trabajo. Citá una captura fresca: un «pasa» sin imagen fresca y sin ojo externo no cierra nada. Si declaraste la capacidad «vision», cada afirmación de aspecto necesita TU veredicto: la obligación no cierra mientras te falte firmar.',
    } : null,
    message: 'Estas son las obligaciones de prueba que la sala todavía no cerró. Convierte cada una en una comprobación falsable o dilo en findings. El veredicto del resultado se genera de aquí, no de la prosa del plan.',
  };
}

// ---------------------------------------------------------------- para el acta
export function obligationsMarkdown(room) {
  const r = room.result?.obligations || buildObligations(room);
  if (!r) return [];
  const L = [];
  const VERDICT_ES = {
    cumplido: 'CUMPLIDO',
    'cumplido-con-pendientes': 'CUMPLIDO CON PENDIENTES',
    'no-cumplido': 'NO CUMPLIDO',
    'no-verificable': 'NO VERIFICABLE',
  };
  L.push('');
  L.push('## Obligaciones de prueba (generadas desde los artefactos)');
  L.push('');
  L.push(`**Veredicto: ${VERDICT_ES[r.verdict] || r.verdict}.** ${r.note}`);
  L.push('');
  L.push(`De ${plural(r.counts.total, 'afirmación', 'afirmaciones')} del plan: ` +
    `**${r.counts.ejecutables}** ejecutables · **${r.counts.juicios}** de juicio · **${r.counts.cifras}** cifras de diseño` +
    `${r.counts.sinClasificar ? ` · ${r.counts.sinClasificar} sin clasificar` : ''}. ` +
    `Con dueño: **${r.counts.conDueno}**. Medidas por el servidor: **${r.counts.medidas}**. ` +
    `Sin evidencia: **${r.counts.sinEvidencia}**. Sin juez: **${r.counts.sinJuez}**` +
    `${r.counts.juzgadas ? ` · juzgadas por un ojo externo sobre captura fresca: **${r.counts.juzgadas}**` : ''}` +
    `${r.counts.contradichas ? ` · **contradichas por quien miró: ${r.counts.contradichas}**` : ''}` +
    `${r.counts.capturas ? ` · capturas del artefacto: **${r.counts.capturas}**` : ''}` +
    `${r.counts.vision ? ` · con visión declarada: **${r.counts.vision}** (firmas sin poner: **${r.counts.sinFirmar || 0}**)` : ''}.`);
  L.push('');
  L.push('_Esto no lo redactó ningún agente: sale del plan congelado, de las tareas y de las ' +
    'ejecuciones del servidor. Una afirmación sin evidencia no se cuenta como cumplida por mayoría._');
  if (r.evidence.total) {
    L.push('');
    L.push(`**Evidencia ejecutada por el servidor:** ${r.evidence.total} ` +
      `(${r.evidence.frescas} sobre el árbol actual, ${r.evidence.provisionales} sobre árboles en vuelo, ${r.evidence.caducas} de commits que ya no son HEAD` +
      `${r.evidence.reutilizadas ? `, ${r.evidence.reutilizadas} reutilizadas por huella idéntica` : ''}).`);
    L.push('');
    for (const e of r.evidence.entries.slice(-12)) {
      L.push(`- \`${e.hash}\` · \`${e.command}\` → ${e.exitCode === 0 ? 'verde' : `código ${e.exitCode}`} ` +
        `sobre \`${e.commit || 'árbol sin commit'}\`${e.itemId ? ` (tarea ${e.itemId})` : ''} · ${e.status}`);
    }
    if (r.evidence.entries.length > 12) L.push(`- … y ${r.evidence.entries.length - 12} más en el registro de la sala.`);
  }
  if (r.blockers.length) {
    L.push('');
    L.push(`### Sin cerrar (${r.blockers.length})`);
    L.push('');
    for (const b of r.blockers.slice(0, 20)) L.push(`- **[${b.kind}]** ${b.text} — ${b.because}`);
    if (r.blockers.length > 20) L.push(`- … y ${r.blockers.length - 20} más.`);
  }
  if (r.pendings.length) {
    L.push('');
    L.push(`### Pendientes de juicio (${r.pendings.length})`);
    L.push('');
    for (const p of r.pendings.slice(0, 20)) L.push(`- **[${p.kind}]** ${p.text} — ${p.because}`);
  }
  if (r.ask.clauses.length) {
    L.push('');
    L.push(`### El encargo contra el plan (cobertura ${Math.round((r.ask.coverage || 0) * 100)}%)`);
    L.push('');
    L.push('_Comparación mecánica de las cláusulas del encargo original con el plan y el trabajo. ' +
      'La sala no escribió estas cláusulas: es la parte que no puede reescribirse a sí misma._');
    for (const c of r.ask.clauses) {
      L.push(`- ${c.covered ? '✔' : '✘'} ${c.clause}${c.covered ? ` _(en ${c.by})_` : ' — **sin cobertura en el plan ni en el trabajo**'}`);
    }
  }
  if (r.decisions.unmaterialized.length) {
    L.push('');
    L.push(`### Decisiones votadas sin obra (${r.decisions.unmaterialized.length} de ${r.decisions.approved})`);
    L.push('');
    for (const d of r.decisions.unmaterialized) L.push(`- ${d.title} — ${d.reason}`);
  }
  if (r.vacuous.length) {
    L.push('');
    L.push(`### Comprobaciones que no pueden fallar (${r.vacuous.length})`);
    L.push('');
    for (const v of r.vacuous.slice(0, 10)) L.push(`- ${v.claim || '(sin enunciado)'} — ${v.because}`);
  }
  // La evidencia visual va ANTES de la prosa: si hay imágenes y juicios, son parte del veredicto,
  // y el acta tiene que poder leerlos sin que nadie los haya resumido a mano.
  const visualLines = visualMarkdown(room);
  if (visualLines.length) L.push(...visualLines);
  // La obligación de ver, por nombre: quién declaró visión, cuántas firmas puso y cuáles debe.
  const visionLines = visionMarkdown(room, r.claims || []);
  if (visionLines.length) L.push(...visionLines);
  // El humano, al final y sobre lo entregado: qué aprobó o qué pidió, y en qué quedó cada pedido.
  // Va después de la evidencia visual a propósito: primero lo que el servidor capturó y quién lo
  // firmó, después el veredicto de quien recibe.
  // Se lee EN VIVO, no del veredicto congelado: un veredicto humano posterior al cierre tiene que
  // salir en el acta exportada aunque nadie haya vuelto a recalcular el informe (y el estado de cada
  // petición cambia cuando su tarea entra, que es justo lo que hay que poder ver después).
  const human = humanReviewReport(room) || r.human;
  if (human) {
    L.push('');
    L.push('### Revisión humana (al final, sobre la entrega)');
    L.push('');
    L.push(`**${human.verdict === 'aprobado' ? 'APROBADO' : 'CAMBIOS PEDIDOS'}** por ${human.by}` +
      `${human.rounds ? ` · ${plural(human.rounds, 'ronda')} de trabajo posterior` : ''}` +
      `${human.open?.length ? ` · **${human.open.length} cambios sin cerrar**` : ''}` +
      `${human.deliveredHead ? ` · sobre \`${human.deliveredHead}\`` : ''}. ${human.note}`);
    if (human.requests?.length) {
      L.push('');
      for (const req of human.requests) {
        L.push(`- ${req.status === 'atendido' ? '✔' : '✘'} ${req.text} — ${req.because}`);
      }
    }
  }
  L.push('');
  L.push(`_Mundos:_ ${r.worlds.note}`);
  return L;
}
