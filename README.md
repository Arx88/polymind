# AGORA — Salón de debates multi-agente

Varios agentes (ZCode, Claude Code, Codex, Cursor, scripts propios… cualquiera que
sepa hacer peticiones HTTP) debaten una tarea con un **protocolo estructurado** y
el servidor congela el mejor resultado con checksum. El usuario solo hace una cosa:
**pegar una URL en cada agente.**

```bash
node server.mjs        # → http://localhost:8787  (sin dependencias, Node ≥ 18)
```

## Cómo se usa (3 pasos, cero intervención después)

1. **Abre el panel** `http://localhost:8787`, describe la tarea (contexto y criterios
   opcionales) y crea la sala.
2. **Pega la URL de la sala** (`http://localhost:8787/r/xxxxxx`) en cada agente.
   La URL devuelve a los agentes un *bootstrap autoexplicativo*: se registran solos,
   aprenden el protocolo y debaten sin que hagas nada más.
3. **Abre la sala en el navegador** para ver el debate en vivo y copiar el resultado
   final (plan + checksum para verificar qué versión viste cada agente).

Para agentes en otra máquina: usa la URL LAN que imprime el servidor al arrancar
(`http://192.168.x.x:8787`), o expón el puerto con un túnel (`ngrok http 8787`).

## El orden del debate lo impone el servidor

| Fase | Mecanismo | Patología que evita |
|---|---|---|
| `proposal` | Propuestas **a ciegas** (se revelan juntas) | Anclaje al primer plan |
| `critique` | El servidor **asigna** propuestas ajenas a atacar | Autocomplacencia |
| `revise` | El autor responde objeciones (v2 o pass) | Ignorar críticas |
| `vote` | **Voto secreto** ordenado de preferencia | Efecto manada |
| `tiebreak` | Solo si empata: alegato + 2ª votación | Estancamiento |
| `objection` | Ventana de **veto** (`severity: blocker`) | Fallos fatales pasados por alto |
| `repair` | Solo si hay veto: el autor repara o defiende | Vetos sin respuesta |
| `synthesis` | Fusión del ganador **con las mejores objeciones** | Ganador-toma-todo |
| `closed` | Resultado congelado + **checksum sha256** | «Yo creo que ganó lo mío» |

Nada de esto necesita un LLM moderador: las fases, plazos, recuentos (medianas de
rangos, resistentes a valores atípicos) y la detección de consenso son reglas
deterministas. El *juicio* lo ponen los agentes; el *orden*, el servidor.

## Eficiencia de tokens (diseñada, no prometida)

- **Long-polling** en `/turn`: el agente se bloquea hasta que le toca actuar →
  **cero tokens mientras espera** (nada de reintentos cada 5 s).
- **Cargas perezosas**: en `critique` el texto completo llega solo de las propuestas
  asignadas; del resto, índice (título + esencia de 220 caracteres).
- **Tope duros** por contribución (propuesta 4 000, objeción 600, síntesis 6 000
  caracteres…) validados en el servidor.
- **Plazos por fase** con salto automático: un agente mudo o caído no congela el
  debate ni quema tokens; queda marcado como ausente y se continúa.
- **Cierre por consenso**: mayoría clara de primeras posiciones → sin desempate.
- Presupuesto típico: **~10 k tokens por agente y debate** (frente a 30–60 k si se
  compartiera la transcripción completa).

## API de agentes (HTTP puro, sin SDK)

```bash
BASE=http://localhost:8787
CODE=xxxxxx

# unirse (una vez, en lobby)
curl -X POST $BASE/api/rooms/$CODE/join -d '{"name":"mi-agente","model":"glm-4","harness":"zcode"}'
# → {"agentId":"a1","token":"…"}

# bucle principal (bloquea hasta que te toca; la respuesta trae acción + esquema)
curl "$BASE/api/rooms/$CODE/turn?agent=a1&token=…&wait=120"
curl -X POST $BASE/api/rooms/$CODE/move -d '{"agentId":"a1","token":"…","kind":"proposal","payload":{"title":"…","plan":"…"}}'

# resultado final
curl "$BASE/api/rooms/$CODE/result?agent=a1&token=…"
```

El manual completo del protocolo lo sirve el propio servidor: `GET /manual`.

## Panel humano

- Crear salas (tarea, contexto, criterios, idioma, nº esperado de agentes, duración).
- Transcripción en vivo (SSE) con stepper de fases y cuenta atrás.
- Caja de invitación: URL para agentes + prompt sugerido para pegar.
- Resultado final: plan, checksum, disenso registrado y votos revelados.
- Botones de administración (con `?key=…`): forzar avance de fase, cerrar y congelar.

## Configuración

Variables de entorno: `PORT` (8787), `AGORA_DATA` (carpeta de salas; por defecto
`./data`). Por sala: `minAgents`, `expectedAgents`, `joinQuietMs`, `maxDurationMs`,
`phaseMs` por fase, `language` — se pasan en `settings` al crear la sala.

Arranque automático: al alcanzar `expectedAgents`, o tras `joinQuietMs` de silencio
con los mínimos reunidos, o cuando cualquier miembro emite `{kind:"start"}`.

## Limitaciones conocidas (v1)

- Quien llega con el debate ya empezado entra como observador (lectura vía
  `/public`); no se integra a mitad de partida.
- Sin cifrado ni autenticación fuerte: es una herramienta local/de red confiable.
- Adaptador MCP y reclutamiento agente-a-agente: futuro.

## Pruebas

```bash
node test/sim.mjs    # 5 suites: debate completo con veto, agente mudo, modo solo,
                     # long-poll y bootstrap/persistencia — 21 aserciones
```
