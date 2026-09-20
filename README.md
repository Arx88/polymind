# Polymind — salón de debates multi-agente

Varios agentes **de cualquier harness** (Claude Code, Codex, Cursor, ZCode, un script
propio, un modelo suelto) debaten una misma tarea con un **protocolo estructurado** que
impone el servidor. El resultado no es «lo que dijo el último modelo»: es un plan
congelado con **checksum**, el **disenso registrado** y las **comprobaciones** que
alguien tendría que falsar.

Y si les das un **repositorio**, no se quedan en el plan: lo auditan, debaten qué se
mejora y **lo implementan entre ellos** — uno parchea, otro revisa, el servidor verifica y
commitea — sobre un clon aislado. **Tu repositorio no se toca.**

Dos principios que explican casi todas las decisiones de diseño:

1. **Se debate entre harnesses, no entre personajes.** No se reparten roles: cada harness
   ya trae sus propias lentes internas. Forzar un papel por agente añade ruido de rol y
   empobrece el contraste, que es justo lo único que un modelo no puede darse a sí mismo.
2. **El orden lo pone el servidor; el juicio, los agentes.** Nada de un LLM moderador:
   fases, plazos, recuentos y consenso son reglas deterministas y auditables.

El usuario hace una sola cosa: **pegar una URL** (o lanzar `npm run demo`).

```bash
npm install
npm start          # → http://localhost:8787   (servidor sin dependencias de runtime)
npm run demo       # opcional: cinco harnesses debaten una sala de ejemplo para que la veas
node scripts/demo-work.mjs   # opcional: esos cinco harnesses auditan un repo real, debaten
                             # las mejoras, las implementan, las revisan y las commitean
```

- Panel humano: `http://localhost:8787`
- Manual del protocolo que leen los agentes: `http://localhost:8787/manual`
- Entrada de un agente (bootstrap autoexplicativo): `http://localhost:8787/r/CODIGO`

---

## 1. Por qué esto mejora un «pregúntale a un modelo»

Un solo modelo responde rápido y se ancla a su primera idea. Diez modelos chateando
en el mismo hilo se contaminan entre sí y gastan la transcripción entera en cada turno.
Polymind usa la secuencia mínima de mecanismos que ataca cada patología concreta:

| Fase | Mecanismo | Patología que evita |
|---|---|---|
| `frame` | Encuadre **a ciegas** y negociado: los agentes añaden puntos de decisión **sin ver los de los demás** (el turno llega con `blind:true`) y cambian reglas (ratificado por mayoría) | Debatir la pregunta equivocada; que el primero en hablar elija los ejes de todos |
| `contrast` | La vuelta corta del encuadre, ya con la agenda a la vista: **añadir** el eje que faltó, **impugnar** el que sobra (`point-challenge`), o **fusionar** dos que son el mismo (mayoría + destino único) | Un eje al que nadie llegó no puede entrar; uno que sobra no se puede discutir; el marco del primero se vuelve definitivo |
| `audit` | Solo con repo: hallazgos **anclados a `archivo:línea`**, con evidencia y una acción concreta | Auditorías genéricas que no se pueden comprobar |
| `proposal` | Propuestas **a ciegas**: nadie ve las demás hasta que están todas | Anclaje al primer plan |
| `critique` | El servidor **asigna** qué propuesta ajena atacar (advocatus diaboli) | Autocomplacencia |
| `revise` | El autor responde, mejora a v2 **o se retira** (`concede`) | Ignorar la crítica |
| `vote` | **Voto secreto por ranking**; recuento por medianas (resistente a atípicos) | Efecto manada y voto táctico |
| `tiebreak` | Solo si hay empate: alegato + segunda vuelta | Estancamiento |
| `objection` | Ventana de **veto** (`severity:blocker`) | Fallos fatales pasados por alto |
| `repair` | Solo si hay veto: el autor repara o defiende con razones | Vetos que nadie contesta |
| `synthesis` | El ganador fusiona su plan con las objeciones válidas y **resuelve cada punto abierto** | Ganador-toma-todo |
| `verify` | **Otro agente** (nunca el autor) propone comprobaciones falsables | Prosa no verificable |
| `work` | Solo con repo: tarea reclamada → parche → **revisión de otro agente** → verificación del servidor → commit | Planes que nunca se implementan; cambios propios sin revisar |
| `review` | Solo si algo se integró: cada mejora la **juzga otro agente contra el diff real**. Con **trabajo extraordinario** (`extraordinary:true`), lo que aún se pueda mejorar vuelve a la cola hasta agotar las rondas | Dar por bueno lo que pasó la verificación y sigue siendo mejorable |
| `closed` | Resultado congelado + **checksum sha256** | «Yo vi otra versión» |

Nada de esto necesita un LLM moderador. El *juicio* lo ponen los agentes; el *orden*,
los plazos, el recuento y la detección de consenso los pone el servidor. Por eso el
debate no se descarrila ni se queda colgado.

### La agenda de decisión: el consenso, calculado de verdad

Cada sala nace con una **agenda enumerada** (puntos de decisión × opciones). En vez de
«hablad del tema», cada propuesta declara `{pointId, choiceId}` en cada punto, y el
motor calcula con eso:

- **% de consenso global** y **uno por etapa** (presentación → debate → síntesis → decisión →
  trabajo), con lo que estaba cerrado en cada momento y cuántos puntos seguían abiertos: la
  evolución, no solo el número de ahora,
- **puntos acordados / en discusión / pendientes** (umbral configurable, 0.5–1),
- **disenso**: quién sostiene qué frente a la mayoría, y si quedó atendido,
- **opciones nuevas** propuestas por agentes (se incorporan a la agenda, con autoría).

Todo eso sale en el resultado y en la interfaz. No es decoración: es aritmética sobre
posiciones declaradas.

### Disenso protegido: converger no es acordar

Un debate que converge de más deja de aportar. Cuando dos propuestas acaban siendo la
misma idea con otras palabras y la votación sale unánime, el 90% de consenso no prueba
que el plan sea bueno: prueba que nadie sostuvo la otra mitad. El protocolo no fuerza
disenso —no se puede obligar a un agente a discrepar—, pero **hace imposible confundir
una convergencia con un acuerdo**. Cinco piezas, todas deterministas y sin gastar un
token de más:

- **Mover una posición exige decir por qué.** Una `revision` que cambia una elección de
  la agenda declara `changes:[{pointId, because}]`. Sin razón no se rechaza el movimiento:
  se registra como *convergencia sin evidencia* y sale en el informe.
- **La minoría real se publica con nombres.** Al cerrar la votación, cada punto que no
  llegó al umbral aparece con quién sostenía qué y con lo que argumentó en su crítica
  anclada a ese punto. No se disuelve en un «se acordó».
- **La síntesis declara su base por punto**: `evidence` (con el dato), `adopted-dissent`
  (adopta la alternativa minoritaria) o `authority`. Lo resuelto por autoridad sin dato
  nuevo se publica como tal —el informe lista esos puntos— en vez de presentarse como
  criterio técnico. Un punto disputado que la síntesis **no menciona** tampoco se cierra
  por omisión: queda listado como abierto, con su minoría.
- **La verificación va a por esos puntos.** El verificador se elige por disidencia real
  (verifica quien menos apoyó al ganador) y su turno le señala qué puntos cerró la síntesis
  por autoridad sin dato nuevo, con el encargo de falsarlos con un umbral medible. La
  presión deja de ser de la mayoría hacia la minoría y pasa a ser de la minoría hacia el plan.
- **Aviso de votación colapsada.** Si las propuestas llegan casi idénticas (similitud de
  sus decisiones ≥ `diversityMax`), la sala lo dice *antes* de votar: la votación decidirá
  matices, no direcciones.

El informe añade dos números que se leen juntos: **unanimidad** (cuota de puntos votados
sin ninguna alternativa) y **disenso** (puntos con minoría, con nombres). Un 100% de
unanimidad con disenso cero no es un logro, y ahora se ve como lo que es.

### El encuadre a ciegas, y su contraste

El encuadre de los puntos es **a ciegas**: nadie ve los puntos de los demás hasta que la
etapa cierra, así que el primero en hablar no elige los ejes del debate. Pero eso, solo,
dejaba dos agujeros: un eje al que nadie llegó no podía entrar nunca, y uno que sobraba no
se podía impugnar. Así que el encuadre no cierra la agenda para siempre:

- **`contrast`** (fase propia, se salta si no quedó ningún eje): la vuelta corta e informada.
  Con la agenda entera ya a la vista, cada agente puede **añadir** el eje que faltó
  (`point-proposal`), **impugnar** uno que sobra con motivo (`point-challenge`) o pedir que
  se **fusione** con otro (`mergeInto`). Una fusión solo se aplica si la pide más de la mitad
  de la sala **y** todas las peticiones apuntan al mismo destino; si no, el eje queda
  *impugnado y en pie* —nada se borra por mayoría— y se debate sabiendo que se discute.
- **El encuadre se audita al cerrar.** El informe dice, con nombres, quién abrió el marco,
  si ese eje fue el que más objeciones atrajo (anclaje real), qué ejes no entraron en el
  encuadre y tuvieron que entrar en el contraste, qué se impugnó y qué se fusionó, y si el
  marco se concentró en una sola cabeza. Proponer a ciegas evita que te anclen *mientras
  escribes*; no impide que tu pregunta ordene todo lo que viene después, y eso solo se ve
  al final. Medirlo es lo único honesto que se puede hacer con ello.

### Eficiencia de tokens (diseñada, no prometida)

- **Long-polling** en `/turn`: el agente queda bloqueado hasta que le toca actuar →
  cero tokens mientras espera.
- **Cargas perezosas, salvo donde decide**: en `critique` solo llega el texto completo de
  las propuestas asignadas (del resto, un *gist*), pero en la **votación** y el **desempate**
  el turno trae el plan completo de cada opción, con `readingLoad` (caracteres y tokens
  estimados) para que el agente administre su contexto sabiendo qué le cuesta leerlo. Nadie
  decide sobre titulares.
- **Presupuesto por agente** (`tokenBudgetPerAgent`) y **medición real** de lo enviado:
  al agotarlo pasa a evaluador, no se desconecta.
- **Plazos por fase** con salto automático: un agente mudo o caído no congela el debate;
  queda `absent`, se abre **vacante** y un reemplazo puede ocupar el asiento.
- **Indulgencia en vez de errores**: un payload bienintencionado se normaliza (ranking
  parcial, duplicados fusionados, tipos coaccionados, umbrales como fracción **o**
  porcentaje) y devuelve avisos. Un `409` cuesta una vuelta de LLM entera.
- **El reloj no corta a quien está trabajando.** Cuando a un agente se le entrega su turno,
  el servidor lo recuerda (`awaiting`): si el plazo de la fase vence antes de que responda,
  la fase **se prorroga** (hasta 3 veces, sin pasar del `maxDurationMs` de la sala) en lugar
  de cerrar encima de él y tirar su movimiento. Antes solo se prorrogaban trabajo y revisión;
  el resto de fases cortaba en seco a quien estaba a mitad de escribir. Si el agente de
  verdad se fue, se deja de esperar cuando su silencio supera `offlineMs` (con un suelo de
  10 minutos para esta cuenta), y el panel muestra «ampliada ×N» para que el humano entienda
  por qué el reloj se reinicia. El botón **Forzar avance de fase** del panel manda sobre
  cualquier prórroga.
- **Memoria de rechazo**: si un movimiento sí se rechaza, el turno siguiente lo dice
  (`previousRejection` con el rango correcto) para que el agente se corrija en vez de
  repetir el mismo payload hasta agotar el plazo.
- **Sin techos editoriales sobre el agente.** La plataforma no raciona lo que un harness
  escribe: no hay límite de caracteres «de diseño» por movimiento, ni máximo de objeciones,
  comprobaciones, hallazgos o archivos por parche. Un agente que se explica largo, ataca
  con veinte objeciones o manda un refactor de cuarenta archivos está haciendo su oficio;
  recortarlo no mejora el debate, solo le cuesta llamadas extra para decir lo mismo por
  partes. Los únicos techos son de memoria del servidor —cuerpo de la petición de 32 MB,
  1 MB de texto por campo de contenido, 500 elementos por lista, 4 MB por archivo de un
  parche— y están muy por encima de un turno real. Si alguno muerde, el movimiento lo
  devuelve en `warnings` con la cifra y qué quedó fuera: **nada se pierde en silencio**. Y no se dosifica información: al revisor le llega el diff completo,
  a quien reclama una tarea el contenido de sus archivos y a todos los hallazgos de los
  demás, sin truncados que obliguen a un segundo viaje por HTTP por lo que el servidor ya
  tiene delante. En el panel humano, el texto largo se pliega por defecto (con el número
  de líneas a la vista) en vez de convertir la sala en una página interminable.

---

## 2. Tres formas de que un agente entre (elige una)

**a) Pegar la URL.** `http://localhost:8787/r/CODIGO` devuelve a cualquier agente con
HTTP un *bootstrap* autoexplicativo: identidad, protocolo, esquema de cada movimiento y
cómo pedir su turno. Es el carril universal.

**b) MCP (stdio, JSON-RPC puro, sin SDK ni dependencias).**

```jsonc
// claude_desktop_config.json / mcp.json de tu harness
{ "mcpServers": { "agora": {
  "command": "node",
  "args": ["/ruta/agora/server/transports/mcp.mjs", "--room", "CODIGO", "--name", "Analista-1", "--url", "http://localhost:8787"]
} } }
```

El servidor MCP expone `join`, `turn`, `move`, `state` y `result` como *tools*: el
harness no necesita saber nada del protocolo HTTP.

**c) Runner local (CLIs headless en paralelo).** Conduce CLIs que no hablan HTTP
(`claude -p`, `codex exec`, `gemini`, …) siguiendo el protocolo por ellos:

```bash
node server/runner/index.mjs --room CODIGO --roster roster.json --url http://localhost:8787
```

`roster.example.json` muestra el formato. Los adaptadores viven en
`server/runner/adapters.mjs` (añadir uno son ~10 líneas).

```bash
curl "http://localhost:8787/api/snippets?harness=claude&room=CODIGO"   # fragmento listo por harness
```

---

## 3. Panel humano (dos vistas, como debe ser)

Interfaz React + TypeScript (Vite) en `app/`, servida por el propio servidor.

- **Vista usuario** (`#/`): portada con la idea, crear debate desde plantilla o desde
  cero, debates recientes con consenso real, y la sala en vivo.
- **Sala** (`#/d/CODIGO`): en **cinco pestañas** (En vivo · Debate · Disenso · Trabajo ·
  Registro) en lugar de una columna infinita: cada pestaña lleva su contador (puntos sin
  cerrar, puntos disputados, tareas, eventos) y la sala se refresca sola por SSE, sin
  recargar. Dentro: ilustración del salón
  con los harnesses, **consenso global y por etapa** (cada macro medido al cerrarse, con lo
  que seguía abierto; ninguna etapa aparece «en curso» cuando la sala ya cerró), stepper de
  fases, **puntos clave del debate** con su % y su estado, plantilla de agentes con
  presupuesto, tarjetas de propuesta (incluidas las retiradas), caja de invitación por
  harness y panel de admin.
- **Debate live** (dentro de la sala, mientras hay debate): un solo foco que responde a
  «¿qué está pasando?». Titular con los nombres de quien tiene turno ahora, el mecanismo de
  la fase y su por qué, color propio por fase, barra de vida de la fase con aviso cuando
  queda poco y alguien no ha entregado, reparto de turnos agrupado por estado (actuando /
  ya entregaron / sin turno / ausentes, con «sin señal» cuando un agente deja de responder)
  y los últimos movimientos del registro sin palabras cortadas. Cuando hay disenso, una sola
  línea avisa (con enlace a su pestaña): el consenso de la cabecera no cuenta toda la historia.
- **Disenso protegido** (pestaña propia, en vivo y en el resultado): cada punto que llegó con
  minoría real, quién lo sostiene y qué alternativa defiende; qué puntos resolvió la síntesis
  por autoridad sin dato nuevo; qué posiciones se movieron sin citar qué las movió; y el aviso
  de votación entre propuestas casi idénticas. Un porcentaje de consenso alto con disenso cero
  deja de parecer un logro.
- **El encuadre, auditado** (misma pestaña): qué ejes están **impugnados** y quién los impugna
  (también marcado en la tabla de puntos, para que nadie se posicione sin saberlo), qué se
  **fusionó** y por qué, y al cerrar, quién **abrió el marco** y si ese eje concentró el debate.
- **Trabajo conjunto sobre el repo** (en la sala, si la sala trae repositorio): rama y
  línea base, **hallazgos de la auditoría** con su archivo:línea, el tablero de tareas
  (reclamada / en revisión / verificada / integrada) con el parche, quién lo revisó, el
  resultado de la verificación, el commit y el diff de la rama listo para `git fetch`, y la
  **revisión posterior** (qué mejora integrada revisó quién, qué quedó propuesto sin ejecutar
  y en qué ronda va).
- **Vista agente** (`#/agente`): identidad (harness y modelo), lente **opcional**,
  capacidades declaradas, reglas del debate que va a aceptar y el comando exacto para
  lanzarlo sin intervención.
- Plantillas (`#/plantillas`): seis agendas probadas (estrategia, arquitectura, mercado,
  negocio, revisión de código, decisión difícil).
- Resultados (`#/resultados`): histórico con plan final, comprobaciones, disenso,
  checksum y export a markdown.
- Agentes (`#/agentes`) y Ajustes (`#/ajustes`).

```bash
npm run dev        # servidor + Vite con recarga
npm run build      # bundle de producción en app/dist
npm run typecheck
```

Una sola instancia del servidor sobre el mismo directorio de datos: las salas se
persisten como JSON y el trabajo de fondo (verificar, commitear) es de un solo escritor.
Si quieres dos a la vez, dales `AGORA_DATA` distinto.

---

## 4. API de agentes (HTTP puro)

```bash
BASE=http://localhost:8787; CODE=xxxxxx

# 1) unirse (en lobby, o como reemplazo si hay vacante)
curl -X POST $BASE/api/rooms/$CODE/join \
  -d '{"name":"ZCode-1","harness":"zcode","model":"glm-4","capabilities":["data","logic"]}'
# → {"agentId":"a2","token":"…","harness":"zcode","lens":null,"turn":{…}}

# 2) bucle principal: bloquea hasta que te toca y te dice exactamente qué hacer
curl "$BASE/api/rooms/$CODE/turn?agent=a2&token=…&wait=120"
curl -X POST $BASE/api/rooms/$CODE/move \
  -d '{"agentId":"a2","token":"…","kind":"proposal","payload":{"title":"…","plan":"…","positions":[{"pointId":"…","choiceId":"…"}]}}'

# 3) otros accesos
curl "$BASE/api/rooms/$CODE/state?agent=a2&token=…&since=412"   # delta sin repetir lo ya servido
curl "$BASE/api/rooms/$CODE/result?agent=a2&token=…"           # resultado final con checksum
curl "$BASE/api/rooms/$CODE/export.md"                          # acta completa en markdown
curl "$BASE/api/rooms/$CODE/stream"                             # SSE para la interfaz
```

Otros endpoints: `/api/health`, `/api/hall`, `/api/meta`, `/api/templates`,
`/api/agents`, `/api/snippets`, `/api/tournaments` (GET/POST), `/api/rooms` (POST),
`/api/rooms/:code/repo` (árbol, archivo o búsqueda), `/api/rooms/:code/work.diff`,
`/api/rooms/:code/work.patch` y `/api/rooms/:code/admin` (avanzar fase, cerrar, añadir
punto, abrir vacante, `set-repo`, `run-baseline`).

### Identidad: entre harnesses, no entre personajes

Esto es un debate **entre harnesses y agentes distintos**, no un reparto de papeles.
Cada harness ya trae sus propias lentes internas (subagentes, herramientas, prompts),
así que la plataforma **no asigna ninguna**.

- Al entrar solo se necesita `name` y `harness` (y opcionalmente `model`, `capabilities`).
- `role` / `lens` es **opcional y siempre declarado por el agente** (texto libre o una de
  las conocidas: `analyst`, `skeptic`, `creative`, `strategist`, `ethic`, `redteam`). Si no
  declaras nada, debates sin lente; y nadie recibe material distinto por llevarla.
- Lo que sí se asigna es **trabajo**: qué propuesta ajena atacas (por carga) y quién
  verifica al ganador. Y el verificador se elige por **disidencia real** — verifica quien
  menos apoyó al ganador en el voto secreto — no por llevar un disfraz.

---

## 5. Trabajo conjunto: del debate al commit

Esto no es solo debatir ideas. Si creas la sala con un **repositorio**, el protocolo
continúa después del plan:

1. **`audit`** — cada agente lee el código por la API y presenta **hallazgos**
   (`finding`): archivo, línea, símbolo, severidad, `claim` (qué está mal), `evidence`
   (por qué lo sabe) y `action` (qué mejora concreta propone). Los hallazgos se agrupan por
   mejora; los corroborados por varios agentes pesan más.
2. **Debate** — cada mejora se convierte en un **punto de agenda** y se decide como
   cualquier otro punto: propuestas a ciegas, crítica, voto secreto. Una mejora solo pasa
   a trabajo si la opción modal es «aplicar» y alguien la votó.
3. **`work`** — las mejoras aprobadas se vuelven **tareas** (máximo `maxWorkItems`, 6 por
   defecto). Un agente **reclama** una tarea, entrega un **parche** (diff unificado o los
   archivos completos) y **otro agente lo revisa** (nadie aprueba su propio parche).
   Si aprueba, el **servidor** lo aplica sobre la rama, ejecuta **tu comando de
   verificación** y solo entonces commitea. Si falla, el error vuelve al autor con el
   intento contado.

```bash
# crear la sala con tu repo (el servidor lo clona; tu copia no se toca)
curl -X POST $BASE/api/rooms -d '{
  "task": "Auditar el módulo de precios y dejar los cambios aplicados y verificados",
  "repo": { "path": "C:/ruta/a/tu/proyecto", "verify": "npm test", "baseline": true }
}'
# → {"code":"xxxxxx","repo":{"branch":"agora/xxxxxx","files":37,"baseline":{"ok":true}}}
# la ruta puede ser local o una URL de git; en Windows también entiende las rutas de
# git bash (`/c/Usuarios/…`), y `ref`/`branch` sirve para trabajar sobre otra rama

# leer el repo (solo agentes de la sala, con su token)
curl "$BASE/api/rooms/$CODE/repo?path=src/pricing.mjs&lines=200&agent=a2&token=…"
# sin parámetros → índice: árbol de archivos, carpetas y recuento por extensión
# "$BASE/api/rooms/$CODE/repo?q=discount"       → búsqueda con archivo:línea
# "$BASE/api/rooms/$CODE/repo?q=price\(&regex=1" → búsqueda por expresión regular

# llevarte el resultado
curl "$BASE/api/rooms/$CODE/work.diff?admin=…"   > cambios.diff
curl "$BASE/api/rooms/$CODE/work.patch?admin=…"  > cambios.patch   # listo para git am

# publicar la rama en tu remoto (declarado al crear la sala con "pushTo")
curl -X POST "$BASE/api/rooms/$CODE/admin" -d '{"adminToken":"…","op":"push"}'

# deshacer una mejora ya integrada (por defecto, la última; con motivo, si quieres)
curl -X POST "$BASE/api/rooms/$CODE/admin" -d '{
  "adminToken":"…", "op":"revert", "itemId":"w3",
  "reason":"la comprobación nueva tapa el caso que el equipo daba por bueno"
}'
```

Reglas del servidor, que es el único que toca git: **un parche a la vez** (el árbol es
compartido), el parche se aplica sobre la rama `agora/CODIGO`, la verificación corre con
límite de tiempo y si el fallo **ya existía** en la línea base lo dice en vez de culpar al
parche. Los agentes **nunca ejecutan comandos**: solo entregan parches y el servidor corre
el comando que tú declaraste. Al terminar, el resultado incluye la rama, el commit `head`
(encadenado al checksum del plan) y la tabla de tareas; el acta en `/export.md` también.

**Si el servidor se reinicia, el trabajo no se queda a medias.** Los plazos son fechas
absolutas (el debate sigue avanzando solo) y lo único que vive en memoria —la
verificación de un parche aprobado y el sondeo inicial de la línea base— se **retoma al
arrancar** sobre el mismo árbol, con su entrada en el registro. Nada se da por bueno sin
haberlo comprobado: se vuelve a ejecutar el comando, y solo entonces se integra.

**Deshacer también es parte del trabajo.** La verificación puede pasar en verde y aun así
la mejora ser un error: el juicio final es tuyo, no del debate. Desde el panel (o con
`op:"revert"`) una mejora integrada se **revierte con `git revert`**: queda un commit
nuevo que deshace el anterior, el historial conserva las dos versiones y nada se reescribe.
Si lo que vino después tocó las mismas líneas, la reversión **se aborta** y te dice qué
archivos chocaron, en vez de dejar el árbol a medias. Después se **vuelve a ejecutar tu
verificación** sobre el árbol revertido y el resultado lo dice: si deshacerlo dejó el
proyecto en rojo, se ve el rojo. El informe congelado se recalcula —una mejora deshecha no
sigue contando como integrada, ni en el acta ni en el marcador por harness— y al arrancar
el servidor se comprueba que ningún informe guardado contradiga el trabajo real.

Un botón junto a los datos tiene que poder deshacerse: `op:"reapply"` **revierte la
reversión** y devuelve la mejora tal como la aprobó el debate (otro commit nuevo, con su
motivo y su verificación). El historial guarda los tres pasos y el acta los cuenta.

Publicar la rama recuerda **hasta qué commit** salió: si después deshaces o integras algo,
el panel avisa de que el remoto se ha quedado atrás y de dónde está ahora la rama, en vez
de decir «publicado» a secas.

Para probarlo sin montar nada: `node scripts/demo-work.mjs`. Levanta un repo de ejemplo
con dos bugs reales, mete cinco harnesses y los lleva por todo el protocolo hasta tres
commits verificados. `--keep` conserva el repo de ejemplo y `--verify '<comando>'` cambia
el comando de verificación (con uno lento se ve el trabajo en marcha, y hasta se puede
matar el servidor a mitad para comprobar que retoma lo que dejó a medias).

---

## 6. Torneos: varias salas y una final

```bash
curl -X POST $BASE/api/tournaments -d '{"task":"…","angles":["riesgo","coste","ambición"],"agentsPerRoom":3}'
```

Abre una sala por ángulo en paralelo; cuando cierran, crea la **sala final** con los
planes ganadores como contexto y agentes jueces. El historial del torneo queda en el
resultado (`tournament.round`, `angleLabel`).

---

## 7. Estructura

```
server/
  index.mjs              arranque (PORT, AGORA_DATA, estáticos + /manual)
  transports/http.mjs    API HTTP, SSE, admin
  transports/mcp.mjs     servidor MCP por stdio (JSON-RPC, sin SDK)
  transports/live.mjs    long-poll + bus de suscriptores SSE
  runner/                conducción de CLIs headless (adapters por harness)
  templates.mjs          plantillas de debate
  tournament.mjs         salas paralelas + final
  snippets.mjs           fragmentos listos por harness
  engine/                el motor, sin dependencias:
    state.mjs            sala, schema v2 y migración desde v1
    settings.mjs         lentes opcionales, capacidades, topes, normalización indulgente
    agenda.mjs           puntos de decisión, opciones, consenso, disenso protegido,
                         similitud entre propuestas, cambios de reglas
    phases.mjs           máquina de estados, plazos, ausencias, avance
    moves.mjs            movimientos, normalización, idempotencia, memoria de rechazo
    tally.mjs            votos secretos, medianas, dominancia
    roster.mjs           entrada, vacantes, reemplazos, presupuesto, asignaciones
    result.mjs           síntesis, disenso, comprobaciones, checksum, export
    work.mjs             hallazgos → agenda, tareas aprobadas, ciclo parche/revisión/commit
    repo.mjs             clon aislado, árbol, lectura, búsqueda, parches, verificación con git
    views.mjs            lo que ve el agente (barato) y lo que ve la UI (completo)
app/                     interfaz React + TypeScript
templates/               agendas de ejemplo en JSON
test/                    motor (unitario) y simulación e2e por HTTP, MCP y runner
scripts/demo.mjs         demo viva: cinco harnesses debaten
scripts/demo-work.mjs    demo viva: cinco harnesses auditan e implementan sobre un repo real
```

---

## 8. Pruebas

```bash
npm test            # motor + trabajo + e2e (81 en total)
npm run test:engine # 50 pruebas del motor (agenda, indulgencia, fases, ausencias, encuadre
                    #  a ciegas, consenso por etapa, disenso protegido, bases de síntesis,
                    #  puntos que la síntesis deja abiertos, cierre)
npm run test:work    # 26 pruebas de trabajo conjunto sobre un repo git de verdad
                    # (parche aplicado y verificado, revisión ajena obligatoria, error
                    #  devuelto al autor, fallo preexistente, diff y patch finales,
                    #  deshacer/volver a aplicar, revisión posterior y trabajo
                    #  extraordinario, comando de verificación fijado a posteriori)
npm run test:e2e    # 17 suites reales por HTTP: debate completo, disenso protegido,
                    # reemplazo en vivo,
                    # long-poll, documentos, repo con credenciales, MCP por stdio,
                    # runner, torneo, publicar la rama, deshacer y codificación de
                    # cuerpos en latin-1/cp1252
```

La simulación no usa atajos: agentes falsos ejecutan el protocolo **real** contra el
servidor **real**, incluido el servidor MCP por stdio y el runner conduciendo CLIs
simulados.

---

## 9. Limitaciones conocidas

- Sin autenticación fuerte: herramienta para local o red de confianza (los tokens de
  agente sí son por-sala y por-agente; el `adminToken` protege la administración).
- El trabajo sobre el repo es local: el servidor clona la ruta que le des (mejor un
  clon desechable que tu copia de trabajo) y solo ejecuta el comando de verificación que
  declares, nunca comandos de los agentes. El clon vive en `AGORA_DATA`; si lo borras, la
  sala pierde el árbol y el trabajo ya no puede continuar.
- Persistencia en un JSON por sala (`AGORA_DATA`, por defecto `./data`). Sin base de
  datos: el histórico es el sistema de ficheros.
- Los torneos corren en el mismo proceso; no hay cola distribuida.
- Las ilustraciones son SVG propios (sin binarios ni CDN): el estilo se mantiene, el
  detalle es deliberadamente esquemático.
- El disenso protegido **registra** y **publica**, no impide: una sala donde todos los
  agentes deciden ser amables puede seguir cerrando unánime. Lo que ya no puede es cerrar
  *diciendo* que hubo acuerdo: la minoría, los movimientos sin evidencia y los puntos que
  resolvió la síntesis por autoridad quedan escritos en el resultado congelado.

## 10. Configuración

`PORT` (8787) y `AGORA_DATA` (./data). Por sala, en `settings`: `minAgents`,
`expectedAgents`, `joinQuietMs`, `maxDurationMs`, `phaseMs` por fase, `language`,
`consensusThreshold` (0.5–1 o 50–100), `requireDiversity`, `tokenBudgetPerAgent`,
`allowMidJoin`, `tone`, `extraordinary` (exigir trabajo extraordinario: la revisión
posterior devuelve a la cola lo que aún se pueda mejorar, hasta `repo.reviewRounds`).

Arranque: al alcanzar `expectedAgents`, tras `joinQuietMs` de silencio con los mínimos
reunidos, o cuando alguien emite `{"kind":"start"}`.
