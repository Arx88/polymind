// AGORA v2 — configuración portable de una sala.
//
// Una sala cerrada es historia, pero su configuración es material reutilizable: la tarea, el
// contexto, los criterios, la agenda de decisión, las reglas, el repo y quién la debatió.
// Esto es lo que permite verla entera en un sitio y volver a convocarla sin volver a
// escribir nada.
//
// No sale de aquí nada que solo tenga sentido dentro de aquella sala: ni tokens, ni el estado
// del debate, ni las rutas del clon de trabajo. `repo.path` es la ruta del proyecto ORIGINAL
// (la que declaró el humano), de modo que reabrir vuelve a clonar desde el mismo sitio.
// Un scaffold no tiene origen reutilizable: «proyecto nuevo» es una etiqueta, NO una ruta.

function verifyCommandOf(repo) {
  if (!repo) return '';
  if (typeof repo.verify === 'string') return repo.verify;
  return repo.verify?.command || '';
}

export function roomConfig(room) {
  const s = room.settings || {};
  const repo = room.repo || null;
  const roster = (room.order || []).map(id => {
    const a = room.agents?.[id] || {};
    return { name: a.name || id, harness: a.harness || '', model: a.model || '' };
  });
  return {
    from: room.code,
    title: room.title || '',
    task: room.task || '',
    context: room.context || '',
    criteria: room.criteria || '',
    language: s.language || 'es',
    tone: s.tone || '',
    template: room.template || null,
    agenda: (room.agenda || []).map(p => ({
      label: p.label,
      options: (p.options || []).map(o => (typeof o === 'string' ? o : o.label)),
      weight: p.weight ?? 1,
    })),
    // Copia profunda: quien lea la configuración no puede tocar los ajustes de la sala viva.
    settings: JSON.parse(JSON.stringify(s)),
    repo: repo && !repo.greenfield && repo.kind !== 'scaffold' ? {
      path: repo.source || null,
      kind: repo.kind || null,
      ref: repo.ref ?? null,
      verify: verifyCommandOf(repo),
      pushTo: repo.pushTo ?? null,
    } : null,
    roster,
    origin: {
      at: room.createdAt || null,
      status: room.status || null,
      phase: room.phase?.name || null,
      outcome: room.result?.outcome || null,
      checksum: room.result?.checksum || null,
      agents: roster.length,
    },
    tournament: room.tournament
      ? { id: room.tournament.id ?? null, angle: room.tournament.angle ?? null, round: room.tournament.round ?? null }
      : null,
  };
}

// El input de createRoom equivalente: reabrir una sala con la configuración de otra.
export function roomInputFromConfig(config = {}) {
  const c = config || {};
  return {
    title: c.title || '',
    task: c.task || '',
    context: c.context || '',
    criteria: c.criteria || '',
    agenda: c.agenda || [],
    template: c.template || null,
    settings: c.settings || {},
    repo: c.repo?.path
      ? { path: c.repo.path, ref: c.repo.ref ?? null, verify: c.repo.verify || '', pushTo: c.repo.pushTo ?? null }
      : null,
  };
}

// La misma configuración, en la forma de una plantilla reutilizable (templates/*.json).
export function templateFromConfig(config = {}, { id = null, name = null, description = null, icon = null, order = 50 } = {}) {
  const c = config || {};
  const t = {
    name: name || c.title || (c.task || '').slice(0, 60) || 'Plantilla',
    description: description || (c.task || '').slice(0, 160),
    icon: icon || 'doc',
    order,
    roomTitle: c.title || '',
    task: c.task || '',
    context: c.context || '',
    criteria: c.criteria || '',
    agenda: c.agenda || [],
    settings: c.settings || {},
    savedFrom: c.from || null,
  };
  if (id) t.id = id;
  return t;
}
