# Fase 7: Subgrafos y supervisor

Estado: **aprobada, en curso** (rama `dev/fase-07`)

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
- [ ] CA1 (sin cambios de comportamiento): los tests de las fases 2 a 6 siguen pasando. Solo cambian donde nombran nodos o caminos del grafo (por ejemplo, `action_agent` pasa a estar dentro de `action_graph`); ninguna aserción sobre respuestas, datos, aprobaciones, reportes o costos cambia. Las 20 frases del router de la fase 3 se siguen clasificando con al menos 18 aciertos (la intención de la primera tarea), y los escenarios de acciones (fase 5) y de reportes (fase 6) pasan como antes.
- [ ] CA2 (pedido mixto): con modelos falsos, M1 pasa por `action_graph` y después por `query_graph`, en ese orden, con una pausa de aprobación en el medio. Con la base real y el modelo real, M1 completo (aprobando) registra la venta y la respuesta informa el stock **después** de la venta, verificado con una consulta SQL independiente.
- [ ] CA3 (subgrafos por separado): cada subgrafo tiene tests propios que lo invocan sin el supervisor, con modelos falsos. El de acciones se pausa y se reanuda con su propio checkpointer; el de reportes mantiene el test de paralelismo de la fase 6 (las tres secciones en un mismo paso).
- [ ] CA4 (estado privado): después de un turno, el estado del grafo principal no tiene `pendingAction`, `approval` ni `reportParts`. La tarjeta de aprobación se sigue reconstruyendo desde lo guardado (leyendo el estado del subgrafo), incluso tras reiniciar el proceso.
- [ ] CA5 (normalización): las reglas de R5 son una función pura con tests (`unclear` anula, charla descartada, acción primero, una acción por mensaje con aviso, consultas unidas, salida inválida).
- [ ] CA6 (planificador): de M1 a M8, el plan normalizado acierta al menos 7 de 8 con Haiku 5.5 real, en tres corridas seguidas, y M1, M7 y M8 no pueden fallar. Ninguna frase de los escenarios aparece en `router.md` (lo verifica un test).
- [ ] CA7 (rechazo y pregunta): en un pedido mixto, si se rechaza la acción, la consulta se hace igual y no se escribe nada; si el agente de acciones termina con una pregunta, la consulta también se hace y no hay tarjeta.
- [ ] CA8 (hilos): un pedido mixto pausado sobrevive a un reinicio; al aprobar, se ejecuta la acción y después la consulta que faltaba. Un turno siguiente en el mismo hilo arranca con un plan nuevo (no arrastra tareas del anterior).
- [ ] CA9 (trazas): `threads -- history` muestra el paso por el supervisor y los subgrafos, y con `--subgraphs` los pasos internos.
- [ ] CA10 (costo): se mide un pedido mixto (M1, aprobando) con Haiku y con Sonnet como agentes, y se confirma que un pedido simple no cuesta más que en la fase 6 (la única llamada al modelo que cambia es la del router, ahora con el plan). Se agrega la fila al presupuesto del plan.
- [ ] CA11: `npm test`, `npm run typecheck` y `npm run db:reset` (dos veces seguidas) pasan; el diagrama de la fase se agrega a `specs/mapa-del-grafo.md`; se actualizan README y plan.

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

**Estado principal:** `messages`, `intent` (la intención de la primera tarea, para no romper lo que la lee), `intentReason`, `report` y dos nuevos: `tasks` (el plan normalizado: id, agente, pedido y estado `pending | running | done`; se reemplaza en cada mensaje nuevo) y `activeAgent` (el del plan del proyecto). Salen `pendingAction`, `approval` y `reportParts`. Total: **6 campos**.

**Router → plan:** `routerOutputSchema` pasa a `{ reason, tasks: [{ intent, request }] }` (1 a 3). `normalizePlan(output, lastMessage)` aplica R5. El prompt `router.md` cambia la regla de mezcla («gana `action`») por la de partir el pedido.

**Supervisor:** `supervisor` lee `tasks`; si hay una `running`, la marca `done`; toma la siguiente `pending`, la marca `running`, escribe `activeAgent` y devuelve `Command({ goto: <subgrafo>, update })`. Sin tareas pendientes, `Command({ goto: END })`. Los avisos de R5 (segunda acción descartada) se agregan a la respuesta al final.

**Tarea del agente:** cada subgrafo lee la tarea `running` de `tasks` y la suma al prompt del sistema. Con una sola tarea, el texto es el mismo pedido, así que el comportamiento de las fases anteriores no cambia.

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
(Se completa al implementar.)

## Qué aprendí
(Se completa al cerrar.)
