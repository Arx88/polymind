// AGORA v2 — utilidades puras compartidas por todo el motor.
// Sin dependencias. Nada aquí toca el disco ni la red.

import { createHash, randomBytes } from 'node:crypto';

export function now() { return Date.now(); }
export function uid(prefix) { return prefix + randomBytes(5).toString('hex'); }
export function token() { return randomBytes(12).toString('base64url'); }

// Coerción laxa: números y booleanos se aceptan como texto; lo demás se descarta.
export function clampStr(v, max) {
  if (v == null) return '';
  if (typeof v !== 'string') {
    if (typeof v === 'number' || typeof v === 'boolean') v = String(v);
    else return '';
  }
  const t = v.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max) : t;
}

// Como clampStr pero conserva saltos de línea (planes, síntesis).
export function clampText(v, max) {
  if (v == null) return '';
  if (typeof v !== 'string') {
    if (typeof v === 'number' || typeof v === 'boolean') v = String(v);
    else return '';
  }
  const t = v.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim();
  return t.length > max ? t.slice(0, max) : t;
}

// Techo de los techos: existe solo para que un payload absurdo no reserve memoria sin
// límite. Todo lo que quepa por debajo de esta cifra se guarda tal cual.
const SAFETY_CHARS = 50_000_000;

// Un movimiento bienintencionado nunca se recorta a oscuras. Los techos de la sala son
// protecciones del servidor (megabytes, no párrafos): si alguna vez muerden, el agente se
// entera en la respuesta de su movimiento y puede reenviar por partes, en vez de perder el
// final de su razonamiento sin saberlo. `warnings` es el array que el movimiento devuelve.
// `raw` para lo que NO se puede normalizar sin romperlo: un diff unificado pierde su
// sentido si se le quitan los espacios finales de las líneas de contexto, y el contenido
// de un archivo es del agente, no del servidor. Ahí solo se aplica el techo, sin tocar el
// texto (igual que `keepLines`, pero byte a byte tal como llegó).
export function fit(value, max, field, warnings = [], { keepLines = false, raw = false } = {}) {
  if (raw) {
    const s = typeof value === 'string' ? value : '';
    const out = s.length > max ? s.slice(0, max) : s;
    if (s.length > out.length) {
      warnings.push(`${field}: enviaste ${s.length} caracteres y el techo de esta sala está en ${max}; ` +
        `se guardaron los primeros ${max} y el resto se descartó. Si necesitas conservarlo entero, mándalo en partes.`);
    }
    return out;
  }
  const whole = keepLines ? clampText(value, SAFETY_CHARS) : clampStr(value, SAFETY_CHARS);
  const out = keepLines ? clampText(value, max) : clampStr(value, max);
  if (whole.length > out.length) {
    warnings.push(`${field}: enviaste ${whole.length} caracteres y el techo de esta sala está en ${max}; ` +
      `se guardaron los primeros ${max} y el resto se descartó. Si necesitas conservarlo entero, mándalo en partes.`);
  }
  return out;
}

// Lo mismo para listas: si una crítica trae más objeciones que el techo, o un parche más
// archivos, lo que se queda fuera se dice en vez de desaparecer.
export function fitList(value, max, field, warnings = []) {
  const items = arr(value);
  if (items.length > max) {
    warnings.push(`${field}: enviaste ${items.length} elementos y el techo de esta sala está en ${max}; se procesaron los primeros ${max}.`);
  }
  return items.slice(0, max);
}

export function gist(text, n = 220) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

// Clave canónica para puntos de la agenda y opciones: minúsculas, sin acentos,
// solo [a-z0-9-]. Determinista para que dos agentes escriban la misma clave.
export function slug(value, max = 48) {
  const t = String(value || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return t.slice(0, max).replace(/-+$/g, '');
}

export function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

export function checksumOf(obj) {
  return 'sha256:' + createHash('sha256').update(stableStringify(obj)).digest('hex');
}

// Estimación de coste: ~3.5 caracteres por token en español/inglés mezclado.
export function estTokens(chars) { return Math.round((Number(chars) || 0) / 3.5); }

// Plural de verdad para todo lo que lee el humano (registro, acta, panel): «3 punto(s)»
// se lee mal, y repetido en cada línea hace que el salón parezca a medio hacer. Por defecto
// basta con añadir «s»; las palabras en -ción/-sión/-ón llevan su plural explícito.
export function plural(n, one, many = `${one}s`) {
  const count = Number(n) || 0;
  return `${count} ${count === 1 ? one : many}`;
}

// «1 agente no presentó» / «3 agentes no presentaron»: concordancia sin repetir el número.
export function pluralVerb(n, one, many) {
  return Number(n) === 1 ? one : many;
}

export function bytesOf(value) {
  if (value == null) return 0;
  return typeof value === 'string' ? value.length : JSON.stringify(value).length;
}

export function medianOf(sortedAsc) {
  const n = sortedAsc.length;
  if (!n) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 ? sortedAsc[mid] : Math.min(sortedAsc[mid - 1], sortedAsc[mid]);
}

export function uniq(list) { return [...new Set(list)]; }

export function arr(v) { return Array.isArray(v) ? v : (v == null ? [] : [v]); }
export function obj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }
export function oneOf(v, list, dflt) { return list.includes(v) ? v : dflt; }
export function num(v, dflt, min = -Infinity, max = Infinity) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

// Similitud de conjuntos (0 = nada en común, 1 = idénticos).
export function jaccard(a, b) {
  const A = new Set(a), B = new Set(b);
  if (!A.size && !B.size) return 1;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const union = A.size + B.size - inter;
  return union ? inter / union : 0;
}

export class DebateError extends Error {
  constructor(code, message, extra = null) {
    super(message);
    this.name = 'DebateError';
    this.code = code;
    this.extra = extra;
  }
}

// Códigos que el transporte HTTP traduce a un estado concreto.
export const HTTP_STATUS = {
  unauthorized: 401, unknown_agent: 404, not_found: 404,
  closed_to_join: 409, closed: 409, duplicate: 409, wrong_phase: 409, project_unavailable: 409,
  not_assigned: 409, not_author: 409, too_few: 409, no_vacancy: 409, not_diverse: 409, busy: 409,
  bad_json: 400, bad_task: 400, bad_payload: 400, bad_op: 400, bad_move: 400,
  too_large: 413, unchanged: 304,
};
