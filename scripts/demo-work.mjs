#!/usr/bin/env node
// AGORA — demostración de TRABAJO CONJUNTO sobre un repositorio.
//
// Levanta un proyecto de ejemplo con un bug de verdad, abre una sala con ese repo,
// mete cinco harnesses distintos y los conduce por el protocolo completo:
//
//   encuadre → auditoría (hallazgos anclados a archivos) → propuestas → crítica →
//   voto → vetos → síntesis → verificación → TRABAJO (uno reclama, otro revisa,
//   el servidor verifica y commitea) → REVISIÓN POSTERIOR (lo integrado se juzga como
//   conjunto; con --extraordinary lo mejorable vuelve a la cola) → resultado con diff,
//   commits y lo que quedó pendiente dicho con claridad.
//
// Los agentes son de verdad: hablan por HTTP contra el servidor vivo, leen los
// archivos por la API y entregan parches. El servidor es el único que toca git.
//
//   node scripts/demo-work.mjs                      # contra http://localhost:8790
//   node scripts/demo-work.mjs --url http://localhost:8891
//   node scripts/demo-work.mjs --quiet --pace 1
//   node scripts/demo-work.mjs --undo              # deshace la última mejora integrada
//   node scripts/demo-work.mjs --undo w2           # deshace una tarea concreta
//   node scripts/demo-work.mjs --undo --redo       # y la vuelve a aplicar (revierte la reversión)
//   node scripts/demo-work.mjs --keep               # no borra el repo de ejemplo
//   node scripts/demo-work.mjs --extraordinary      # revisión que exige más (vuelve a la cola)
//   node scripts/demo-work.mjs --verify 'node tests/check.mjs && sleep 8'   # verificación
//                                                   lenta, para ver (o cortar) el
//                                                   trabajo mientras verifica

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf('--' + name);
  if (i === -1) return def;
  const v = args[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const BASE = String(flag('url', process.env.AGORA_URL || 'http://localhost:8790')).replace(/\/+$/, '');
const QUIET = !!flag('quiet', false);
const PACE = Math.max(0, Number(flag('pace', 0)) * 1000);
const KEEP = !!flag('keep', false);
// Deshacer al final: la verificación puede pasar en verde y la mejora ser un error igual.
const UNDO = flag('undo', false);
// Y su vuelta atrás: volver a aplicar lo deshecho.
const REDO = !!flag('redo', false);
// Por defecto la verificación es la del proyecto de ejemplo; con --verify se puede
// hacer lenta a propósito para observar (o interrumpir) el trabajo en marcha.
const VERIFY = String(flag('verify', 'node tests/check.mjs'));
// Trabajo extraordinario: la revisión posterior al trabajo no se conforma con «está bien»
// y lo que ve mejorable vuelve a la cola (hasta agotar las rondas).
const EXTRA = !!flag('extraordinary', false);
const say = (...a) => { if (!QUIET) console.log(...a); };
const wait = ms => new Promise(r => setTimeout(r, ms));

// ----------------------------------------------------------------- fixture
const PRICING_BUGGY = [
  '// Precios de una compra. Cada línea trae price y, a veces, qty.',
  'export function total(items) {',
  '  let t = 0;',
  '  for (const item of items) t += item.price;',
  '  return t;',
  '}',
  '',
  '// percent es un porcentaje (20 = 20%).',
  'export function discount(value, percent) {',
  '  return value - value * percent;',
  '}',
  '',
].join('\n');

// Las comprobaciones crecen CON el código: cada tarea añade la suya y ninguna
// afirma un comportamiento que todavía no está arreglado (si no, la verificación
// rechazaría el parche con razón, que es justo lo que hace el servidor).
const ASSERTIONS = {
  qty: "if (total([{ price: 2, qty: 3 }]) !== 6) { console.error('total con qty debe ser 6'); process.exit(1); }",
  discount: "if (discount(100, 20) !== 80) { console.error('discount(100, 20) debe ser 80'); process.exit(1); }",
  empty: "if (total([]) !== 0) { console.error('total vacio debe ser 0'); process.exit(1); }",
  zero: "if (discount(100, 0) !== 100) { console.error('discount con 0% no cambia el valor'); process.exit(1); }",
};

// Añade las comprobaciones que falten antes del cierre del script, sin duplicar.
function withAssertions(content, keys) {
  const missing = keys.map(k => ASSERTIONS[k]).filter(line => line && !content.includes(line));
  if (!missing.length) return content;
  const marker = "console.log('check ok');";
  return content.includes(marker)
    ? content.replace(marker, `${missing.join('\n')}\n${marker}`)
    : `${content}\n${missing.join('\n')}\n`;
}

const CHECK_BUGGY = [
  "import { total, discount } from '../src/pricing.mjs';",
  "if (total([{ price: 2 }]) !== 2) { console.error('total simple debe ser 2'); process.exit(1); }",
  "if (typeof discount !== 'function') { console.error('falta discount'); process.exit(1); }",
  "console.log('check ok');",
  '',
].join('\n');

// Documenta lo que el código hace DE VERDAD: si el cálculo todavía no soporta qty o el
// descuento, el README lo dice tal cual.
function docFrom(pricing) {
  return [
    '## Fórmulas',
    '',
    /item\.qty/.test(pricing)
      ? '- `total(items)`: suma `price * qty` de cada línea (`qty` por defecto 1).'
      : '- `total(items)`: suma `price` de cada línea (todavía ignora `qty`).',
    /const factor = Math\.max/.test(pricing)
      ? '- `discount(value, percent)`: el porcentaje se acota a 0..100 y se aplica como fracción.'
      : '- `discount(value, percent)`: aplica `percent` tal cual (todavía sin acotar).',
    '',
    'La comprobación del proyecto vive en `tests/check.mjs` (`node tests/check.mjs`).',
  ].join('\n');
}

function git(cwd, ...a) {
  const r = spawnSync('git', a, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr || r.stdout}`);
  return r.stdout;
}

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agora-demo-repo-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'pricing.mjs'), PRICING_BUGGY);
  fs.writeFileSync(path.join(dir, 'tests', 'check.mjs'), CHECK_BUGGY);
  fs.writeFileSync(path.join(dir, 'README.md'), '# checkout\n\nCálculo de precios de una compra.\n');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '.');
  git(dir, '-c', 'user.name=equipo', '-c', 'user.email=equipo@local', 'commit', '-q', '-m', 'cálculo de precios');
  return dir;
}

// ----------------------------------------------------------------- agentes
// Cinco harnesses. Ninguno tiene rol: cada uno audita con su criterio y trabaja
// cuando le toca. Los hallazgos se solapan a propósito (corroborar suma peso).
const FINDINGS = {
  'Claude-1': [{
    file: 'src/pricing.mjs', line: 4, symbol: 'total', severity: 'high',
    claim: 'total ignora la cantidad de cada línea: cobra una sola unidad aunque el pedido lleve tres.',
    evidence: 'src/pricing.mjs:4 suma item.price sin multiplicar por item.qty; tests/check.mjs no lo cubre.',
    action: 'multiplicar price por qty con valor por defecto 1 y cubrirlo en la comprobación',
  }],
  'Codex-1': [{
    file: 'src/pricing.mjs', line: 4, symbol: 'total', severity: 'high',
    claim: 'La función total no tiene en cuenta la cantidad de cada artículo del pedido.',
    evidence: 'src/pricing.mjs:4 — el bucle acumula item.price sin usar item.qty.',
    action: 'multiplicar price por qty con valor por defecto 1 y añadir el caso a la comprobación',
  }],
  'Cursor-1': [{
    file: 'src/pricing.mjs', line: 10, symbol: 'discount', severity: 'high',
    claim: 'discount trata el porcentaje como fracción: con 20 devuelve un valor negativo enorme.',
    evidence: 'src/pricing.mjs:10 hace value - value * percent; con (100, 20) da -1900 en vez de 80.',
    action: 'dividir el porcentaje entre 100 y acotarlo a 0..100 antes de aplicar el descuento',
  }],
  'Gemini-1': [{
    file: 'tests/check.mjs', severity: 'med',
    claim: 'La comprobación solo cubre el caso de una unidad, así que ningún bug de cantidades se detecta.',
    evidence: 'tests/check.mjs comprueba total([{price:2}]) y solo la existencia de discount.',
    action: 'cubrir total con qty y discount con un porcentaje real en la comprobación',
  }],
  'ZCode-1': [{
    file: 'README.md', severity: 'low',
    claim: 'El README no explica cómo ejecutar la comprobación del proyecto.',
    evidence: 'README.md solo describe qué calcula el módulo.',
    action: 'documentar en el README cómo ejecutar la comprobación',
  }],
};

const HARNESSES = [
  { name: 'Claude-1', harness: 'claude-code', model: 'claude-sonnet' },
  { name: 'Codex-1', harness: 'codex', model: 'gpt-5-codex' },
  { name: 'Cursor-1', harness: 'cursor', model: 'sonnet' },
  { name: 'Gemini-1', harness: 'gemini-cli', model: 'gemini-2.5-pro' },
  { name: 'ZCode-1', harness: 'zcode', model: 'glm-4.6' },
];

// Los arreglos reales, aplicados sobre el contenido ACTUAL del archivo (que el
// agente acaba de leer por la API). Nada de parches ciegos.
const FIX_TOTAL = content => content.replace(
  '  for (const item of items) t += item.price;\n',
  '  for (const item of items) t += item.price * (item.qty ?? 1);\n');

const FIX_DISCOUNT = content => content.replace(
  '  return value - value * percent;\n',
  '  const factor = Math.max(0, Math.min(100, percent)) / 100;\n  return value * (1 - factor);\n');

// ----------------------------------------------------------------- protocolo
async function j(pathname, opts) {
  const r = await fetch(BASE + pathname, opts);
  const text = await r.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!r.ok || body.ok === false) throw new Error(`${pathname} → ${r.status} ${body.message || text.slice(0, 200)}`);
  return body;
}

const post = (pathname, body) => j(pathname, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

async function readRepoFile(code, agent, rel) {
  const out = await j(`/api/rooms/${code}/repo?path=${encodeURIComponent(rel)}&lines=400&agent=${agent.id}&token=${agent.token}`);
  return out.kind === 'file' ? out.text : '';
}

async function main() {
  const fixture = makeFixture();
  say('');
  say('  AGORA · trabajo conjunto sobre un repositorio');
  say(`  repo de ejemplo: ${fixture}`);
  say('');

  const created = await post('/api/rooms', {
    task: 'Auditar el módulo de precios, decidir qué se mejora y dejar los cambios aplicados y verificados.',
    title: 'Auditoría y mejora del módulo de precios',
    criteria: 'La comprobación del proyecto debe seguir en verde y cubrir los casos arreglados.',
    context: `Proyecto Node sin dependencias. La verificación del repo es \`${VERIFY}\`.`,
    settings: {
      minAgents: 3, expectedAgents: 5, consensusThreshold: 0.6, joinQuietMs: 60_000,
      phaseMs: { audit: 240_000, work: 600_000, review: 240_000 },
      requireDiversity: false, extraordinary: EXTRA,
    },
    repo: { path: fixture, verify: VERIFY, baseline: true },
  });
  const code = created.code;
  say(`  sala ${code} · rama ${created.repo.branch} · ${created.repo.files === 1 ? '1 archivo' : `${created.repo.files} archivos`}`);
  say(`  ${BASE}/#/d/${code}`);
  if (created.repoWarning) say(`  AVISO repo: ${created.repoWarning}`);
  say('');

  const agents = [];
  for (const h of HARNESSES) {
    const out = await post(`/api/rooms/${code}/join`, { ...h });
    agents.push({ ...h, id: out.agentId, token: out.token });
  }

  const deadline = Date.now() + 6 * 60_000;
  while (Date.now() < deadline) {
    let moved = 0;
    for (const agent of agents) {
      const turn = (await j(`/api/rooms/${code}/turn?agent=${agent.id}&token=${agent.token}`)).turn;
      if (turn.action === 'done') { moved += 1; break; }
      const move = await decide(agent, turn, code);
      if (!move) continue;
      try {
        const out = await post(`/api/rooms/${code}/move`, { agentId: agent.id, token: agent.token, ...move });
        moved += 1;
        for (const w of out.warnings || []) say(`     · aviso: ${w}`);
      } catch (err) {
        say(`     ! ${agent.name}: ${err.message}`);
      }
      if (PACE) await wait(PACE);
    }
    const pub = await j(`/api/rooms/${code}/public`);
    if (pub.room.status === 'closed') break;
    if (!moved) await wait(1200);
  }

  const room = (await j(`/api/rooms/${code}/public`)).room;
  say('');
  if (room.status !== 'closed') { say('  (la sala no cerró dentro del plazo de la demo)'); }
  const r = room.result;
  if (r) {
    say(`  RESULTADO: ${r.outcome} · «${r.winner?.title || '—'}» · consenso ${Math.round((r.consensus.global || 0) * 100)}%`);
    const w = r.work;
    if (w) {
      say(`  TRABAJO: rama ${w.branch} · base ${w.baseCommit.slice(0, 8)} → ${String(w.head).slice(0, 8)}`);
      for (const item of w.items) {
        say(`    ${item.id} [${item.status}] ${item.title.slice(0, 62)}`);
        say(`        parche ${item.patchId || '—'} de ${item.byName || '—'} · revisión ${item.reviewerName || 'sin revisar'} · ` +
          `verificación ${item.verify?.ran ? (item.verify.ok ? 'verde' : `roja (${item.verify.exitCode})`) : 'no ejecutable'}` +
          `${item.commit ? ` · commit ${item.commit.slice(0, 8)}` : ''}`);
      }
      say(`    diff: ${w.stats.files} archivo${w.stats.files === 1 ? '' : 's'} +${w.stats.insertions}/-${w.stats.deletions} · ${w.commits.length} commit${w.commits.length === 1 ? '' : 's'}`);
      if (w.review) {
        say(`    revisión posterior: ronda ${w.review.round}/${w.review.maxRounds} · ` +
          `${w.review.reviewed}/${w.review.total} mejoras revisadas por otro agente` +
          (w.review.proposals.length ? ` · ${w.review.proposals.length} propuesta${w.review.proposals.length === 1 ? '' : 's'} sin ejecutar` : ''));
      }

      if (UNDO && w.stats.integrated > 0) {
        say('');
        say('  DESHACER: se revierte la mejora en la rama (git revert: queda en el historial, no se borra nada)');
        const out = await fetch(`${BASE}/api/rooms/${code}/admin`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            adminToken: created.adminToken,
            op: 'revert',
            itemId: typeof UNDO === 'string' ? UNDO : undefined,
            reason: 'demo: se revisa antes de darlo por bueno',
          }),
        }).then(x => x.json()).catch(err => ({ ok: false, message: String(err) }));
        if (!out.ok) {
          say(`    no se pudo deshacer: ${out.message}`);
        } else {
          say(`    ${out.item}: se revirtió ${String(out.of).slice(0, 8)} con ${String(out.commit).slice(0, 8)}`);
          for (let i = 0; i < 60; i++) {
            const after = (await j(`/api/rooms/${code}/public`)).room;
            const rv = after.work.items.find(x => x.id === out.item)?.revert?.verify;
            if (rv && rv.status === 'done') {
              say(`    verificación tras deshacer: ${rv.ran ? (rv.ok ? 'vuelve a pasar en verde' : `queda EN ROJO (código ${rv.exitCode})`) : 'no se pudo ejecutar'}`);
              say(`    informe recalculado: ${after.result.work.stats.integrated} integradas, ${after.result.work.stats.reverted} deshechas`);
              break;
            }
            await wait(500);
          }

          if (REDO) {
            say('');
            say('  VOLVER A APLICAR: se revierte la reversión (el historial conserva los tres pasos)');
            const again = await fetch(`${BASE}/api/rooms/${code}/admin`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ adminToken: created.adminToken, op: 'reapply', itemId: out.item, reason: 'demo: se revisó y vuelve' }),
            }).then(x => x.json()).catch(err => ({ ok: false, message: String(err) }));
            if (!again.ok) {
              say(`    no se pudo volver a aplicar: ${again.message}`);
            } else {
              say(`    ${again.item}: se revirtió ${String(again.of).slice(0, 8)} con ${String(again.commit).slice(0, 8)}`);
              for (let i = 0; i < 60; i++) {
                const after = (await j(`/api/rooms/${code}/public`)).room;
                const rv = after.work.items.find(x => x.id === again.item)?.reapplied?.verify;
                if (rv && rv.status === 'done') {
                  say(`    verificación tras volver a aplicarla: ${rv.ran ? (rv.ok ? 'en verde' : `EN ROJO (código ${rv.exitCode})`) : 'no se pudo ejecutar'}`);
                  say(`    informe: ${after.result.work.stats.integrated} integradas, ${after.result.work.stats.reverted} deshechas`);
                  break;
                }
                await wait(500);
              }
            }
          }
        }
      }
      const md = await fetch(`${BASE}/api/rooms/${code}/export.md`).then(x => x.text());
      const diff = await fetch(`${BASE}/api/rooms/${code}/work.diff?admin=${encodeURIComponent(created.adminToken)}`).then(x => x.text());
      say('');
      say('  DIFF QUE TE LLEVAS');
      for (const line of diff.split('\n').slice(0, 40)) say('    ' + line);
      if (md.includes('Trabajo conjunto')) say('\n  export markdown con la tabla de tareas: /api/rooms/' + code + '/export.md');
    }
  }
  say('');
  say(`  Ver la sala: ${BASE}/#/d/${code}`);
  if (!KEEP) fs.rmSync(fixture, { recursive: true, force: true });
  else say(`  repo de ejemplo conservado en ${fixture}`);
}

// Elige el movimiento a partir del turno REAL del servidor.
async function decide(agent, turn, code) {
  switch (turn.action) {
    case 'start-or-wait':
      return turn.payloadSchema ? { kind: 'start', payload: {} } : null;
    case 'frame-contribute':
      return { kind: 'pass', payload: {} };
    case 'audit-repo': {
      const list = FINDINGS[agent.name] || [];
      if (!list.length) return { kind: 'pass', payload: {} };
      const finding = list.shift();
      say(`  ${agent.name} [auditoría] ${finding.file} · ${finding.severity} · ${finding.action.slice(0, 60)}`);
      return { kind: 'finding', payload: finding };
    }
    case 'submit-proposal': {
      const positions = {};
      for (const point of turn.agenda || []) {
        // Aplica lo que su propio hallazgo pedía; aplaza el resto del archivo de precios
        // si no le toca; descarta la documentación.
        const isReadme = (point.label || '').toLowerCase().includes('readme');
        positions[point.id] = isReadme ? 'descartar' : 'aplicar';
      }
      return {
        kind: 'proposal',
        payload: {
          title: `Plan de ${agent.name}`,
          approach: `${agent.name} arregla el cálculo y actualiza la comprobación`,
          plan: 'Aplicar las mejoras aprobadas en src/pricing.mjs, ampliar tests/check.mjs con los casos que faltan y dejar la comprobación en verde. La documentación queda aplazada.',
          premortem: 'Falla si alguien arregla el cálculo sin actualizar la comprobación: la verificación lo detectaría.',
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
          steelman: 'El plan es mínimo y verificable con la comprobación que ya existe.',
          objections: [{
            type: 'risk', severity: 'low',
            text: `${agent.name}: el parche debe actualizar tests/check.mjs en el mismo cambio; si no, la verificación rechazará el trabajo.`,
          }],
        },
      };
    }
    case 'submit-revision-or-pass':
      return { kind: 'pass', payload: {} };
    case 'submit-vote':
      return { kind: 'vote', payload: { ranking: (turn.options || []).map(o => o.id) } };
    case 'objection-or-pass':
      return { kind: 'pass', payload: {} };
    case 'submit-synthesis':
      return {
        kind: 'synthesis',
        payload: {
          final: `${turn.winner.plan}\n\nOrden de trabajo: primero el cálculo de total (con su caso en la comprobación), después el descuento, y por último la ampliación del test.`,
          merges: (turn.objections || []).map(o => o.id),
          pointResolutions: (turn.unresolved || []).map(p => ({ pointId: p.id, note: 'se resuelve con el trabajo sobre el repo' })),
        },
      };
    case 'submit-verification':
      return {
        kind: 'verification',
        payload: {
          verdict: 'pass',
          checks: [
            { claim: 'total([{price:2, qty:3}]) devuelve 6', method: 'node tests/check.mjs', expectation: 'exit 0' },
            { claim: 'discount(100, 20) devuelve 80', method: 'node tests/check.mjs', expectation: 'exit 0' },
          ],
        },
      };
    case 'claim-item': {
      const open = turn.openTasks || [];
      if (!open.length) return { kind: 'pass', payload: {} };
      const item = open[0];
      say(`  ${agent.name} toma la tarea ${item.id}: ${String(item.title).slice(0, 60)}`);
      return { kind: 'claim-item', payload: { itemId: item.id } };
    }
    case 'submit-patch': {
      // Si hay otro parche sin resolver, el árbol incluye cambios ajenos: se espera.
      if (turn.patchInFlight) return null;
      return submitPatch(agent, turn, code);
    }
    // Revisión posterior al trabajo: se juzga lo YA integrado contra el diff real.
    case 'postwork-review': {
      const pending = (turn.assign || [])[0];
      if (!pending) return { kind: 'pass', payload: {} };
      const integrada = (turn.integrated || []).find(i => i.id === pending.id);
      // Con trabajo extraordinario, el demo no se conforma con lo que ya pasó la verificación:
      // mientras la documentación no describa las fórmulas que quedaron en el código, exige
      // esa mejora. Cuando ya está hecha, revisa de verdad y cierra (nada de bucles falsos).
      const documentado = (turn.integrated || []).some(i => (i.files || []).some(f => f.endsWith('README.md')));
      if (EXTRA && !documentado) {
        say(`  ${agent.name} [revisión] ${pending.id} → aún se puede mejorar (documentación)`);
        return {
          kind: 'recheck',
          payload: {
            itemId: pending.id,
            verdict: 'improve',
            claim: 'el README sigue sin describir qué hace el cálculo de precios',
            action: 'documentar en README.md la fórmula del total y del descuento tal como quedaron',
            evidence: `diff de ${pending.id} revisado: el cambio es real, pero nadie que lea el README lo va a saber`,
            file: 'README.md',
            severity: 'med',
          },
        };
      }
      say(`  ${agent.name} [revisión] ${pending.id} → ok (${integrada?.verify || 'sin verificación ejecutable'})`);
      return {
        kind: 'recheck',
        payload: {
          itemId: pending.id,
          verdict: 'ok',
          evidence: `el diff hace lo que el debate aprobó y la verificación del servidor quedó en ${integrada?.verify || 'sin comando ejecutable'}`,
        },
      };
    }
    case 'review-patch': {
      const patch = turn.patch;
      if (!patch) return null;
      // Regla de revisión del demo: un cambio de comportamiento tiene que venir con la
      // comprobación al día; la documentación se aprueba como documentación (no necesita
      // comprobación, y exigírsela la dejaba fuera para siempre).
      const paths = (patch.stat?.list || []).map(f => f.path);
      const soloDocs = paths.length > 0 && paths.every(p => /\.md$/i.test(p));
      const verdict = (soloDocs || paths.some(p => p.includes('check.mjs'))) ? 'approve' : 'changes';
      say(`  ${agent.name} revisa ${patch.id} (${paths.join(', ') || 'sin archivos'}) → ${verdict}`);
      return {
        kind: 'review-patch',
        payload: {
          itemId: patch.itemId,
          verdict,
          notes: verdict === 'approve'
            ? (soloDocs
              ? 'Es documentación: describe lo que el código hace y no puede romper la comprobación.'
              : 'El cambio toca el cálculo y su comprobación a la vez: no rompe lo que ya pasaba.')
            : 'Falta cubrir el caso con cantidad en la comprobación antes de integrarlo.',
        },
      };
    }
    default:
      return null;
  }
}

// El parche se compone sobre el archivo ACTUAL del repo (leído por la API, como
// haría cualquier agente): así el segundo parche no pisa el primero, y si el repo
// ya está arreglado el agente lo dice en vez de enviar un cambio vacío.
async function submitPatch(agent, turn, code) {
  const task = turn.task;
  if (task.attempts >= 3) {
    say(`  ${agent.name} se retira de ${task.id}: tres intentos sin integrar`);
    return { kind: 'pass', payload: { reason: 'tres intentos sin que la verificación pase' } };
  }
  const pricing = await readRepoFile(code, agent, 'src/pricing.mjs');
  const tests = await readRepoFile(code, agent, 'tests/check.mjs');
  if (!pricing || !tests) return { kind: 'pass', payload: {} };

  const text = `${task.title} ${task.claim}`;
  const files = [];
  let nextPricing = pricing;
  let checks = [];

  // Qué es esta tarea se decide por los ARCHIVOS que toca (dato del servidor), no
  // por palabras del título: la tarea de cobertura habla de «total» y «discount»
  // aunque su archivo sea la comprobación.
  const touches = rel => (task.files || []).some(f => f.replace(/\\/g, '/').endsWith(rel));
  const isCoverage = touches('tests/check.mjs') && !touches('src/pricing.mjs');
  // Documentación: la mejora que sale de la revisión posterior suele ser «esto no está escrito
  // en ninguna parte». Se documenta la fórmula REAL, así que si el cálculo aún no está
  // arreglado el README lo dice (y la revisión siguiente lo verá, no se finge nada).
  const isDocs = touches('README.md') || /readme|document/i.test(text);

  if (isDocs) {
    const readme = await readRepoFile(code, agent, 'README.md');
    if (readme.includes('## Fórmulas')) {
      say(`  ${agent.name} mira ${task.id} y la documentación ya describe las fórmulas: no toca nada`);
      return { kind: 'pass', payload: { reason: 'la documentación ya describe el comportamiento real' } };
    }
    say(`  ${agent.name} documenta en README.md las fórmulas que quedaron en el código`);
    files.push({ path: 'README.md', content: `${readme.replace(/\s*$/, '')}\n\n${docFrom(pricing)}\n` });
  } else if (isCoverage) {
    // Tarea de cobertura: solo se puede afirmar lo que el código YA hace (si no, la
    // verificación rechazaría el parche, que es exactamente lo que debe pasar).
    checks = [
      ...(/item\.qty/.test(pricing) ? ['qty', 'empty'] : []),
      ...(/const factor = Math\.max/.test(pricing) ? ['discount', 'zero'] : []),
    ];
    if (!checks.length) {
      say(`  ${agent.name} mira ${task.id} y el cálculo todavía no soporta esos casos: espera a que se integre el arreglo`);
      return { kind: 'pass', payload: { reason: 'el cálculo aún no soporta estos casos; la cobertura espera al arreglo' } };
    }
  } else if (/descuento|discount/i.test(text)) {
    nextPricing = FIX_DISCOUNT(pricing);
    checks = ['discount'];
  } else {
    nextPricing = FIX_TOTAL(pricing);
    checks = ['qty'];
  }
  if (nextPricing !== pricing) files.push({ path: 'src/pricing.mjs', content: nextPricing });

  // La comprobación del proyecto viaja en el mismo parche.
  const nextTests = withAssertions(tests, checks);
  if (nextTests !== tests) files.push({ path: 'tests/check.mjs', content: nextTests });

  if (!files.length) {
    say(`  ${agent.name} mira ${task.id} y no encuentra nada que cambiar todavía: lo deja dicho`);
    return { kind: 'pass', payload: { reason: 'el repo ya cubre lo que pedía esta mejora' } };
  }

  say(`  ${agent.name} entrega parche para ${task.id}${task.attempts ? ` (intento ${task.attempts + 1})` : ''} (${files.map(f => f.path).join(', ')})`);
  return {
    kind: 'submit-patch',
    payload: {
      itemId: task.id,
      summary: `${String(task.title).slice(0, 90)} (con su caso en la comprobación)`,
      files,
    },
  };
}

main().catch(err => {
  console.error('\n  La demo falló:', err.message);
  process.exit(1);
});
