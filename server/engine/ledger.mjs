// AGORA v2 — libro mayor de la sala: lo que el plan AFIRMA, lo que el servidor MIDIÓ y lo
// que nadie comprobó.
//
// Por qué existe. Una sala puede cerrar con 209 comprobaciones en verde y un entregable que
// no cumple la primera cláusula del encargo, porque el resultado lo redactaba el modelo: la
// prosa del plan se copiaba al acta y las cifras las tecleaba quien cerraba. Aquí, en cambio:
//
//   · Toda afirmación del plan se TIPA (ejecutable / juicio / cifra de diseño). No es lo
//     mismo «check-params devuelve 63/63» que «no se ve cutre»: la primera se mide, la
//     segunda necesita un juez que no sea su autor, y la tercera es un número declarado sin
//     instrumento. Mezclarlas es cómo una cifra de diseño acaba contada como resultado.
//   · La evidencia la genera el SERVIDOR en el único punto donde ejecuta algo (runVerify), con
//     su comando, su código de salida y el commit sobre el que corrió. Nadie teclea un número.
//   · La mitad negativa se cuenta igual que la positiva: afirmaciones sin dueño, sin evidencia,
//     sin juez, decisiones votadas que nunca se materializaron y cláusulas del encargo que no
//     aparecen en el plan (derivación independiente: el encargo crudo contra el plan, sin pasar
//     por la agenda que la sala se escribió a sí misma).
//   · El alcance se comprueba ANTES de construir: si una tarea dice «añade src/x.js» y ese
//     archivo ya está en el repo, la sala lo sabe antes de gastar un turno — pasó de verdad:
//     se votó «añadir hull.js» cuando hull.js ya existía y pasaba sus 50 comprobaciones.
//
// Nada de este módulo toca el disco ni ejecuta nada: son funciones puras sobre el estado de la
// sala y sobre textos.

import { createHash } from 'node:crypto';
import { now, clampStr, clampText, gist, plural, uid } from './util.mjs';

const MAX_EVIDENCE = 240;

// ---------------------------------------------------------------- texto
// Prefijo de comparación: en español la misma idea cambia de sufijo (navegable / navegación),
// así que comparar palabras enteras falla justo donde importa. Cinco caracteres es suficiente
// para «naveg», «flotac», «comprob» y no tanto como para fusionar palabras distintas.
const PREFIX = 5;

export function tokensOf(text, min = PREFIX) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9ñ]+/)
    .filter(w => w.length >= min);
}

export function stemsOf(text) {
  return new Set(tokensOf(text).map(w => w.slice(0, PREFIX)));
}

export function containmentOf(a, b) {
  const A = typeof a === 'string' ? stemsOf(a) : a;
  const B = typeof b === 'string' ? stemsOf(b) : b;
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared += 1;
  return shared / Math.min(A.size, B.size);
}

// ---------------------------------------------------------------- tipado de afirmaciones
// Un tipo por afirmación, decidido por su forma, no por su importancia:
//   executable — nombra un comando o una ruta con la que se puede medir.
//   juicio     — habla de cómo se ve, se siente o se disfruta: hace falta un juez humano.
//   cifra      — declara un número sin instrumento (un palo de 60 m, 60 fps objetivo).
const JUDGMENT_RE = new RegExp([
  'se ve', 'se vea', 'se vean', 'se ven', 'aspecto', 'apariencia', 'estilo', 'estetic',
  'estétic', 'visual', 'cutre', 'bonito', 'elegante', 'divertid', 'sensaci', 'se siente',
  'juicio', 'legib', 'pulido', 'agradable', 'feo', 'se lee bien', 'espuma', 'silueta',
  'toon', 'cel-shading', 'cel shading', 'parece', 'parezca', 'se distingue', 'a ojo',
].join('|'), 'i');

const COMMAND_RE = /`[^`\n]{3,120}`|\b(?:npm|pnpm|yarn|bun)\s+run\s+[\w:.-]+|\bnode\s+[\w./-]+\.(?:mjs|js|cjs)|\bpython3?\s+[\w./-]+|\bnpx\s+[\w@/.-]+|\b(?:pytest|go test|cargo test|make\s+\w+)\b/g;

export const FILE_RE = /[\w][\w./-]*\.(?:mjs|cjs|js|ts|tsx|jsx|glsl|vert|frag|json|md|py|go|rs|java|c|h|cpp|html|css|ya?ml|sh|toml|txt)\b/gi;

const DESIGN_RE = /\b\d+(?:[.,]\d+)?\s*(?:m\b|km\b|cm\b|mm\b|kg\b|ms\b|s\b|hz\b|fps\b|px\b|°|metros?\b|segundos?\b|cuadros?\b|grados?\b|nudos?\b)/i;

// Verbos de construcción: lo que se puede comprobar contra el repo antes de trabajar.
const CREATE_RE = /\b(a[ñn]ad[ie]|a[ñn]ade|crea|crear|cree|implementa|implementar|escribe|escribir|genera|generar|a[ñn]adir|incorpora|incorporar|monta|montar|introduce|introducir|add|create|implement|write)\b/i;

// Qué clase de afirmación es. El orden importa: una frase que habla de cómo se ve es un
// juicio aunque mencione una ruta, porque un archivo no prueba que se vea bien.
export function classifyClaim(text) {
  const t = String(text || '');
  const refs = claimRefs(t);
  const judge = t.match(JUDGMENT_RE);
  if (judge && !refs.commands.length) {
    return { type: 'juicio', because: `habla de lo que se ve o se siente («${gist(judge[0], 40)}») sin un comando que lo mida`, refs };
  }
  if (refs.commands.length) {
    return { type: 'executable', because: `nombra un comando ejecutable (\`${gist(refs.commands[0], 40)}\`)`, refs };
  }
  if (refs.files.length && /(verde|en rojo|exit|c[oó]digo|comprob|check|test|npm|medici[oó]n)/i.test(t)) {
    return { type: 'executable', because: `nombra ${plural(refs.files.length, 'archivo')} y una comprobación`, refs };
  }
  if (DESIGN_RE.test(t)) {
    return { type: 'cifra', because: 'declara una magnitud sin instrumento declarado', refs };
  }
  if (judge) {
    return { type: 'juicio', because: `apela a lo que se ve («${gist(judge[0], 40)}»)`, refs };
  }
  return { type: 'sin-clasificar', because: 'no nombra ni un comando ni un juicio ni una cifra', refs };
}

// Lo que una afirmación nombra: comandos, rutas, símbolos entre acentos graves y números.
export function claimRefs(text) {
  const t = String(text || '');
  const commands = [];
  for (const m of t.matchAll(COMMAND_RE)) {
    const raw = m[0].replace(/^`|`$/g, '').trim();
    // Un acento grave con una sola palabra («`noche`») es una clave del dominio, no un comando.
    if (!raw || (!/\s/.test(raw) && !/^(?:npm|node|npx|python|pnpm|yarn|bun|pytest|go|cargo|make)\b/.test(raw))) continue;
    if (!commands.includes(raw) && raw.length <= 140) commands.push(raw);
  }
  const files = [];
  for (const m of t.matchAll(FILE_RE)) {
    const p = m[0].replace(/^\.\//, '').replace(/[.,;:)]+$/, '');
    if (p.length <= 140 && !files.includes(p)) files.push(p);
  }
  const symbols = [];
  for (const m of t.matchAll(/`([^`\n]{2,60})`/g)) {
    const s = m[1].trim();
    if (s && !files.includes(s) && !commands.includes(s) && !symbols.includes(s)) symbols.push(s);
  }
  const numbers = (t.match(/\d+(?:[.,]\d+)?/g) || []).slice(0, 8);
  return { commands: commands.slice(0, 6), files: files.slice(0, 8), symbols: symbols.slice(0, 8), numbers };
}

// Las afirmaciones de un plan: sus viñetas y frases con contenido, sin los encabezados ni las
// líneas que solo anuncian una sección. No se interpreta el plan, se trocea.
export function claimsInPlan(plan, { limit = 44 } = {}) {
  const out = [];
  const seen = new Set();
  const lineas = String(plan || '').replace(/\r\n?/g, '\n').split('\n');
  const push = (text) => {
    const t = clampStr(text.replace(/^[\s>*\-•\d.)(]+/, '').replace(/[*_`]/g, ''), 400);
    if (!t) return;
    // El mínimo se cuenta con las palabras DE LA FRASE, no con sus raíces: `tokensOf` filtra
    // las palabras cortas, así que una frase corta y decisiva («El barco no se ve cutre») se
    // quedaba fuera por tener tres raíces. Era exactamente la clase de afirmación que el juicio
    // visual existe para cerrar, y desaparecía antes de llegar al libro.
    const palabras = t.split(/\s+/).filter(Boolean).length;
    if (palabras < 4 || t.length < 12) return;
    const clave = [...stemsOf(t)].sort().slice(0, 6).join('-');
    if (!clave || seen.has(clave)) return;
    seen.add(clave);
    out.push(t);
  };
  for (const linea of lineas) {
    const l = linea.trim();
    if (!l) continue;
    if (/^#{1,6}\s/.test(l)) continue;                                  // encabezado
    if (/^\|/.test(l)) continue;                                        // tabla
    if (/^-{3,}$/.test(l)) continue;
    // Viñeta numerada o con guion: una afirmación por viñeta. Si es una frase larga con
    // varios puntos, se parte, porque cada punto suele ser una afirmación distinta.
    const esVineta = /^([-*•]|\d{1,2}[.)])\s+/.test(l);
    const trozos = l.length > 160 ? l.split(/(?<=[.;])\s+/) : [l];
    for (const trozo of trozos) {
      if (!esVineta && !trozos.length) continue;
      push(trozo);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

// ---------------------------------------------------------------- el encargo (derivación independiente)
// El encargo crudo del humano, troceado en cláusulas. Es la única fuente que la sala no
// escribió, así que contrastarlo con el plan es lo más parecido a una derivación independiente
// que se puede hacer sin otro agente: la cláusula «debe ser navegable» no aparece en el plan y
// el acta lo dice, en vez de cerrar con 209 comprobaciones verdes y un barco quieto.
const STOP = new Set([
  'para', 'como', 'cuando', 'donde', 'porque', 'sobre', 'entre', 'desde', 'hasta', 'sino',
  'tiene', 'tienen', 'debe', 'deben', 'puede', 'pueden', 'hacer', 'hace', 'todo', 'toda',
  'todos', 'todas', 'esto', 'esta', 'este', 'esos', 'esas', 'unos', 'unas', 'deberia',
  'necesita', 'necesitan', 'quiero', 'ademas', 'tambien', 'mismo', 'misma', 'forma',
]);

export function askClauses(text, { limit = 16 } = {}) {
  const out = [];
  const seen = new Set();
  const bloques = String(text || '').replace(/\r\n?/g, '\n').split(/\n+/);
  for (const bloque of bloques) {
    const limpio = bloque.replace(/^[\s>*\-•\d.)(]+/, '').trim();
    if (!limpio) continue;
    for (const trozo of limpio.split(/(?<=[.;:])\s+|\s+[—–]\s+/)) {
      const t = clampStr(trozo, 300);
      if (!t) continue;
      const utiles = tokensOf(t).filter(w => !STOP.has(w.slice(0, 8)));
      if (utiles.length < 2) continue;                                 // «y sí» no es una cláusula
      const clave = [...stemsOf(utiles.join(' '))].sort().slice(0, 5).join('-');
      if (!clave || seen.has(clave)) continue;
      seen.add(clave);
      out.push(t);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

// Qué cláusula está cubierta por qué afirmación. El umbral es deliberadamente bajo (0,34): una
// cláusula del encargo puede estar cubierta por una frase que la reescribe entera, y aquí el
// coste de un falso «cubierta» es una omisión, mientras que el de un falso «sin cobertura» es
// ruido que enseña a ignorar el informe.
export function coverageOf(clauses, against, { threshold = 0.34 } = {}) {
  const candidatos = (against || []).map(({ id, text }) => ({ id, text, stems: stemsOf(text) }));
  return clauses.map(clause => {
    const stems = stemsOf(clause);
    let best = null;
    for (const c of candidatos) {
      if (!c.stems.size) continue;
      let shared = 0;
      for (const w of stems) if (c.stems.has(w)) shared += 1;
      const ratio = shared / Math.min(stems.size, c.stems.size);
      if (!best || ratio > best.ratio) best = { id: c.id, text: c.text, ratio };
    }
    return {
      clause,
      covered: !!(best && best.ratio >= threshold),
      by: best && best.ratio >= threshold ? best.id : null,
      ratio: best ? Math.round(best.ratio * 100) / 100 : 0,
    };
  });
}

// ---------------------------------------------------------------- evidencia
// La huella de una medición: comando + árbol medido + salida. Dos corridas que miden lo mismo
// sobre el MISMO árbol producen la misma huella, así que un hecho medido se cita en vez de
// volver a medirse y nadie puede «descubrir» dos veces lo mismo en ciclos distintos. El árbol
// entra en la huella: una verificación sobre el parche de la tarea w1 y la línea base no son la
// misma medición aunque el comando y la salida coincidan.
export function evidenceHash({ command, commit, output, itemId = null, verifiedTree = null, dirty = false }) {
  const base = `${String(command || '')}\n${String(commit || '')}\n${itemId ? `tarea:${itemId}` : 'arbol:head'}\n${String(output || '')}`;
  return 'e' + createHash('sha256').update(base + (verifiedTree || dirty ? `\ntree:${verifiedTree || 'unknown'};dirty:${!!dirty}` : '')).digest('hex').slice(0, 16);
}

export function evidenceList(room) {
  return Array.isArray(room?.artifacts?.evidence) ? room.artifacts.evidence : [];
}

// Registra una medición HECHA POR EL SERVIDOR. `itemId` ata la medición al árbol de una tarea
// (una verificación sobre un parche staged certifica ese contenido, no el HEAD del momento);
// sin `itemId` la medición describe el HEAD de entonces y caduca en cuanto la rama se mueve.
export function recordEvidence(room, {
  command = '', exitCode = null, ok = null, output = '', commit = null, dirty = false,
  kind = 'verify', by = null, itemId = null, note = null, verifiedTree = null,
} = {}) {
  if (!room?.artifacts) return { entry: null, reused: false };
  const list = evidenceList(room);
  const out = typeof output === 'string' ? output : '';
  const hash = evidenceHash({ command, commit, output: out, itemId, verifiedTree, dirty });
  const prev = list.find(e => e.hash === hash);
  if (prev) {
    prev.uses = (prev.uses || 1) + 1;
    prev.lastAt = now();
    // Una medición de la línea base y otra del árbol de una tarea pueden coincidir (mismo
    // comando, mismo commit, misma salida): entonces la que no estaba atada a ninguna tarea
    // adopta el vínculo, que es información, no un dato nuevo.
    if (itemId && !prev.itemId) { prev.itemId = String(itemId).slice(0, 20); prev.dirty = true; }
    return { entry: prev, reused: true };
  }
  const entry = {
    id: uid('e'),
    hash,
    kind,
    command: clampStr(command, 300),
    verifiedTree,
    exitCode: Number.isFinite(exitCode) ? exitCode : null,
    ok: ok === null ? null : !!ok,
    commit: commit ? String(commit) : null,
    dirty: !!dirty,
    itemId: itemId ? String(itemId).slice(0, 20) : null,
    by: by || 'servidor',
    at: now(),
    outputChars: out.length,
    outputTail: clampText(out, 4_000),
    note: note ? clampStr(note, 200) : null,
    uses: 1,
  };
  list.push(entry);
  room.artifacts.evidence = list.length > MAX_EVIDENCE ? list.slice(list.length - MAX_EVIDENCE) : list;
  return { entry, reused: false };
}

// Qué evidencia sigue diciendo algo sobre el árbol que hay AHORA. Tres estados, y cada uno
// significa una cosa distinta:
//   fresca      — certifica contenido que está en la rama (la tarea que la produjo se integró).
//   provisional — el árbol estaba en vuelo (parche staged, tarea sin integrar): mide algo
//                 que todavía no es la rama.
//   caduca      — mide un commit que ya no es el HEAD, o contenido que se deshizo después.
export function evidenceStatus(room, entry) {
  const head = room?.repo?.head || null;
  if (entry.itemId) {
    const item = room?.work?.items?.[entry.itemId];
    if (!item) return 'provisional';
    if (item.status === 'integrated' && !item.revert) return 'fresca';
    if (item.status === 'reverted') return 'caduca';
    return 'provisional';
  }
  if (!entry.commit) return 'provisional';
  if (!head) return 'caduca';
  return entry.commit === head ? 'fresca' : 'caduca';
}

export function evidenceOf(room) {
  const entries = evidenceList(room).map(e => ({ ...e, status: evidenceStatus(room, e) }));
  return {
    entries,
    total: entries.length,
    frescas: entries.filter(e => e.status === 'fresca').length,
    provisionales: entries.filter(e => e.status === 'provisional').length,
    caducas: entries.filter(e => e.status === 'caduca').length,
    reutilizadas: entries.filter(e => (e.uses || 1) > 1).length,
    porComando: [...entries.reduce((m, e) => m.set(e.command, (m.get(e.command) || 0) + 1), new Map())]
      .map(([command, count]) => ({ command, count })),
  };
}

// ---------------------------------------------------------------- falsabilidad
// Una comprobación que no puede fallar no es una comprobación: es relleno que infla el recuento
// verde. Existe de verdad en los repos (un `if (1 + 1 === 3) bad++` contado dentro del total), y
// el servidor al menos puede negarse a contar como evidencia lo que no es falsable.
const FALSABLE_RE = /(====?|!==?|<=?|>=?|≠|igual|mayor|menor|antes|después|debe|no puede|c[oó]digo|exit|en verde|en rojo|devolver|espera|difiere|contiene|coincide)/i;

export function falsifiabilityOf(check) {
  const method = String(check?.method ?? check?.how ?? '');
  const expectation = String(check?.expectation ?? check?.expected ?? '');
  if (method.trim().length < 3) return { falsifiable: false, because: 'no dice CÓMO se comprueba' };
  if (expectation.trim().length < 3) return { falsifiable: false, because: 'no dice QUÉ se espera' };
  if (!FALSABLE_RE.test(expectation) && !/\d/.test(expectation)) {
    return { falsifiable: false, because: 'la expectativa no tiene comparación ni cifra: no se puede falsar' };
  }
  return { falsifiable: true, because: null };
}

export function vacuousChecks(checks) {
  const out = [];
  for (const c of checks || []) {
    const v = falsifiabilityOf(c);
    if (!v.falsifiable) {
      out.push({
        id: c.id || null,
        by: c.by || null,
        claim: clampStr(c.claim, 200),
        because: v.because,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- alcance y conflictos
// ¿La tarea pide construir algo que ya está? Mira las rutas que nombra contra el índice del
// repo y los símbolos que cita contra una búsqueda acotada. Devuelve un veredicto, no una
// decisión: el servidor AVISA (y lo publica), no le quita la tarea a nadie.
export function scopeVerdict({ refs, existingPaths = [], existingSymbols = [], creating = false }) {
  const paths = (refs?.files || []).map(p => p.toLowerCase());
  const hay = new Set((existingPaths || []).map(p => String(p).toLowerCase()));
  const presentes = paths.filter(p => hay.has(p));
  if (presentes.length && creating && presentes.length >= paths.length) {
    return {
      verdict: 'ya-existe',
      because: `${plural(presentes.length, 'ruta')} que la tarea manda CREAR ya ${presentes.length === 1 ? 'está' : 'están'} en el repo`,
      hit: presentes[0],
    };
  }
  if (presentes.length) {
    return {
      verdict: 'a-verificar',
      because: `${plural(presentes.length, 'ruta')} de la tarea ya existe(n) en el repo: comprueba si es continuar o rehacer`,
      hit: presentes[0],
    };
  }
  const sym = (existingSymbols || [])[0] || null;
  if (sym && creating) {
    return {
      verdict: 'ya-existe',
      because: `la tarea manda construir algo y el símbolo «${gist(sym.symbol || sym.query, 40)}» ya aparece en el repo`,
      hit: sym.file ? `${sym.file}${sym.line ? `:${sym.line}` : ''}` : null,
    };
  }
  if (sym) {
    return { verdict: 'a-verificar', because: `el símbolo «${gist(sym.symbol || sym.query, 40)}» ya existe en el repo`, hit: sym.file || null };
  }
  return { verdict: paths.length ? 'nuevo' : 'sin-indicios', because: paths.length ? 'ninguna ruta de la tarea existe todavía' : 'la tarea no nombra rutas ni símbolos que se puedan buscar', hit: null };
}

export function isCreating(text) {
  return CREATE_RE.test(String(text || ''));
}

// Reclamos que pisan los mismos archivos: se detectan al crear las tareas y el motor se niega a
// tenerlos EN VUELO a la vez. Tres parches del debate tocaron el mismo contrato de URL y dos
// tocaron el mismo archivo: eso se pagó en rebases manuales que nadie había pedido.
export function sharedFiles(a, b) {
  const A = new Set((a || []).map(f => String(f).toLowerCase()));
  return (b || []).map(f => String(f).toLowerCase()).filter(f => A.has(f));
}

// Tareas que se pisan con esta: las abiertas (en vuelo) bloquean el reclamo, las demás solo
// avisan. Nunca se reordena la cola por esto: el humano y los agentes deciden, el servidor dice.
export function fileConflicts(items, item) {
  const out = [];
  for (const other of items) {
    if (!other || other.id === item.id) continue;
    const shared = sharedFiles(item.files, other.files);
    if (!shared.length) continue;
    out.push({ id: other.id, files: shared, status: other.status, inFlight: ['claimed', 'in-review', 'verifying'].includes(other.status) });
  }
  return out;
}
