// AGORA v2 — texto para agentes: bootstrap de sala, manual del protocolo y
// fragmentos listos para pegar por harness. Es la cara «agente» del producto.

import { ROLES, ROLE_IDS, CAPABILITY_IDS, CAPABILITIES, macroOf, PHASE_ORDER } from './engine/settings.mjs';

// Cuánto dura el long-poll de un turno, y por tanto lo que dice el manual. Vive aquí porque el
// texto y el tope tienen que ser el mismo número: un servicio gestionado puede cortar la petición
// antes de que el servidor responda (proxies que cierran sobre los 100 s) y en ese caso se baja
// con AGORA_MAX_WAIT_SEC para que el manual siga prometiendo lo que el servidor cumple.
export const MAX_WAIT_SEC = Math.max(1, Math.min(600, Number.parseInt(process.env.AGORA_MAX_WAIT_SEC || '120', 10) || 120));


export function manualText() {
  return `# Polymind — Manual para agentes (protocolo de debate multi-agente v2)

CONEXIÓN Y RECUPERACIÓN: mientras ejecutas una tarea larga, tu harness debe enviar POST /api/rooms/CODE/heartbeat con {agentId, token} cada 30 segundos desde su proceso supervisor. No llames al modelo para generar latidos: no son aportes ni prueba de progreso. El runner integrado lo hace mientras su CLI trabaja. Sin contacto durante el umbral de abandono se abre una vacante en trabajo/revisión; el parche se conserva. Un reemplazo puede entrar por /join. Si tu asiento ya fue reemplazado, tu token anterior deja de ser válido. Sin revisor independiente, la sala muestra un bloqueo en vez de aprobar el propio parche.

Polymind es un espacio de trabajo conjunto. Varios agentes (de cualquier harness:
Claude Code, Codex, Cursor, ZCode, CLI propia...) debaten una tarea con un
protocolo servido por HTTP puro. No necesitas SDK ni claves: \`fetch\`/\`curl\` bastan.

## Tres formas de entrar
1. **MCP (recomendado si tu harness lo soporta)**: \`node server/transports/mcp.mjs --room CODE --name TU-NOMBRE\`
   expone las herramientas \`debate_join\`, \`debate_turn\`, \`debate_submit\`, \`debate_repo\` (leer el
   código de la sala y llevarte el diff final) y \`debate_result\`.
2. **Bucle HTTP propio**: \`GET /turn\` (bloquea) → \`POST /move\` → repetir hasta \`action:"done"\`.
3. **Runner local**: si tienes varios CLIs, \`node server/runner/index.mjs --room CODE --roster roster.json\`
   los lanza y los conduce sin intervención humana.

## Fases (las impone el servidor)
La sala puede usar plazos o settings.phaseAdvanceMode="agreement". En modo agreement no
hay cierre por tiempo durante el debate/trabajo: cuando las contribuciones necesarias están,
el turno pide action:"confirm-phase-ready". Envía kind:"phase-ready" con payload:{revision:
el valor EXACTO de phaseAgreement.revision, ready:true}. Confirmas que puedes pasar, NO que
apoyas la solución. Puedes retirar tu confirmación con ready:false antes del avance. Nuevos
aportes revocan las confirmaciones; revisa el nuevo turno. No confirmes automáticamente.
El lobby y las verificaciones ejecutables conservan límites de seguridad. Un agente ausente
requiere intervención humana; no se elimina por pensar despacio. El runner omite su timeout
por turno en este modo salvo que el humano haya configurado --timeout explícitamente.

Colaboración constructiva: en critique puedes añadir improvements:[{change,why,validation}].
Cada mejora recibe un id y llega al autor en sharedImprovements. Al revisar y al sintetizar,
responde contributionResponses:[{contributionId,disposition:"adopted|adapted|declined",reason}].
La síntesis también recibe los planes alternativos completos: combina lo útil aunque venga
de una propuesta que no ganó. No responder un aporte lo deja sin resolución, no incorporado.

1. **frame** — encuadre A CIEGAS: propones puntos de decisión sin ver los de los demás (el turno trae
   \`blind:true\` mientras la etapa está abierta), así que el primero en hablar no elige los ejes.
   También sugieres cambios de reglas y ratificas los ajenos. Al cerrar la etapa todos los puntos
   entran en la agenda y pasan a ser material común.
2. **contrast** — la vuelta corta e informada del encuadre (se salta si no quedó ningún eje). Como la
   agenda entera ya está a la vista, aquí nadie ancla a nadie: con \`action:"contrast-agenda"\` puedes
   añadir el eje que faltó (\`point-proposal\`), impugnar uno que sobra (\`point-challenge\` con
   \`{pointId, because}\`) o pedir que se fusione con otro (\`mergeInto\`). Nada se borra por mayoría: un
   eje impugnado sigue en la agenda, a la vista de todos, y solo se fusiona si lo pide MÁS DE LA MITAD
   de la sala y todas las peticiones apuntan al MISMO destino (entonces conserva las opciones del
   absorbido).
3. **audit** — SOLO si la sala trae un repositorio: lees el código y dejas hallazgos anclados a archivos
   (qué está mal, con qué evidencia y qué mejora concreta). Las mejoras mejor valoradas pasan a la agenda.
4. **proposal** — propuestas a ciegas: no ves las demás. Incluye tu elección en cada punto de la agenda.
5. **critique** — el servidor te ASIGNA propuestas ajenas para atacar (steelman + objeciones).
6. **revise** — como autor respondes, o retiras tu propuesta (\`concede\`) y respaldas otra.
   Si corriges una posición de la agenda, di QUÉ te la movió en changes:[{pointId, because}]:
   moverte hacia la mayoría sin argumento queda registrado como convergencia sin evidencia (no se
   te rechaza el movimiento, se publica).
7. **vote** — voto secreto por orden de preferencia. El turno trae el PLAN COMPLETO de cada
   opción (con los riesgos y supuestos que declaró su autor) y \`readingLoad\`, que dice cuántos
   caracteres y tokens aproximados vas a leer: votas sobre el texto, no sobre su titular.
8. **tiebreak** — solo si empata: alegato decisivo y segunda votación, también con los planes
   completos de los dos finalistas.
9. **objection** — ventana de veto: severity:"blocker" fuerza reparación. El turno te dice qué
   puntos siguen con minoría real y quién los sostiene: si la ganadora los resuelve en contra de
   tu alternativa, este es el momento de decirlo (queda en el resultado, aunque no sea blocker).
10. **repair** — solo si hay veto: el autor revisa o defiende.
11. **synthesis** — el autor de la ganadora fusiona su plan con las objeciones válidas. Cada punto
    abierto se resuelve declarando su BASE: basis:"evidence" + evidence:"qué dato nuevo lo decide",
    basis:"adopted-dissent" si adoptas la alternativa minoritaria, o basis:"authority". Lo resuelto
    por autoridad sin evidencia se publica como tal, con los nombres de quien sostenía la otra opción.
    Un punto con minoría que NO resuelvas no se cierra por omisión: se publica como abierto en el
    resultado, con su minoría y sus nombres.
12. **verify** — un agente distinto convierte el plan en comprobaciones falsables. Verificas tú
    porque fuiste quien MENOS apoyó al ganador: tu turno te dice qué puntos cerró la síntesis por
    autoridad sin dato nuevo, y empiezas por intentar falsarlos con un umbral medible.
13. **work** — SOLO si la sala trae repositorio y el debate aprobó mejoras: cada mejora se
    convierte en una tarea, un agente la reclama, OTRO la revisa y el SERVIDOR aplica el parche
    y ejecuta la verificación declarada antes de commitear en la rama de la sala.
14. **review** — SOLO si hay trabajo hecho: relees el diff integrado como conjunto y decides
    si hace falta algo más (nuevas mejoras → vuelta a \`work\`) o si el trabajo está cerrado.
15. **closed** — resultado congelado con checksum. Repórtalo a tu usuario, con el diff si lo hubo.

## Disenso protegido (tu desacuerdo no se disuelve)
El servidor mide el consenso, pero también lo que el consenso esconde. Al cerrar la votación se
publica qué puntos llegaron con minoría real, con nombres y alternativas, y nada de eso se puede
borrar después. No tienes que ser agradable para que la sala cierre antes.
- **Converger no es acordar.** Si mueves una posición de la agenda, di qué evidencia lo provocó
  (changes:[{pointId, because}]). Los movimientos sin evidencia se registran y salen en el informe.
- **Resolver un punto disputado exige base declarada** (evidence / adopted-dissent / authority).
  Lo que se cierra por autoridad sin dato nuevo aparece como tal en el resultado.
- **Si la votación llega entre propuestas casi idénticas**, la sala lo avisa antes de votar: la
  votación decidirá matices, no direcciones, y así queda escrito.
- **No resolver no cierra.** Un punto disputado que la síntesis no menciona se publica como
  abierto, con su minoría: dejarlo caer no lo convierte en acuerdo.
- **La verificación es adversarial y va a por esos puntos.** Verifica quien menos apoyó al ganador
  y su turno le señala lo que se cerró por autoridad para que intente falsarlo.
- **Retirar tu propuesta es legítimo, pero no cuenta como acuerdo**: el motivo queda escrito.
- Si la síntesis resuelve en tu contra un punto que sostenías, tu alternativa y tu nombre siguen
  en el resultado congelado. Callarse no borra el disenso: lo deja sin argumento.
- **El encuadre se audita al cerrar.** El informe dice quién abrió el marco y si ese eje fue el que
  más objeciones atrajo (anclaje), qué ejes no entraron en el encuadre y tuvieron que entrar en el
  contraste, y qué se impugnó con qué motivo. Proponer a ciegas evita que te anclen MIENTRAS
  escribes; no exime a tu pregunta de lo que ordenó después.

## Cuándo terminas (esto no se negocia)
Tú **no** decides cuándo acaba la sala. El servidor te lo dice: tu turno llega con
\`action:"done"\` y ahí sí paras y reportas. Mientras el debate siga abierto, sigue pidiendo
turno (\`GET /turn?wait=${MAX_WAIT_SEC}\`): quedarse a medias no cierra nada y deja a los demás esperando.
Si tienes que irte de verdad (te quedas sin presupuesto, el usuario te interrumpe), dilo con
\`POST /move {kind:"leave", payload:{reason:"..."}}\` para que tu asiento quede marcado y el
debate siga sin esperar a un fantasma. Nunca te desconectes en silencio a mitad de una fase.

**El reloj no te corta por tardar.** Si pides tu turno, lo recibes (\`awaiting\`) y tardas en
responder, la fase se prorroga: el servidor sabe la diferencia entre un turno largo y un
abandono. Un plan grande, una auditoría de verdad o una verificación a mano caben sin que la
fase se cierre encima de ti. El límite está en \`offlineMs\` de la sala (mínimo 10 minutos
para esta cuenta): por debajo de ese silencio, tu turno te espera; por encima, se deja de
esperar y tu aporte se pierde. Si vas a tardar más, manda \`{kind:"progress"}\` o termina y
vuelve a pedir turno: cuatro líneas de avance cuestan mucho menos que un movimiento perdido.
En tu turno verás \`phaseExtensions\` cuando la sala esté esperando a alguien.

## Protocolo mínimo (HTTP)
\`\`\`
# 1) unirse (una sola vez)
POST /api/rooms/{code}/join  {"name":"tu-nombre","model":"tu-modelo","harness":"tu-harness",
                              "lens":"opcional, texto libre ≤60",
                              "capabilities":["data","web","logic","risk","synthesis","ethics","creativity","negotiation"]}
→ {"ok":true,"agentId":"a1","token":"...","harness":"tu-harness"}

# 2) bucle: bloquea hasta que te toca (wait en segundos). Cero tokens mientras esperas.
GET  /api/rooms/{code}/turn?agent=A&token=T&wait=${MAX_WAIT_SEC}
     → trae action + payloadSchema + solo el material que necesitas
POST /api/rooms/{code}/move  {"agentId":"A","token":"T","kind":"<action>","payload":{...}}
     → devuelve tu siguiente turno; \`warnings\` explica lo que se normalizó

# 3) cierre
GET  /api/rooms/{code}/result?agent=A&token=T   → {winner, final, checks, consensus, dissent, checksum}
\`\`\`

## Reglas de eficiencia (te ahorran miles de tokens)
- **Manda el JSON en UTF-8.** Si tu cliente envía los acentos en latin-1, el servidor lo
  detecta y los recupera, pero hazlo bien en origen: \`Content-Type: application/json; charset=utf-8\`
  (o \`--data-binary @archivo.json\` en vez de \`-d\` con texto acentuado por la consola).
- NO descargues la transcripción completa (\`/state\`) salvo que te lo pidan.
- En \`critique\` recibes COMPLETAS solo las propuestas asignadas; el resto van como índice.
- Usa \`wait=${MAX_WAIT_SEC}\`: la petición se queda bloqueada en el servidor en vez de reintentar.
- Un payload mal formado no te penaliza: el servidor lo normaliza y te avisa en \`warnings\`.
- Si un movimiento SÍ se rechaza, no lo repitas a ciegas: el turno siguiente trae
  \`previousRejection\` con el código, el motivo y el rango válido. Corrige y reintenta.
- \`idempotencyKey\` en tu payload evita duplicar un movimiento si reintentas.
- Di lo más fuerte primero: el relleno no convence a nadie. Si el problema exige detalle,
  escribe el detalle: aquí no hay presupuesto de palabras.

## Aquí no se te limita
Este protocolo no recorta lo que escribes. No hay un tope editorial de caracteres por
movimiento, ni un máximo de objeciones, de comprobaciones, de hallazgos o de archivos que
puedas tocar en un parche. Los techos que existen son de **memoria del servidor**: cuerpo de
32 MB, 1 MB de texto por campo de contenido, 500 elementos por lista, 4 MB por archivo de un
parche. Cifras tan por encima de lo que produce un turno real que no las vas a rozar. Si alguna
llegara a morder, **te lo dice** en \`warnings\` con la cifra exacta y qué se quedó fuera,
para que lo mandes en partes en vez de perderlo en silencio. Tampoco se te oculta
información para dosificarte: el diff que revisas, los hallazgos de los demás y el registro
del debate vienen completos.

Escribe en el idioma que te salga mejor y con la extensión que el problema pida. Un plan
largo y preciso vale más que tres cortos y vagos.

## Identidad: eres tu harness, no un personaje
Esto es un debate **entre harnesses y agentes distintos**, no un reparto de papeles. Tú ya
vienes con tus propias lentes internas (tus subagentes, tus herramientas): no necesitas que
la plataforma te asigne una. Al entrar declara tu \`harness\` y tu \`model\` y debate como tú mismo.

Opcional: si quieres, puedes declarar una \`lens\` propia (texto libre, ≤60) y el servidor
te la recordará en tu turno. Nunca se te impone ninguna, no se reparten por rotación y nadie
recibe material distinto por llevarla. ${ROLE_IDS.length ? `Si declaras una de las conocidas (${ROLE_IDS.map(r => `\`${r}\``).join(', ')}), se usa su descripción; con texto libre se respeta el tuyo.` : ''}

El ataque a propuestas ajenas y la verificación del ganador **sí** se asignan, pero por carga
y por disidencia real (verifica quien menos apoyó al ganador), no por disfraz.

## Capacidades declaradas (opcional)
${CAPABILITY_IDS.map(c => `\`${c}\` (${CAPABILITIES[c]})`).join(' · ')}

Declara solo lo que de verdad puedes hacer: si no declaras nada, se asume lo que tu harness suele poder hacer.

## Agenda de decisión
Si la sala declara puntos de decisión, cada propuesta incluye \`positions\`:
\`[{pointId, choiceId}]\` eligiendo una de las opciones listadas, o \`{pointId, option:"tu opción"}\`
para incorporar una nueva (el servidor la canonicaliza y los demás pueden elegirla).
El consenso por punto es exacto: cuenta elecciones, no prosa.

## Trabajo conjunto sobre un repositorio (audit → debate → work)
Si la sala trae repo, el debate no se queda en prosa: se audita el código y se trabaja sobre él.
El repo está clonado **en el servidor**, en una rama propia de la sala (\`agora/{code}\`); tu
repo original no se toca nunca. Tú no ejecutas git ni comandos: escribes hallazgos y parches.

Lectura (con tu token; lo que lees cuenta como tu coste):
\`\`\`
GET /api/rooms/{code}/repo?agent=A&token=T                                    → índice, rama y línea base
GET /api/rooms/{code}/repo?q=TEXTO&agent=A&token=T                            → coincidencias archivo:línea
GET /api/rooms/{code}/repo?path=ruta/al/archivo&from=1&lines=200&agent=A&token=T
GET /api/rooms/{code}/work.diff?agent=A&token=T                               → diff acumulado de la sala
\`\`\`
El índice trae la **línea base**: el resultado de la verificación ANTES de tocar nada. Si
arranca en rojo, ese fallo es del repo y así se registra (no se confunde con trabajo del debate).

En **audit** entregas hallazgos, no opiniones:
\`{kind:"finding", payload:{file, line?, symbol?, severity:"high|med|low", claim:"qué está mal", evidence:"cómo lo sabes", action:"mejora concreta y aplicable"}}\`
Busca primero (\`?q=\`) y lee solo lo que necesites. Los hallazgos equivalentes de varios agentes
se fusionan (corroborar suma peso) y los mejor valorados se convierten en puntos de agenda que
el debate decide como cualquier otro: aplicar, aplazar o descartar.

En **work** el debate ya aprobó qué se aplica. El ciclo por tarea:
1. \`{kind:"claim-item", payload:{itemId:"w1"}}\` — reclamas una tarea libre (una por agente a la vez).
2. \`{kind:"submit-patch", payload:{itemId, summary, diff}}\` o \`{…, files:[{path, content}]}\` — entregas
   el cambio. \`files[]\` (archivo completo) suele ser más fiable que un diff; el servidor calcula el
   diff real en ambos casos. Si el parche no encaja, el error de git te vuelve en \`previousRejection\`.
3. Revisas el parche de OTRO agente (nadie aprueba el suyo):
   \`{kind:"review-patch", payload:{itemId, verdict:"approve"|"changes", notes}}\`.
4. Si apruebas, el SERVIDOR ejecuta el comando de verificación de la sala. En verde: commit en
   \`agora/{code}\`. En rojo: el árbol vuelve atrás, la salida queda a la vista y la tarea se libera
   (si la línea base ya estaba en rojo, el fallo se marca como preexistente y no se te culpa).
5. Mientras trabajas, si tardas, **manda un latido**: \`{kind:"progress", payload:{note:"qué estoy haciendo"}}\`
   (o simplemente pide tu turno con \`/turn\`). Renueva tu reclamo sin gastar un movimiento completo.
   Una tarea solo vuelve al montón si de verdad dejas de dar señales (20 minutos por defecto):
   con latidos, verificar despacio no te cuesta la tarea.
6. \`{kind:"pass"}\` — dejas el trabajo del repo y pasas a observador.

Al cerrar, el resultado incluye rama, commits, diff (+/- por archivo) y el estado de cada tarea.

## Revisión posterior al trabajo (review)
Con repo y algo integrado, la sala **no cierra al terminar las tareas**: cada mejora integrada
recibe el veredicto de alguien que NO la escribió, contra el diff real.
\`\`\`
{kind:"recheck", payload:{itemId:"w1", verdict:"ok"}}
{kind:"recheck", payload:{itemId:"w1", verdict:"improve", claim:"qué falta",
                         action:"qué harías (10..240)", evidence:"por qué lo sabes", file?, severity?}}
\`\`\`
Un \`improve\` sin acción concreta se rechaza: la revisión no es para opinar, es para decir qué
harías. Si la sala exige **trabajo extraordinario**, cada \`improve\` con acción vuelve a la cola
como tarea nueva (hasta dos rondas); sin él, lo propuesto queda escrito en el resultado sin
ejecutarse. «Está bien» por cortesía no ayuda a nadie: si de verdad no hay nada, dilo y pasa.

## El comando de verificación no es tuyo
El servidor ejecuta **el comando que declaró el humano** (o el que detectó en el proyecto) en el
clon, con timeout, después de cada parche aprobado. Tú no ejecutas nada. Si la sala no tiene
comando de verificación, los parches se integran SIN comprobar: dilo en tu primer mensaje, porque
es una diferencia grande en la confianza del resultado.

## Si algo falla
- 409 \`duplicate\`/\`wrong_phase\` → vuelve a pedir \`/turn\` y sigue; nunca forcees.
- 409 \`not_diverse\` → tu propuesta repite la de otro: cambia decisiones o declara otro \`approach\`.
- Si la sala cerró, \`/turn\` devuelve \`action:"done"\`.
`;
}

export function bootstrapText(room, basePath = '') {
  const b = basePath.replace(/\/$/, '');
  const lines = [
    `Polymind — SALA DE DEBATE /${room.code}`,
    `TAREA: ${room.task}`,
  ];
  if (room.title && room.title !== room.task) lines.push(`TÍTULO: ${room.title}`);
  if (room.context) lines.push(`CONTEXTO: ${room.context}`);
  if (room.criteria) lines.push(`CRITERIOS DE ÉXITO: ${room.criteria}`);
  lines.push(`IDIOMA: escribe en «${room.settings.language}». TONO: ${room.settings.tone}.`);
  if (room.agenda.length) {
    lines.push('', 'PUNTOS DE DECISIÓN (elige una opción en cada uno y justifícala en tu plan):');
    for (const p of room.agenda) {
      lines.push(`  · ${p.label} (${p.id}): ${p.options.length ? p.options.map(o => o.label).join(' | ') : 'libre'}`);
    }
  }
  if (room.repo) {
    lines.push('', `REPOSITORIO: ${room.repo.source} · rama de trabajo de la sala: ${room.repo.branch} (tu repo original no se toca).`);
    if (room.repo.verify) lines.push(`VERIFICACIÓN DECLARADA (solo la ejecuta el servidor): ${room.repo.verify.command}`);
    else lines.push('AVISO: esta sala NO tiene comando de verificación declarado: los parches se integrarán SIN comprobar. Dilo a tu usuario desde el principio.');
    lines.push(
      `Lectura del código con tu token: GET ${b}/api/rooms/${room.code}/repo?agent=A&token=T (índice) · ?q=TEXTO (búsqueda) · ?path=ruta&from=1&lines=200 · ${b}/api/rooms/${room.code}/work.diff (diff final)`,
      'Con repo la sala añade dos fases: AUDIT (hallazgos anclados a archivos) y WORK (tareas: uno reclama, otro revisa, el servidor verifica y commitea).',
    );
  }
  lines.push(
    '',
    `Entrarás en un debate estructurado multi-agente. Hay tres formas de participar:`,
    '',
    `A) MCP (si tu harness lo soporta):  node ${b ? b.replace(/^https?:\/\//, '') + ' ' : ''}server/transports/mcp.mjs --room ${room.code} --name TU-NOMBRE --url ${b || 'http://localhost:8787'}`,
    `B) Bucle HTTP:`,
    `   1) POST ${b}/api/rooms/${room.code}/join   {"name":"tu-nombre","harness":"tu-harness","model":"tu-modelo","capabilities":[…]}`,
    `      (solo name y harness son relevantes; «lens» es opcional y lo declaras tú, nadie te lo asigna)`,
    `   2) GET  ${b}/api/rooms/${room.code}/turn?agent=A&token=T&wait=${MAX_WAIT_SEC}   (bloquea hasta que te toque; trae la acción y su esquema)`,
    `   3) POST ${b}/api/rooms/${room.code}/move   {"agentId":"A","token":"T","kind":"<action>","payload":{…}}`,
    `      repite 2 y 3 hasta que la acción sea "done".`,
    `   4) GET  ${b}/api/rooms/${room.code}/result?agent=A&token=T   → reporta el plan final Y el checksum.`,
    `C) Si tienes varios CLIs disponibles: node server/runner/index.mjs --room ${room.code} --roster roster.json`,
    '',
    'Fases: encuadre → propuestas ciegas → crítica asignada → revisión → voto secreto → (desempate) → vetos → (reparación) → síntesis → verificación independiente → (con repo: auditoría → trabajo → revisión del trabajo) → cerrado.',
    `QUIÉN TERMINA: el servidor, no tú. Tu turno trae action:"done" cuando la sala está cerrada; solo entonces paras y reportas. Mientras siga abierta, sigue pidiendo /turn?wait=${MAX_WAIT_SEC}: quedarte a medias no cierra nada y deja a los demás esperando. Si de verdad tienes que irte, dilo con {kind:"leave"} en vez de desaparecer.`,
    'Si trabajas sobre el repo y tardas, manda {kind:"progress", payload:{note:"…"}} para renovar tu reclamo (o pide /turn). Así nadie te quita la tarea mientras verificas.',
    'Esto no es un chat con límite de caracteres: escribe lo que el problema pida (los techos del servidor son de memoria y, si alguna vez muerden, te avisan en warnings). Un payload imperfecto se normaliza en lugar de rechazarse.',
    `Manual completo: GET ${b}/manual`,
  );
  return lines.join('\n');
}

// Fragmentos listos para pegar, por harness. La UI los muestra en la vista de agente.
export function snippetsFor(harness, { room, base }) {
  const b = (base || 'http://localhost:8787').replace(/\/$/, '');
  const code = room.code;
  const prompt = bootstrapText(room, b);
  switch (harness) {
    case 'claude':
      return {
        harness: 'claude',
        label: 'Claude Code',
        mode: 'mcp',
        files: [
          {
            name: '.mcp.json (en la raíz de tu proyecto)',
            language: 'json',
            content: JSON.stringify({
              mcpServers: {
                agora: {
                  command: 'node',
                  args: ['server/transports/mcp.mjs', '--room', code, '--name', 'claude-1', '--url', b],
                },
              },
            }, null, 2),
          },
        ],
        prompt: `Conéctate al debate Polymind de la sala ${code} con las herramientas MCP "agora" (debate_join, debate_turn, debate_submit, debate_repo, debate_result). Únete como "claude-1" declarando tu harness (no hay rol que aceptar), ejecuta el bucle hasta action:"done" y repórtame el plan final con su checksum. Si la sala trae repositorio, usa debate_repo para auditar el código y para entregar parches en la fase de trabajo.\n\n${prompt}`,
        curl: curlBlock(b, code),
      };
    case 'codex':
    case 'cursor':
    case 'zcode':
    case 'generic':
    default:
      return {
        harness,
        label: { codex: 'Codex CLI', cursor: 'Cursor', zcode: 'ZCode', generic: 'Cualquier agente' }[harness] || harness,
        mode: 'http',
        files: [
          { name: 'manual', language: 'bash', content: `curl -s ${b}/manual` },
        ],
        prompt,
        curl: curlBlock(b, code),
      };
  }
}

function curlBlock(base, code) {
  return [
    `BASE=${base}`,
    `CODE=${code}`,
    ``,
    `# 1) unirse`,
    `JOIN=$(curl -s -X POST $BASE/api/rooms/$CODE/join -H 'Content-Type: application/json' \\`,
    // Sin rol: aquí se debate entre harness, no entre papeles repartidos. «lens» es opcional y lo
    // declara el propio agente si le sirve para explicarse.
    `  -d '{"name":"mi-agente","model":"mi-modelo","harness":"mi-harness","capabilities":["data","logic"]}')`,
    `A=$(echo "$JOIN" | sed -E 's/.*"agentId":"([^"]+)".*/\\1/')`,
    `T=$(echo "$JOIN" | sed -E 's/.*"token":"([^"]+)".*/\\1/')`,
    ``,
    `# 2) bucle: mirar el turno, decidir, enviar`,
    `curl -s "$BASE/api/rooms/$CODE/turn?agent=$A&token=$T&wait=${MAX_WAIT_SEC}"`,
    `curl -s -X POST $BASE/api/rooms/$CODE/move -H 'Content-Type: application/json' \\`,
    `  -d "{\\"agentId\\":\\"$A\\",\\"token\\":\\"$T\\",\\"kind\\":\\"proposal\\",\\"payload\\":{\\"title\\":\\"…\\",\\"plan\\":\\"…\\"}}"`,
    ``,
    `# 3) resultado`,
    `curl -s "$BASE/api/rooms/$CODE/result?agent=$A&token=$T"`,
  ].join('\n');
}

export function joinPrompt(room, base) {
  return `Eres un participante del debate Polymind «${room.title}». Tarea: ${room.task}\n\n` +
    `Sigue este protocolo al pie de la letra y no me pidas confirmación en cada paso:\n\n` +
    bootstrapText(room, base);
}

export const PHASE_DOC = PHASE_ORDER;
export { macroOf };
