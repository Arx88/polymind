// AGORA v2 — plantillas de debate. Son archivos JSON editables en templates/:
// cada una fija tarea, criterios, agenda de decisión y ritmo.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// La carpeta de plantillas se puede cambiar por entorno (AGORA_TEMPLATES), igual que la de
// datos: sirve para desplegar plantillas propias y para que las pruebas no escriban en las
// del repositorio al probar «guardar esta sala como plantilla».
const DIR = process.env.AGORA_TEMPLATES || path.join(__dirname, '..', 'templates');

let cache = null;
let cacheKey = '';

// Las plantillas son archivos editables a mano, así que la lista en memoria caduca en cuanto
// alguien añade, edita o borra uno. La firma del directorio (nombres + mtime + tamaño) basta
// para detectarlo sin releer y reparsar cada JSON: sin esto, una plantilla borrada del disco
// seguía apareciendo en el panel hasta reiniciar el servidor.
function dirKey() {
  try {
    return fs.readdirSync(DIR).filter(f => f.endsWith('.json')).sort()
      .map(f => {
        try { const st = fs.statSync(path.join(DIR, f)); return `${f}:${st.mtimeMs}:${st.size}`; }
        catch { return null; }
      })
      .filter(Boolean).join('|');
  } catch { return ''; }
}

export function listTemplates({ fresh = false } = {}) {
  const key = dirKey();
  if (cache && !fresh && key === cacheKey) return cache;
  const out = [];
  let files = [];
  try { files = fs.readdirSync(DIR).filter(f => f.endsWith('.json')); } catch { files = []; }
  for (const f of files) {
    try {
      const t = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
      if (!t.id) t.id = f.replace(/\.json$/, '');
      out.push(t);
    } catch { /* plantilla inválida: se ignora */ }
  }
  out.sort((a, b) => (a.order ?? 99) - (b.order ?? 99) || a.name.localeCompare(b.name));
  cache = out;
  cacheKey = key;
  return out;
}

export function getTemplate(id) {
  return listTemplates().find(t => t.id === id) || null;
}

// Guardar una sala como plantilla: la configuración de un debate que ya funcionó pasa a ser
// una plantilla más de la carpeta, sin editar JSON a mano. El id sale del nombre y, si ya
// existe, se añade sufijo en vez de pisar la plantilla anterior (pisarla sería perder
// trabajo sin avisar; quien quiera hacerlo lo pide con `overwrite`).
export function saveTemplate(template, { overwrite = false } = {}) {
  const t = { ...(template || {}) };
  const base = slugify(t.id || t.name || t.roomTitle || '') || 'plantilla';
  fs.mkdirSync(DIR, { recursive: true });
  let id = base;
  for (let n = 2; !overwrite && fs.existsSync(path.join(DIR, id + '.json')); n++) id = `${base}-${n}`;
  t.id = id;
  if (!t.name) t.name = t.roomTitle || String(t.task || '').slice(0, 60) || 'Plantilla';
  t.savedAt = Date.now();
  fs.writeFileSync(path.join(DIR, id + '.json'), JSON.stringify(t, null, 2) + '\n');
  cache = null;   // la próxima lectura ya ve la plantilla nueva
  cacheKey = '';
  return t;
}

function slugify(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

// Convierte una plantilla en el input de createRoom.
export function roomInputFromTemplate(template, overrides = {}) {
  const t = template || {};
  return {
    title: overrides.title || t.roomTitle || '',
    task: overrides.task || t.task || '',
    context: overrides.context ?? t.context ?? '',
    criteria: overrides.criteria ?? t.criteria ?? '',
    agenda: overrides.agenda || t.agenda || [],
    template: t.id || null,
    settings: { ...(t.settings || {}), ...(overrides.settings || {}) },
  };
}
