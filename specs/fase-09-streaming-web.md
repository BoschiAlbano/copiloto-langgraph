# Fase 9: Streaming y chat web

Estado: **en curso** (spec aprobada; la interfaz va con shadcn/ui y Tailwind)

## Objetivo
Usar el copiloto desde un **chat web** con la respuesta **en vivo**: el texto aparece a medida que el modelo lo escribe, se ve qué agente trabaja y qué herramienta usa mientras ocurre, las acciones se aprueban, rechazan o editan con una **tarjeta**, y recargar la página retoma el mismo hilo.

## Contexto
Existe de la fase 8 (etiqueta `fase-08`):

- El grafo completo: `load_memory → router → supervisor` y los agentes (consultas, acciones y reportes como subgrafos; charla, aclaración y memoria como nodos). 9 nodos, 16 conexiones. **Esta fase no lo cambia.**
- `runTurn`, `resumeTurn` y `continueTurn` (`src/graph/run-turn.ts`) corren un turno con `graph.invoke` y devuelven todo junto al final (`TurnResult`): la respuesta, la ruta, las herramientas, el uso, los agentes y, si hay una acción esperando, la tarjeta (`awaiting`).
- La aprobación de la fase 5: el subgrafo de acciones se pausa con `interrupt` y se reanuda con `Command({ resume: decisión })`. La decisión tiene un esquema estricto (`humanDecisionSchema`: aprobar, rechazar con motivo opcional, editar con parámetros) y cada acción se ejecuta una sola vez.
- Los hilos en Postgres (fase 4): `getStatus` dice si un hilo existe, si está a medias o si espera una decisión; `listThreads` lista los recientes.
- La terminal (`npm run chat`) es hoy la única interfaz. Sigue igual después de esta fase.
- El plan reserva la carpeta `web/` para la app Next.js. No hay usuarios ni contraseñas en ninguna fase del plan: la app es **local**.

Qué se necesita de tu parte:
- Aprobar esta spec.
- Las pruebas de punta a punta usan un navegador automático (Playwright). La primera vez descarga Chromium, unos 150 MB.
- Las pruebas con el modelo real cuestan centavos (Haiku). Una de ellas **aprueba una acción** en la base local, igual que los tests de escritura de la fase 5. Después se corre `npm run db:reset`.

## Requisitos
**El chat web**
- R1: Una app Next.js 16 en `web/`, con su propio `package.json`, hecha con **shadcn/ui y Tailwind CSS v4**. `npm run web` (desde la raíz) la levanta en `http://127.0.0.1:3000`. Usa el **mismo agente** que la terminal (`createAgent`): mismo grafo, mismos hilos, mismas memorias. Un hilo empezado en la terminal se abre en la web, y al revés.
- R2: Cada hilo tiene su dirección: `/threads/<id>`. `/` abre un hilo nuevo. Una barra lateral lista los hilos recientes y tiene «Nuevo hilo».
- R3: **Recargar retoma el hilo.** Al abrir la dirección de un hilo se ve su conversación y su situación:
  - listo para escribir;
  - una acción esperando la decisión, con su tarjeta;
  - un turno a medias, con un botón «Continuar» (como `/continuar` en la terminal).

**La respuesta en vivo**
- R4: **Texto token por token** (modo `messages` de LangGraph). Solo se transmite el texto de los nodos que le contestan a la persona: los agentes de consultas y de acciones, la charla y la aclaración. Los nodos con salida estructurada (router, memoria, período del reporte) no se transmiten: su salida no es texto para la persona. **Corrección en T2:** la «Lectura» del reporte tampoco. El código la descarta si cita una cifra que no está en los datos (fase 6), y transmitida se vería un texto que después desaparece. Del reporte se ven en vivo sus secciones, y el texto llega entero.
- R5: **Pasos visibles mientras ocurren** (modo `updates`, con `subgraphs: true`):
  - las partes del pedido (el plan del router), apenas el router termina;
  - qué agente está trabajando;
  - cada herramienta, con su nombre y sus argumentos, cuando el agente la pide;
  - cómo salió cada herramienta (bien o con error) cuando termina;
  - las secciones del reporte, a medida que terminan.

  El texto que acompaña a una herramienta («voy a consultar la agenda…») se muestra como paso, no como respuesta: es el mismo criterio de `turnReply`.
- R6: **Lo que arma el código llega entero.** La memoria («Anoté esta regla…»), el resultado de una acción, el reporte y los avisos del plan no pasan por un modelo, así que no hay tokens: llegan como un mensaje completo. Cada mensaje viaja con su id. Cuando un mensaje termina, el texto guardado en el hilo **reemplaza** al acumulado con los tokens: lo que queda en pantalla es lo que quedó en el hilo.
- R7: Al terminar cada turno se ve el mismo resumen que en la terminal:
  - uso y costo del turno y de la sesión;
  - agentes con sus herramientas y su costo;
  - cuántas memorias estaban en contexto;
  - cómo salió cada sección del reporte, si lo hubo.

  Va en una línea compacta que se puede desplegar.

**La tarjeta de aprobación**
- R8: La tarjeta muestra:
  - el resumen de la acción (lo arma el código, como en la fase 5);
  - el riesgo;
  - los parámetros;
  - un aviso si la tarjeta ya viene editada o si la decisión anterior no se pudo usar.

  Botones:
  - **Aprobar**.
  - **Rechazar**, con un motivo opcional de hasta 200 caracteres.
  - **Editar**: un formulario con un campo por parámetro. Editar no ejecuta nada: muestra la tarjeta recalculada, que hay que aprobar de nuevo.

  La decisión viaja con el mismo esquema estricto (`humanDecisionSchema`) y reanuda el grafo con `Command({ resume })`. Lo que sigue (la ejecución y la respuesta) también llega en vivo.
- R9: Mientras hay una tarjeta, no se pueden mandar mensajes: es la misma regla que en la terminal. Un doble clic o dos pestañas no deciden dos veces. El servidor no acepta un segundo turno sobre un hilo que ya tiene uno en curso, y además cada acción se ejecuta una sola vez desde la fase 5.

**El servidor**
- R10: **Un solo camino para correr un turno.** Una función nueva, `streamTurn`, corre el grafo con `graph.stream` (modos `values`, `updates` y `messages`, con subgrafos) y produce **eventos de la interfaz**. `runTurn`, `resumeTurn` y `continueTurn` pasan a consumir esos eventos y devuelven el mismo `TurnResult` que antes, así que la terminal y los tests de las fases 2 a 8 no cambian.
- R11: **Los eventos tienen un formato fijo**, definido con Zod en `src/web/events.ts`, y viajan al navegador por SSE (`text/event-stream`). Son:
  - `route`: las partes del pedido;
  - `agent`: qué agente empieza o termina;
  - `token`;
  - `message`: un mensaje terminado;
  - `tool_start` y `tool_end`;
  - `action_result`: el resultado de una acción, con el texto que arma el código (sumado en T2);
  - `report_section`;
  - `approval`: la tarjeta;
  - `done`: el `TurnResult` completo;
  - `error`.

  De una herramienta viaja si salió bien o mal, **no su contenido** (son datos de la base que el modelo ya usó).
- R12: **Si se corta la conexión** en medio de un turno (se recarga la página o se cierra la pestaña), el turno se detiene: la señal de corte del pedido llega al grafo. El hilo queda a medias, como en la fase 4. Al volver, la página ofrece «Continuar», y nada se duplica.
- R13: **Seguridad de una app local sin usuarios:**
  - El servidor escucha solo en `127.0.0.1`.
  - Las rutas que cambian algo (mandar un mensaje, decidir, continuar, borrar una memoria) exigen `Content-Type: application/json` y un `Origin` igual al del propio servidor. Así, otra página abierta en el navegador no puede mandar una aprobación al copiloto.
  - El id del hilo, el mensaje (hasta 4.000 caracteres) y la decisión se validan con Zod antes de tocar el grafo.
  - Un error llega al navegador con un mensaje claro y sin detalles internos (cadenas de conexión, rutas de archivos). El detalle queda en el registro del servidor.
- R14: **Memorias en la web:** un panel lista las memorias del negocio y permite borrar una, con confirmación. Anotar sigue siendo por el chat, como pide la fase 8 (el código valida lo que se guarda).

## Escenarios con el modelo real (congelados)
Se guardan en `evals/web-cases.ts` **antes** de escribir la interfaz. Se corren en el navegador con Playwright, cada uno en un hilo nuevo, y los hilos se borran al terminar. La fecha de los turnos es el martes que cae a tres semanas, dicha completa: queda fuera de la agenda del seed, igual que en la fase 8.

| # | Pedido | Qué se hace en la página | Esperado |
| --- | --- | --- | --- |
| W1 | «¿Cuántos turnos hay mañana?» | nada | La ruta dice consulta. La herramienta de turnos aparece **antes** que el texto de la respuesta. El texto de la respuesta crece en al menos 3 pasos visibles antes de terminar. |
| W2 | «Agendá un corte para Julián Romero el martes \<fecha\> a las 15 con Lucas.» | Rechazar, con el motivo «mejor otro día» | Aparece la tarjeta, la entrada de texto queda bloqueada y, al rechazar, no se escribe nada en la base. |
| W3 | El pedido de W2 | Editar la hora a 16, aprobar la tarjeta nueva | La tarjeta nueva dice 16. Al aprobar, el turno queda creado a las 16 y se ve el resultado de la acción. |
| W4 | El pedido de W2 | Recargar la página con la tarjeta abierta, después aprobar | Después de recargar se ven la conversación y la misma tarjeta. Aprobar funciona y el turno queda creado una sola vez. |
| W5 | «Armame el resumen de la semana.» | nada | Las tres secciones (ventas, turnos, stock) aparecen como terminadas antes que el reporte, y el reporte llega completo. |

W3 y W4 escriben en la base: van en las pruebas de escritura y después se corre `db:reset`.

## Criterios de aceptación
- [ ] CA1 (en vivo): la respuesta aparece de forma progresiva.
  - Con modelos falsos que transmiten tokens: los eventos `token` llegan antes que `done` y en orden, y su texto unido es igual al del mensaje final.
  - Con el modelo real: W1 en el navegador en tres corridas.
  - Se registra el tiempo hasta el primer token frente al tiempo total.
- [ ] CA2 (herramientas en vivo): las llamadas a herramientas se muestran mientras ocurren.
  - Con modelos falsos: el orden es `tool_start`, después `tool_end`, después los tokens de la respuesta.
  - El texto que acompaña a una herramienta queda como paso, no como respuesta.
  - En el navegador: W1.
- [ ] CA3 (tarjeta): aprobar, rechazar o editar desde la tarjeta reanuda el grafo (W2, W3 y W4 con el modelo real).
  - Con modelos falsos: una edición inválida muestra el motivo y la acción sigue pendiente.
  - Dos decisiones simultáneas sobre el mismo hilo ejecutan la acción una sola vez: la segunda recibe 409.
- [ ] CA4 (recargar): recargar la página retoma el mismo hilo, con su conversación, su tarjeta (W4) o su botón «Continuar».
  - Un hilo empezado en la terminal se abre en la web.
- [ ] CA5 (un solo camino): `runTurn`, `resumeTurn` y `continueTurn` usan `streamTurn`.
  - Todos los tests de las fases 2 a 8 pasan sin cambios de comportamiento.
  - La terminal funciona igual (se prueba a mano).
- [ ] CA6 (qué se transmite): con modelos falsos que sí emiten tokens en el router y en la memoria, esos tokens **no** llegan como eventos `token`. Los mensajes que arma el código llegan como `message`, sin tokens.
- [ ] CA7 (seguridad), probado sobre las rutas:
  - una ruta que cambia algo responde 415 sin `Content-Type: application/json` y 403 con un `Origin` ajeno;
  - un id de hilo o una decisión inválida da 400;
  - un segundo turno en curso sobre el mismo hilo da 409;
  - un error de la base no muestra la cadena de conexión;
  - `npm run web` escucha solo en `127.0.0.1`.
- [ ] CA8 (corte): con un modelo falso lento, cortar el pedido en medio del turno deja el hilo a medias. «Continuar» lo termina, con un solo mensaje de la persona y una sola respuesta.
- [ ] CA9 (medición): se registra en esta spec, con Haiku:
  - el tiempo hasta el primer token y el tiempo total de W1, en la web y en la terminal;
  - la diferencia de costo entre `invoke` y `stream` para el mismo pedido (se espera ninguna: son los mismos tokens).
- [ ] CA10: estos comandos pasan:
  - `npm test`;
  - `npm run typecheck` (raíz y `web/`);
  - `npm run web:build`;
  - `npm run db:reset`, dos veces seguidas.

  Además:
  - `specs/mapa-del-grafo.md` dice que el grafo no cambió y suma el mapa de los eventos;
  - se actualizan README y plan.

## Fuera de alcance
- Usuarios, inicio de sesión y acceso desde otra máquina: no están en el plan. La app escucha solo en la máquina local.
- **Reconectarse a un turno en curso** después de recargar. Recargar en medio de un turno lo corta, y se continúa con «Continuar» (R12).
- El servidor de agentes de LangGraph (Agent Server) y el hook `useStream` de `@langchain/langgraph-sdk`. Se discute en el diseño; el servidor local de LangGraph es tema de la fase 12.
- Mostrar las respuestas con formato Markdown: el texto se muestra tal cual, respetando los saltos de línea.
- Anotar o editar memorias desde el panel (se anotan por el chat), borrar hilos desde la web (sigue `npm run threads -- delete`), y adjuntar archivos o usar la voz.
- Reintentos automáticos y viaje en el tiempo: fase 10.

## Diseño (plan técnico)

**Por qué eventos propios y no `useStream`.** LangGraph ofrece un camino armado: servir el grafo con su servidor de agentes y consumirlo desde React con `useStream`, que ya sabe de tokens, interrupciones e hilos. Se descarta en esta fase por tres razones:
- El objetivo de aprendizaje son **los modos de streaming**, y `useStream` los esconde.
- Exige otro servidor, que es tema de la fase 12.
- Las reglas de este copiloto (qué texto es respuesta y cuál es paso, qué arma el código, el uso por agente) ya están en `run-turn.ts`. Con eventos propios se reutilizan en vez de reescribirse en el navegador.

**De los modos de LangGraph a los eventos.** `graph.stream(entrada, { streamMode: ["values", "updates", "messages"], subgraphs: true, signal })` entrega tuplas `[namespace, modo, dato]`. Cada una se traduce así:

| Modo | De dónde | Evento |
| --- | --- | --- |
| `messages` | Un fragmento de texto de un nodo que contesta, según `langgraph_node` y el namespace en los metadatos | `token` (id del mensaje, agente, texto) |
| `updates` | El router | `route` |
| `updates` | El supervisor (empieza o termina una tarea) | `agent` |
| `updates` | Un agente: un mensaje de IA con `tool_calls` | `tool_start` por llamada; su texto, como `message` de tipo paso |
| `updates` | El nodo de herramientas: un `ToolMessage` | `tool_end` (bien o error) |
| `updates` | Una sección del reporte | `report_section` |
| `updates` | Cualquier nodo: un mensaje de IA sin `tool_calls` | `message` de tipo respuesta (reemplaza a los tokens con el mismo id) |
| `updates` | La clave `__interrupt__` | `approval` |
| `values` | La raíz, al final | se arma el `TurnResult`: `done` |

Lo que hoy calcula `invokeTurn` (respuesta, uso, agentes, reporte) se arma con el último `values` de la raíz y el mismo `UsageTracker`. A confirmar al implementar:
- el formato exacto de las tuplas en 1.5.3 con tres modos y subgrafos;
- que `ChatAnthropic` transmite tokens aunque los nodos lo llamen con `invoke` (LangGraph lo pide a través de los callbacks);
- que los ids de los fragmentos coinciden con el id del mensaje final.

**Código del servidor, fuera de Next** (`src/web/`, probado con vitest como el resto):
- `events.ts`: el esquema Zod de los eventos y `toUiEvents(tupla)`, una función pura con tests.
- `sse.ts`: codifica eventos como SSE.
- `guard.ts`: los controles de R13, que son `Content-Type`, `Origin` y tamaño.
- `locks.ts`: un turno en curso por hilo, en memoria. Hay un solo proceso local.
- `handlers.ts`: funciones `(Request) → Response` para cada ruta. Las rutas de Next solo las llaman.

`streamTurn` vive en `src/graph/run-turn.ts`, junto a las funciones que reemplaza.

**Rutas** (`web/app/api/`):

```
GET    /api/threads                       hilos recientes
GET    /api/threads/:id                   conversación + situación (listo, a medias, tarjeta)
POST   /api/threads/:id/messages          { text }       → SSE
POST   /api/threads/:id/decision          HumanDecision  → SSE
POST   /api/threads/:id/continue          {}             → SSE
GET    /api/memories                      lista
DELETE /api/memories/:id                  borra una
```

**El agente en Next.** Un solo `createAgent` por proceso, guardado en `globalThis` para que el recargado en caliente de desarrollo no abra pools nuevos. Lee el `.env` de la raíz. A confirmar al implementar:
- que Next 16 (Turbopack) compila `../src`, con imports `.js` que apuntan a archivos `.ts`, usando `turbopack.root` en la raíz;
- que `pg`, Prisma y LangGraph funcionan como paquetes externos del servidor (`serverExternalPackages`).

Resultado en T1: Turbopack no resuelve esos imports y se usa **webpack**. Ver «Decisiones tomadas durante la fase».

La raíz usa TypeScript 7. `web/` usa el TypeScript que pida Next.

**El navegador.**
- Un reductor puro, `applyEvent(estadoDeLaPágina, evento)`, con tests, decide qué se ve: mensajes, pasos del turno en curso, tarjeta, «Continuar» y resumen.
- Los componentes solo dibujan ese estado: barra de hilos, conversación, pasos en vivo, tarjeta, entrada, resumen del turno y panel de memorias.
- **Interfaz con shadcn/ui y Tailwind CSS v4** (pedido al aprobar la spec): una interfaz prolija y elegante, con tema claro y oscuro (tokens semánticos de shadcn, sin colores sueltos) y uso en el celular. `web/` se arma con `npx shadcn@latest init --template next` y los componentes se agregan con la CLI: quedan como código propio en `web/components/ui/`. Qué se usa para qué:
  - la conversación, con las piezas de chat de shadcn: `MessageScroller` (sigue el texto en vivo y salta al último mensaje), `Message` y `Bubble`;
  - los pasos en vivo (agentes, herramientas, secciones del reporte), con `Trace` y `TraceLine`, una línea por paso, desplegable;
  - los avisos del plan y las marcas de «turno a medias», con `Marker` y `Alert`;
  - la barra de hilos, con `Sidebar`;
  - la tarjeta de aprobación, con `Card` (encabezado, contenido y pie), `Badge` para el riesgo, `Table` para los parámetros, y `Field` y `Input` para editar y para el motivo del rechazo;
  - borrar una memoria, con `AlertDialog`; el panel de memorias, con `Sheet`;
  - el resumen del turno, con `Collapsible` y `Badge`; los botones ocupados, con `Spinner`; las cargas, con `Skeleton`.

**Archivos**

```
src/web/events.ts, sse.ts, guard.ts, locks.ts, handlers.ts
src/graph/run-turn.ts   (streamTurn; runTurn, resumeTurn y continueTurn la usan)
web/package.json, next.config.ts, tsconfig.json, components.json   (shadcn)
web/app/layout.tsx, page.tsx, threads/[id]/page.tsx, globals.css   (Tailwind v4 y el tema de shadcn)
web/components/ui/...   (componentes de shadcn, agregados con la CLI)
web/app/api/...   (rutas finas)
web/lib/agent.ts, client/reducer.ts, client/sse.ts
web/components/ThreadList, Conversation, LiveSteps, ApprovalCard, Composer, TurnSummary, MemoryPanel
web/e2e/*.spec.ts   (Playwright)
evals/web-cases.ts
tests/web-*.test.ts, tests/stream-turn.test.ts
package.json   (web, web:build, web:e2e)
```

## Mapas

**1. Dónde encaja la web**

```mermaid
flowchart LR
    subgraph NAV["Navegador · /threads/&lt;id&gt;"]
        UI["conversación · pasos en vivo<br/>tarjeta · memorias"]
    end
    subgraph NEXT["Next.js en 127.0.0.1 (web/)"]
        API["rutas /api/…<br/>(finas)"]
    end
    subgraph SRC["src/ (lo de siempre + src/web)"]
        H["handlers · guard · locks<br/>eventos → SSE"]
        ST["streamTurn<br/>graph.stream(values, updates, messages)"]
        G[["grafo de la fase 8<br/>(sin cambios)"]]
        CLI["terminal<br/>runTurn / resumeTurn"]
    end
    DB[("Postgres<br/>hilos · memorias · negocio")]
    UI -- "POST mensaje / decisión" --> API
    API -- "SSE: eventos" --> UI
    API --> H --> ST --> G --> DB
    CLI --> ST
```

La web y la terminal pasan por el mismo `streamTurn`, así que comparten los hilos y las memorias. Lo nuevo es lo que rodea al grafo, no el grafo.

**2. Un turno en vivo**

```mermaid
sequenceDiagram
    actor U as Persona
    participant P as Página
    participant S as Servidor (streamTurn)
    participant G as Grafo
    U->>P: «¿Cuántos turnos hay mañana?»
    P->>S: POST /messages
    S->>G: graph.stream(…, subgraphs: true)
    G-->>S: updates · router
    S-->>P: route (consulta)
    G-->>S: updates · supervisor
    S-->>P: agent (consultas empieza)
    G-->>S: updates · agente con tool_calls
    S-->>P: tool_start listAppointments
    G-->>S: updates · tools
    S-->>P: tool_end (bien)
    loop mientras el modelo escribe
        G-->>S: messages · fragmento
        S-->>P: token
    end
    G-->>S: updates · mensaje final
    S-->>P: message (reemplaza los tokens)
    G-->>S: values · estado final
    S-->>P: done (uso, agentes, memorias)
```

**3. La tarjeta, de punta a punta**

```mermaid
sequenceDiagram
    actor U as Persona
    participant P as Página
    participant S as Servidor
    participant G as Grafo
    U->>P: «Agendá un corte…»
    P->>S: POST /messages
    S->>G: stream
    G-->>S: updates · __interrupt__ (acción propuesta)
    S-->>P: approval → tarjeta, entrada bloqueada
    Note over P: recargar acá → GET /threads/:id<br/>devuelve la misma tarjeta
    U->>P: Editar: hora 16
    P->>S: POST /decision { edit }
    S->>G: Command({ resume })
    G-->>S: __interrupt__ (tarjeta recalculada, no ejecuta)
    S-->>P: approval (editada)
    U->>P: Aprobar
    P->>S: POST /decision { approve }
    S->>G: Command({ resume })
    G-->>S: execute_action → resultado (código) → respuesta
    S-->>P: message · tokens · done
```

**4. Los estados de la página**

```mermaid
stateDiagram-v2
    [*] --> Lista: abrir o recargar /threads/id
    Lista --> Respondiendo: mandar mensaje
    Respondiendo --> Lista: done
    Respondiendo --> Esperando: approval
    Esperando --> Respondiendo: aprobar · rechazar · editar
    Respondiendo --> AMedias: corte o error
    AMedias --> Respondiendo: Continuar
    [*] --> Esperando: el hilo tenía una tarjeta
    [*] --> AMedias: el hilo quedó a medias
```

En «Respondiendo» y en «Esperando» la entrada de texto está bloqueada. En «A medias» solo se puede continuar, igual que en la terminal.

**5. Qué se transmite y qué no**

```mermaid
flowchart TD
    M["fragmento del modo messages"] --> N{"¿de qué nodo?"}
    N -- "agente de consultas o acciones,<br/>charla, aclaración" --> T["token"]
    N -- "router, memoria, período del reporte<br/>(salida estructurada) y la «Lectura»<br/>(el código la valida antes)" --> X["se descarta"]
    U["mensaje en el modo updates"] --> K{"¿cómo es?"}
    K -- "IA con tool_calls" --> TS["tool_start + su texto como paso"]
    K -- "ToolMessage" --> TE["tool_end (sin el contenido)"]
    K -- "IA sin tool_calls" --> MS["message: reemplaza los tokens<br/>o llega entero si lo armó el código"]
```

## Tareas
Una tarea = un commit en la rama `dev/fase-09`.

1. **T1:** esta spec aprobada. Escenarios W1 a W5 congelados en `evals/web-cases.ts`. Andamiaje de `web/` (Next 16, Tailwind v4 y shadcn/ui) con una ruta de prueba que lista los hilos con el agente real, para confirmar lo que el diseño deja «a confirmar».
2. **T2:** `streamTurn` y los eventos (`events.ts`), y `runTurn`, `resumeTurn` y `continueTurn` sobre `streamTurn`. Tests con modelos falsos que transmiten tokens (CA1, CA2, CA5 y CA6 sin modelo real).
3. **T3:** rutas, SSE, `guard`, `locks` y corte por señal. Tests sobre los handlers (CA7, CA8 y la parte de servidor de CA3 y CA4).
4. **T4:** la página: hilos, conversación, entrada, pasos en vivo y resumen del turno, con el reductor y sus tests.
5. **T5:** la tarjeta de aprobación y «Continuar» (CA3, CA4).
6. **T6:** el panel de memorias (R14).
7. **T7:** Playwright y los escenarios W1 a W5 con el modelo real (CA1 a CA4 en el navegador).
8. **T8:** medición (CA9), mapa del grafo, README y plan. Cierre con la etiqueta `fase-09` (CA10).

## Decisiones tomadas durante la fase
- **La web compila `../src` con webpack, no con Turbopack** (T1). Turbopack, el compilador por defecto de Next 16, no resuelve los imports `.js` que apuntan a archivos `.ts` fuera de `web/`: el resto del proyecto usa esa forma, que es la de NodeNext. Webpack sí los resuelve, con dos opciones de Next: `experimental.externalDir`, que deja compilar archivos de fuera de `web/`, y `experimental.extensionAlias`, que traduce `.js` a `.ts`. Por eso los scripts de `web/` usan `--webpack`. La alternativa era compilar `src/` a JavaScript antes de levantar la web: es un paso más en cada cambio, y la terminal no lo necesita.
- **Los prompts se leen con `readPrompt`** (`src/graph/prompts/read.ts`), en vez de `readFileSync(new URL(…))` en cada nodo. Webpack convierte `new URL("x.md", import.meta.url)` en un archivo publicado (`/_next/static/media/…`). En el servidor eso se apaga (`module.parser.javascript.url: false`) y la URL queda apuntando al archivo real de `src/`. Aun así, el objeto `URL` llega de otro contexto y `readFileSync` no lo acepta, así que `readPrompt` usa su texto (`href`). La terminal y los tests no notan la diferencia.
- **Confirmado:** `pg`, Prisma, el checkpointer y el Store de Postgres funcionan como paquetes externos del servidor. Un turno real dentro de Next (consulta de stock) usó el agente, la base y la memoria de la fase 8, y contestó «Cera mate 31 U/S». El agente se crea una vez por proceso y lee el `.env` de la raíz.
- **Cómo llegan los datos de `graph.stream`** (T2, LangGraph 1.5.3, modos `values`, `updates` y `messages` con `subgraphs: true`):
  - cada dato es `[namespace, modo, dato]`;
  - los fragmentos de texto traen el mismo id que el mensaje final, así que el mensaje terminado reemplaza al borrador;
  - la pausa de aprobación llega dos veces (desde el subgrafo y desde la raíz) y se toma la de la raíz;
  - un subgrafo devuelve todos sus mensajes juntos al grafo principal cuando termina, y esos no se repiten;
  - al pausarse, el modo `values` manda además un dato que es solo `{ __interrupt__ }`: el estado es el anterior;
  - un nodo del grafo principal transmite con su propio tramo de namespace (`chat:…`).
- **Con streaming, el agente guarda `AIMessageChunk`.** Cuando alguien escucha los tokens, LangChain le pide al modelo que transmita, y lo que el nodo recibe y guarda es la suma de los fragmentos (`AIMessageChunk`), no un `AIMessage`. Para el resto del código es lo mismo (`AIMessage.isInstance` lo acepta) y al volver al grafo principal se convierte en `AIMessage`. Toda la suite pasó sin cambios.
- **Un evento más, `action_result`:** el resultado de una acción aprobada o rechazada, con el texto del código, igual que `[acción]` en la terminal. Las acciones propuestas no son `tool_start`: se ven en la tarjeta.
- **Con streaming, la respuesta de Claude no trae el nombre del modelo** (T2, con el modelo real): el uso salía como «desconocido» y el costo, vacío. `UsageTracker` ahora toma como respaldo el modelo que se pidió al empezar la llamada (`ls_model_name` en los metadatos). La consulta «¿Cuántos turnos hay mañana?» costó US$ 0,0012 con streaming, lo mismo que en el bench de la fase 8 (US$ 0,0013): los tokens son los mismos.
