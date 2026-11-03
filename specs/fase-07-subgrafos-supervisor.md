# Fase 7: Subgrafos y supervisor

Estado: **terminada** (etiqueta `fase-07`)

## Objetivo
Reorganizar el grafo en tres agentes especializados (consultas, acciones y reportes), cada uno un **subgrafo** que se puede probar por separado, coordinados por un **supervisor** que reparte el trabajo, de modo que un pedido mixto como «registrá la venta y decime cuánto stock queda» se resuelva pasando por dos agentes en el mismo turno.

## Contexto
Existe de la fase 6 (etiqueta `fase-06`):

- Un solo grafo plano de 14 nodos propios y 27 conexiones (ver `specs/mapa-del-grafo.md`). El router (Haiku, salida estructurada) elige **una** de cinco ramas: `query`, `action`, `report`, `chat` y `unclear`.
- Un único `ToolNode` (`tools`) compartido por el agente de consultas y el de acciones: `routeAfterTools` decide a quién volver mirando `intent`. Es un acople que esta fase elimina.
- Los pedidos mixtos hoy van enteros a la rama de acciones (regla R6 del router, fase 3), y el agente de acciones rechaza una acción mezclada con consultas en la misma respuesta (R6 de la fase 5).
- El estado tiene 7 campos. `pendingAction` y `approval` solo los usa la rama de acciones, y `report` y `reportParts` solo la de reportes, pero hoy viven en el estado de todo el grafo.
- Hilos persistentes con pausa para aprobar (fases 4 y 5): `getStatus` reconstruye la tarjeta de aprobación leyendo `pendingAction` del estado del grafo.

Qué se necesita de tu parte: nada más que aprobar esta spec. Las pruebas con el modelo real cuestan centavos (Haiku). Un pedido mixto con acción **pide tu aprobación** igual que en la fase 5.

## Requisitos
**Subgrafos**
- R1: Cada agente es un subgrafo compilado con su propio esquema de estado, que se construye con su propia función (`buildQueryGraph`, `buildActionGraph`, `buildReportGraph`) y se puede invocar y probar solo, sin el supervisor:
  - **Consultas:** `agent ⇄ tools`, con **su propio** `ToolNode` de herramientas de lectura.
  - **Acciones:** `action_agent`, `tools` (propio), `propose_action`, `await_approval` y `execute_action`. La pausa (`interrupt`) ocurre **dentro** del subgrafo.
  - **Reportes:** `plan_report`, las tres secciones en paralelo con `Send` y `compose_report`.
- R2: **Estado compartido y privado.** Los subgrafos comparten con el grafo principal `messages` y la tarea que les toca; lo que solo usa un agente pasa a ser **privado** de su subgrafo y deja de estar en el estado principal: `pendingAction` y `approval` (acciones) y `reportParts` (reportes). `report` queda compartido, con el estado de cada sección, porque lo muestra la terminal.
- R3: Ningún subgrafo conoce a los otros ni al supervisor: recibe una tarea, la resuelve y termina. `routeAfterTools` deja de mirar `intent`, porque cada subgrafo vuelve siempre a su propio agente.

**Supervisor**
- R4: El router pasa a devolver un **plan**: una lista de 1 a 3 tareas, cada una con su intención y el pedido de esa parte reescrito para que se entienda solo («Registrá la venta de un gel fijación fuerte en efectivo», «Decime cuánto stock queda de gel fijación fuerte»). Sigue siendo una sola llamada a `MODEL_ROUTER` con salida estructurada, con el mismo contexto acotado de la fase 3.
- R5: **El código normaliza el plan** (el modelo no decide estas reglas):
  - Una tarea `unclear` anula las demás: se pide aclaración antes de hacer nada.
  - Una tarea `chat` combinada con otras se descarta («¡gracias! ¿y cuánto vendimos ayer?» es solo una consulta).
  - Las acciones van **primero**, después el resto en el orden en que se pidieron: una consulta o un reporte del mismo mensaje tiene que reflejar el cambio.
  - **Una acción por mensaje** (se mantiene la regla de la fase 5). Si el plan trae dos, se hace la primera y la respuesta dice que la otra hay que pedirla después.
  - Dos consultas seguidas se unen en una sola tarea: un mismo agente de consultas puede contestar varias preguntas.
  - Una salida inválida del modelo cae en una sola tarea `query` con el mensaje completo (el mismo respaldo de la fase 3). Un error real de la API se propaga.
- R6: Un nodo **`supervisor`** (código, sin modelo) recorre el plan: marca la tarea en curso en `activeAgent`, **traspasa** el control al subgrafo que corresponde y, cuando ese subgrafo termina, vuelve al supervisor, que pasa a la siguiente tarea o termina el turno. El traspaso se hace con `Command({ goto, update })` desde el supervisor (en vez de una arista condicional), y cada subgrafo vuelve por una arista fija.
- R7: Cada agente ve el historial completo, pero recibe además **su tarea** («Tu parte de este pedido: …; el resto lo atiende otro agente»), para que no conteste lo que no le toca. El agente de acciones ya no rechaza un mensaje mixto: su tarea es solo la acción.
- R8: **Pedido mixto con acción.** El turno se pausa en la aprobación dentro del subgrafo de acciones, con las tareas que faltan guardadas en el hilo. Al decidir (aprobar o rechazar), la acción termina y el supervisor sigue con la próxima tarea en el mismo turno. Esto funciona también después de cerrar y abrir el programa. Si la acción se rechaza o el agente de acciones termina con una pregunta (le falta un dato), las tareas siguientes **se hacen igual**, y la respuesta lo deja claro.

**Respuesta, terminal y trazas**
- R9: La respuesta de un turno mixto junta, en orden, lo que contestó cada agente. Cada agente deja su propio mensaje de IA en el hilo.
- R10: La terminal muestra el plan y por dónde pasó: `[ruta] action → query: registrar venta y consultar stock`, además de la línea `[reporte]` y el uso y costo por modelo, como hasta ahora.
- R11: `npm run threads -- history <id>` muestra los pasos del grafo principal (`router`, `supervisor`, `action_graph`, …). Con `--subgraphs`, muestra también los pasos internos de cada subgrafo con su espacio de nombres.

## Escenarios con el modelo real (congelados)
Se guardan en `evals/plan-cases.ts` **antes** de cambiar el prompt del router. Se evalúa el plan **ya normalizado** (R5). Los nombres existen en el seed.

| # | Pedido | Plan esperado |
| --- | --- | --- |
| M1 | «Registrá la venta de un gel fijación fuerte en efectivo y decime cuánto stock queda.» | `action → query` |
| M2 | «Cancelá el próximo turno de Bruno Castro y armame el resumen de la semana.» | `action → report` |
| M3 | «Decime cuánto stock queda de gel fijación fuerte y armame el resumen del mes.» | `query → report` |
| M4 | «¿Cuántos turnos hay mañana y cuánto vendimos hoy?» | `query` (una sola tarea) |
| M5 | «¿Cuánto stock hay de gel fijación fuerte? Y registrá la venta de uno en efectivo.» | `action → query` (la acción va primero) |
| M6 | «¡Gracias! ¿Y cuánto vendimos ayer?» | `query` (se descarta la charla) |
| M7 | «Armame el resumen de la semana.» | `report` (no se parte) |
| M8 | «Descontá tres peines del stock.» | `action` (no se le agrega una consulta) |

## Criterios de aceptación
- [x] CA1 (sin cambios de comportamiento): los tests de las fases 2 a 6 siguen pasando. Solo cambian donde nombran nodos o caminos del grafo (por ejemplo, `action_agent` pasa a estar dentro de `action_graph`); ninguna aserción sobre respuestas, datos, aprobaciones, reportes o costos cambia. Las 20 frases del router de la fase 3 se siguen clasificando con al menos 18 aciertos (la intención de la primera tarea), y los escenarios de acciones (fase 5) y de reportes (fase 6) pasan como antes.
- [x] CA2 (pedido mixto): con modelos falsos, M1 pasa por `action_graph` y después por `query_graph`, en ese orden, con una pausa de aprobación en el medio. Con la base real y el modelo real, M1 completo (aprobando) registra la venta y la respuesta informa el stock **después** de la venta, verificado con una consulta SQL independiente.
- [x] CA3 (subgrafos por separado): cada subgrafo tiene tests propios que lo invocan sin el supervisor, con modelos falsos. El de acciones se pausa y se reanuda con su propio checkpointer; el de reportes mantiene el test de paralelismo de la fase 6 (las tres secciones en un mismo paso).
- [x] CA4 (estado privado): después de un turno, el estado del grafo principal no tiene `pendingAction`, `approval` ni `reportParts`. La tarjeta de aprobación se sigue reconstruyendo desde lo guardado (leyendo el estado del subgrafo), incluso tras reiniciar el proceso.
- [x] CA5 (normalización): las reglas de R5 son una función pura con tests (`unclear` anula, charla descartada, acción primero, una acción por mensaje con aviso, consultas unidas, salida inválida).
- [x] CA6 (planificador): de M1 a M8, el plan normalizado acierta al menos 7 de 8 con Haiku 5.5 real, en tres corridas seguidas, y M1, M7 y M8 no pueden fallar. Ninguna frase de los escenarios aparece en `router.md` (lo verifica un test).
- [x] CA7 (rechazo y pregunta): en un pedido mixto, si se rechaza la acción, la consulta se hace igual y no se escribe nada; si el agente de acciones termina con una pregunta, la consulta también se hace y no hay tarjeta.
- [x] CA8 (hilos): un pedido mixto pausado sobrevive a un reinicio; al aprobar, se ejecuta la acción y después la consulta que faltaba. Un turno siguiente en el mismo hilo arranca con un plan nuevo (no arrastra tareas del anterior).
- [x] CA9 (trazas): `threads -- history` muestra el paso por el supervisor y los subgrafos, y con `--subgraphs` los pasos internos.
- [x] CA10 (costo): se mide un pedido mixto (M1, aprobando) con Haiku y con Sonnet como agentes, y se confirma que un pedido simple no cuesta más que en la fase 6 (la única llamada al modelo que cambia es la del router, ahora con el plan). Se agrega la fila al presupuesto del plan. **Con una diferencia:** el pedido simple sí cuesta un poco más, +5 % con Haiku (ver «Medición de costo»).
- [x] CA11: `npm test`, `npm run typecheck` y `npm run db:reset` (dos veces seguidas) pasan; el diagrama de la fase se agrega a `specs/mapa-del-grafo.md`; se actualizan README y plan.

## Fuera de alcance
- Un supervisor que llama al modelo después de cada agente para decidir el siguiente (el patrón «supervisor con LLM» de `langgraph-supervisor`). Acá el modelo planifica una vez y el código recorre el plan; se discute en «Qué aprendí».
- Varias acciones en un mismo mensaje, cada una con su aprobación. Se evaluó (una tarjeta por acción, con tope de 2) y se decidió mantener una por mensaje: la primera se ejecutaría antes de ver la segunda (no es atómico) y una tarjeta conjunta exigiría una transacción común. Queda como extensión.
- Tareas que dependen del resultado de otra («si hay stock, registrá la venta»): las tareas se hacen en orden, sin condiciones.
- Agentes que se pasan el control entre ellos sin volver al supervisor (`Command.PARENT` desde dentro de un subgrafo).
- Memoria entre hilos (fase 8) y streaming de los pasos (fase 9).

## Diseño (plan técnico)

**Grafo principal**

```
START → router → supervisor ─┬─ query_graph  ─┐
              (plan)  ▲      ├─ action_graph ─┤
                      │      ├─ report_graph ─┤
                      │      ├─ chat         ─┤
                      │      ├─ clarify      ─┤
                      │      └─ END           │
                      └───────────────────────┘  (cada uno vuelve por arista fija)
```

Nodos propios del grafo principal: `router`, `supervisor`, `query_graph`, `action_graph`, `report_graph`, `chat` y `clarify` (**7**). Conexiones previstas: `START→router`, `router→supervisor`, `supervisor→` 6 destinos (`Command` con `ends` declarados) y 5 vueltas al supervisor: **13**. Se comprueba contra el grafo compilado al cerrar.

**Subgrafos** (los nodos internos conservan sus nombres de la fase 6):

```
query_graph:   START → agent ⇄ tools → END
action_graph:  START → action_agent ─┬─ consultas → tools → action_agent
                                     ├─ una acción → propose_action → await_approval ⟲ → execute_action → action_agent
                                     └─ nada → END
report_graph:  START → plan_report ─ Send ×3 → (ventas · turnos · stock) → compose_report → END
```

**Cómo se arma un subgrafo como nodo.** Un grafo compilado se puede agregar con `.addNode("query_graph", queryGraph)`. LangGraph le pasa los campos del estado principal que tienen el **mismo nombre** en el esquema del subgrafo, y al terminar copia de vuelta solo esos campos; los que el subgrafo tiene y el principal no, quedan privados. El checkpointer del grafo principal guarda también los pasos del subgrafo, en un espacio de nombres propio (`checkpoint_ns`), y por eso un `interrupt` dentro del subgrafo pausa todo el grafo. A confirmar al implementar: (a) que los campos privados del subgrafo de acciones sobreviven a la pausa y a un reinicio; (b) cómo leer el estado del subgrafo pausado (`getState(config, { subgraphs: true })`) para reconstruir la tarjeta; (c) cómo aparecen los subgrafos en `getGraphAsync()` y en el historial; (d) que dos mensajes de IA seguidos en el hilo (uno por agente) no rompen la API de Claude en el turno siguiente.

**Estado principal:** `messages`, `intent` (la intención de la primera tarea, para no romper lo que la lee), `intentReason`, `report` y dos nuevos: `plan` (las tareas normalizadas, cada una con id, intención, pedido, estado `pending | running | done` y `startedAt`, más un `notice` opcional; se reemplaza en cada mensaje nuevo) y `activeAgent` (el del plan del proyecto). Salen `pendingAction`, `approval` y `reportParts`. Total: **6 campos**.

**Router → plan:** `routerOutputSchema` pasa a `{ reason, tasks: [{ intent, request }] }` (1 a 3). `normalizePlan(output, lastMessage)` aplica R5. El prompt `router.md` cambia la regla de mezcla («gana `action`») por la de partir el pedido.

**Supervisor:** `supervisor` lee `plan.tasks`; si hay una `running`, la marca `done`; toma la siguiente `pending`, la marca `running`, escribe `activeAgent` y devuelve `Command({ goto: <subgrafo>, update })`. Sin tareas pendientes, `Command({ goto: END })`. Los avisos de R5 (segunda acción descartada) se agregan a la respuesta al final.

**Tarea del agente:** cada subgrafo lee la tarea `running` del plan y, solo si el turno tiene más de una, la suma al prompt del sistema (`agentInput`). Con una sola tarea no se agrega nada, así que el comportamiento de las fases anteriores no cambia.

**Archivos**

```
src/agents/query.ts, action.ts, report.ts   buildQueryGraph, buildActionGraph, buildReportGraph y sus esquemas de estado
src/graph/plan.ts                           tareas (Zod), normalizePlan
src/graph/nodes/supervisor.ts               supervisor con Command
src/graph/index.ts, state.ts, intents.ts, nodes/router.ts, prompts/router.md   (modifican)
src/graph/nodes/agent.ts, action-agent.ts, report.ts   leen la tarea en curso (modifican)
src/graph/threads.ts, run-turn.ts           tarjeta desde el subgrafo, respuesta de varios agentes (modifican)
src/cli/chat.ts, format.ts, threads.ts, bench.ts   ruta con el plan, --subgraphs, caso mixto (modifican)
evals/plan-cases.ts, evals/plan.ts, src/cli/eval-plan.ts (npm run eval:plan)
tests/plan-*.test.ts, tests/supervisor*.test.ts, tests/agents/*.test.ts, tests/writes/mixed.*.test.ts
```

`src/agents/` es la carpeta que el plan del proyecto reservó para los subgrafos.

## Tareas
Una tarea = un commit en la rama `dev/fase-07`.

1. **T1:** esta spec aprobada; rama `dev/fase-07`; escenarios M1 a M8 congelados en `evals/plan-cases.ts`.
2. **T2:** esquema del plan y `normalizePlan` con sus tests (CA5).
3. **T3:** subgrafo de consultas con su propio `ToolNode` y tests por separado (parte de CA3).
4. **T4:** subgrafo de reportes con `reportParts` privado; el test de paralelismo pasa a correr sobre el subgrafo (parte de CA3).
5. **T5:** subgrafo de acciones con `pendingAction` y `approval` privados; pausa y reanudación dentro del subgrafo (parte de CA3, CA4).
6. **T6:** supervisor con `Command`, grafo principal nuevo, router con plan, tarjeta leída del subgrafo y adaptación de los tests de las fases 2 a 6 (CA1, CA2 con modelos falsos, CA7, CA8).
7. **T7:** terminal (`[ruta]` con el plan, respuesta de varios agentes) e historial con `--subgraphs` (R10, R11, CA9).
8. **T8:** corredor `eval:plan`, prompt del router y pruebas con el modelo real y la base (CA6, CA2 completo, CA1 con modelo real).
9. **T9:** medición de costo (CA10), diagrama, README, plan y cierre con etiqueta `fase-07` (CA11).

## Decisiones tomadas durante la fase
- **Confirmado lo que la spec dejaba «a confirmar»** (con un experimento antes de tocar el código): (a) los campos privados del subgrafo de acciones sobreviven a la pausa y a un reinicio (otro grafo con el mismo checkpointer); (b) `getState(config, { subgraphs: true })` trae, en la tarea del subgrafo pausado, su estado completo, con la propuesta privada; (c) en `getGraphAsync()` los destinos de `Command` (`ends`) aparecen como aristas condicionales: **13 conexiones**, exacto lo previsto; (d) dos mensajes de IA seguidos (uno por agente) se aceptan en el turno siguiente: se comprobó al cierre, con el modelo real (un pedido mixto y después otra consulta en el mismo hilo).
- **El segundo agente necesita un mensaje de la persona antes de su turno.** Si arrancara con el último mensaje del hilo siendo la respuesta del agente anterior, la API de Claude lo tomaría como un texto a continuar (*prefill*), no como un pedido. Por eso, cuando una tarea empieza justo después de la respuesta de otro agente, se intercala una indicación («Seguí con tu parte del pedido: …») que **no se guarda** en el hilo. Va en el punto donde arrancó la tarea (`startedAt`, que anota el supervisor), no al final, para que siga ahí en cada vuelta del ciclo de herramientas.
- **La tarea solo se agrega con dos o más tareas.** Con una sola, el agente recibe exactamente lo mismo que en la fase 6: es lo que mantiene a CA1 sin cambios de comportamiento (un test de la fase 1 cuenta los mensajes que recibe el modelo).
- **`tasks` pasó a ser `plan`** (`{ tasks, notice? }`): el aviso de la segunda acción descartada tenía que viajar con el plan hasta que el supervisor termina el turno. Lo agrega como un mensaje de IA más, así queda en el hilo y en la respuesta.
- **Si un subgrafo falla (no se pausa), `getState` trae el error de la tarea pero no su estado.** `getStatus` lo pide por el espacio de nombres del subgrafo (`action_graph:<id de la tarea>`). Con eso, un turno a medias sigue diciendo qué falta (`next: ["action_graph/execute_action"]`) y cuáles mensajes ya están, como en la fase 4.
- **Durante una pausa, los mensajes del subgrafo todavía no volvieron al grafo principal.** `getStatus` toma los mensajes del subgrafo pausado, y `runTurn` los usa para contar lo nuevo del turno: al reanudar no se vuelven a listar las herramientas de antes de la pausa (la regla de la fase 5).
- **La historia de los subgrafos sale del checkpointer, sin SQL propio:** `saver.list` sin `checkpoint_ns` devuelve los checkpoints de todos los espacios de nombres del hilo (en memoria y en Postgres), y `getStateHistory` acepta un `checkpoint_ns`. Así funciona igual en los tests (`MemorySaver`) que con la base.
- **Cada corrida de un subgrafo arranca con estado propio.** Lo comprueba el test del segundo reporte: cada pedido es otro espacio de nombres, con sus 3 partes. El reducer de `reportParts` por `reportId` (fase 6) ya no es imprescindible para separar reportes, pero se mantiene: sigue juntando las tres partes del mismo paso.
- **Los tests de mecánica pasaron a probar el subgrafo solo** (CA3): los 22 de aprobación de la fase 5 (`tests/graph-actions.test.ts` → `tests/agents/action.test.ts`) corren sobre `buildActionGraph` con su checkpointer, y sus aserciones sobre la pausa, la decisión y la reanudación no cambiaron. Los tests de caminos del grafo completo sí cambiaron de nombres (`router → supervisor → query_graph → supervisor`), y `routeAfterTools` y `routeByIntent` se reemplazaron por los subgrafos y `AGENT_NODES`.
- **M8 estaba, palabra por palabra, en el prompt de la fase 3** («Descontá tres peines del stock», como ejemplo de `action`). Lo detecté al escribir el control de CA6: el escenario no habría medido nada. Se cambió el ejemplo del prompt por otro distinto, no el escenario, que estaba congelado. El control de la fase 3 también atrapó un ejemplo mío del prompt nuevo que coincidía con un caso suyo (A-query-2).
- **CA2 completo usa el producto de prueba (`TST-001`) y no el gel del seed:** la venta se aprueba de verdad y la limpieza de los tests de escritura la borra; con el gel, el test dejaría el stock del seed cambiado.
- **Pool chico para los tests.** Con los subgrafos, `getStatus` hace más consultas, y la suite en paralelo superó los 20 clientes del pooler del Supabase local (`EMAXCONNSESSION`). Los checkpointers de los tests usan 2 conexiones; la aplicación sigue con 5.
- **Una prueba a mano, al cierre, encontró dos fallas que los tests no veían, y se corrigieron.** Pedido: «decime cuánto stock queda de gel y armame el resumen del mes» y, en el turno siguiente, «¿y de cera mate cuánto queda?». (1) El agente de consultas le contó a la persona que «el resumen lo atiende otro agente»: la tarea le decía que no lo contestara, pero no que no lo mencionara. (2) En el turno siguiente, el mismo agente leyó el reporte del hilo como si fuera una respuesta suya sin herramientas y lo «corrigió» con datos falsos: dijo que los 317 turnos eran inventados, y eran los del mes completo, con los agendados a futuro. Lo segundo ya asomaba en la fase 6 (en 1 de 2 corridas, el agente «revisó» un reporte sin que se lo pidieran), y la frase de (1) lo agravó. Arreglos: la tarea pide «respondé tu parte como si fuera todo el pedido: no menciones las otras partes ni a otros agentes», y los prompts de los agentes de consultas y de acciones dicen que los mensajes «Reporte · …» los arma el sistema con datos de la base y no se revisan ni se corrigen. Después: 5 de 5 corridas limpias (3 con el pedido mixto, 2 con un reporte solo) y la suite completa con el modelo real en verde. Dos tests fijan las dos reglas.
- **Hilos de fases anteriores.** Un hilo guardado antes de la fase 7 que quedó pausado espera en `await_approval`, un nodo que ya no existe en el grafo principal: no se puede retomar. `db:reset` los borra (CA11 lo corre).

## Medición de costo (CA10)
`npm run bench` con Haiku 5.5 en todos los roles, y `npm run bench -- --extra` con `MODEL_AGENT=claude-sonnet-5-5`. La acción del pedido mixto se **rechaza** (como las acciones del bench desde la fase 5): tiene las mismas llamadas al modelo que aprobar y no toca datos.

| Caso | Plan | Llamadas (Haiku / Sonnet) | Haiku 5.5 | Sonnet 5.5 como agente |
| --- | --- | --- | --- | --- |
| Mixto: venta y stock (M1) | `action → query` | 6 / 5 | US$ 0,0028 | US$ 0,0414 |
| Mixto: stock y reporte del mes (M3) | `query → report` | 5 / 5 | US$ 0,0015 | US$ 0,0129 |
| Acción sola (referencia, fase 5) | `action` | 4 | US$ 0,0019 | US$ 0,0318–0,0333 |
| 11 consultas y charla del bench (total) | una tarea | 38 | US$ 0,0136 | — |

- **Un pedido mixto cuesta lo de sus partes.** M1 es una acción (router, búsqueda, propuesta y respuesta tras decidir) más una consulta corta. Partir el pedido no agrega llamadas: lo hace el mismo router, en la misma llamada.
- **El pedido simple cuesta un 5 % más con Haiku** (los 11 casos del bench: US$ 0,0136 contra US$ 0,0129–0,0130 en la fase 5). Es el prompt del router, que ahora explica cómo partir un pedido: unos 450 tokens más por turno, unos US$ 0,00005. **CA10 pedía que no costara más**: se registra la diferencia y queda para decidir si achicar el prompt (con caché de prompts, ese costo casi desaparecería). Con Sonnet como agente, la llamada del router es una parte mucho menor del turno.
- Con Sonnet, en M1 el agente de consultas contestó sin volver a consultar el stock, con el dato que el agente de acciones ya había leído en el mismo turno (5 llamadas en vez de 6). Con la acción rechazada el dato era correcto; ver «Dudas abiertas».

## Qué aprendí
- **Un subgrafo es un grafo compilado usado como nodo.** `.addNode("action_graph", buildActionGraph(...))` alcanza: el subgrafo tiene su propio esquema de estado, sus nodos y aristas, y se puede invocar y probar solo. El grafo principal lo ve como **un** paso.
- **El estado compartido es el de los campos con el mismo nombre.** LangGraph le pasa al subgrafo los campos del principal que también están en su esquema y, al terminar, copia de vuelta solo esos. Lo demás es privado: `pendingAction` y `approval` existen solo dentro de `action_graph`, y `reportParts`, solo dentro de `report_graph`. El estado principal pasó de 7 campos a 6, aunque el sistema hace más cosas.
- **Lo privado sigue guardado, en otro espacio de nombres.** El checkpointer del principal guarda también los pasos del subgrafo, bajo `checkpoint_ns = "action_graph:<id de la tarea>"`. Por eso un `interrupt` dentro del subgrafo pausa todo el grafo, la propuesta sobrevive a un reinicio y `getState(…, { subgraphs: true })` deja leerla. Cada corrida del subgrafo es un espacio nuevo: arranca de cero.
- **`Command` junta la actualización y el destino.** El supervisor no escribe el estado para que una arista condicional decida después: devuelve `Command({ goto, update })`, y los destinos posibles se declaran al agregar el nodo (`ends`). Es la forma natural de un **traspaso** entre agentes: «marcá esta tarea como en curso y pasale el control a este agente».
- **El patrón supervisor es una estrella.** Todo pasa por el centro: cada agente vuelve al supervisor por una arista fija y el supervisor decide quién sigue. Ningún agente conoce a los otros, lo que permite probarlos y cambiarlos por separado. La alternativa (`Command.PARENT`, un agente que le pasa el control a otro) es más flexible y más difícil de seguir.
- **Supervisor con modelo o con código.** El patrón conocido usa un modelo que decide después de cada agente. Acá el modelo planifica **una vez** (el router) y el código recorre el plan: no hay llamadas de más, el orden es predecible (la acción primero, siempre) y las reglas de seguridad (una acción por mensaje) no dependen del modelo. El costo es que no se adapta: si la primera tarea cambia lo que habría que hacer después, el plan no se entera.
- **Componer agentes obliga a pensar los bordes de la conversación.** Dos agentes en un turno dejan dos mensajes de IA seguidos, y el segundo agente no puede empezar con un mensaje de IA al final. Hizo falta una indicación que no se guarda, puesta exactamente donde empieza su tarea.
- **Lo que escribe un agente lo lee el siguiente.** Comparten `messages`, así que la respuesta de uno es el contexto del otro, en el mismo turno y en los siguientes. Hacen falta reglas para leer lo ajeno: el agente de consultas trataba el reporte, escrito por el código, como una respuesta suya sin respaldo, y lo «corregía». El estado compartido es un contrato entre agentes, no solo un canal de datos.
- **Partir en subgrafos ordenó los tests.** La mecánica de cada agente se prueba sobre su subgrafo (22 tests de aprobación sin tocar sus aserciones), y el grafo completo, sobre los caminos y los pedidos mixtos. La forma de cada grafo quedó fijada en un test (`tests/graph-shape.test.ts`).
- Dudas abiertas: si conviene achicar o cachear el prompt del router (lo que encareció un 5 % el pedido simple); si el agente de consultas de un pedido mixto debería volver a consultar siempre después de una acción aprobada (con Sonnet usó un dato leído antes, que con la acción rechazada era correcto, pero tras aprobar podría estar viejo); cuándo usar un supervisor con modelo; y cómo mostrar en la interfaz web (fase 9) qué agente está trabajando.

## Qué aprendí
(Se completa al cerrar.)
