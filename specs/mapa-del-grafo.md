# Mapa del grafo

Documento vivo: al cerrar cada fase se agrega su diagrama. Los datos de cada fase salen del código de su etiqueta de git (`git show fase-NN:src/graph/index.ts`) y del grafo compilado (`graph.getGraphAsync()`), no de memoria.

Convención de los diagramas: **línea continua** = arista fija (siempre ocurre); **línea punteada** = arista condicional (una función decide cuál se toma); **círculo** = `START` o `END`.

## Evolución

| Fase | Nodos propios | Aristas fijas | Aristas condicionales | Conexiones | Estado (campos) | Qué se incorporó |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 (`chat`) | 2 | 0 | 2 | `messages` | Primer grafo: un nodo que llama a Claude |
| 2 | 2 (`agent`, `tools`) | 2 | 2 | 4 | `messages` | Herramientas de lectura y el ciclo `agent ↔ tools` |
| 3 | 7 (`router`, `agent`, `tools`, `chat`, `action_stub`, `report_stub`, `clarify`) | 6 | 7 | 13 | `messages`, `intent`, `intentReason` | Router de intención y cinco ramas |

Qué cambió de la fase 1 a la 2: el nodo `chat` pasó a llamarse `agent` y ahora puede pedir herramientas; apareció el nodo `tools`; la arista `chat → END` se volvió condicional (`agent → END` solo si no hay llamadas pendientes) y se sumó `tools → agent`, que cierra el ciclo.

Qué cambió de la fase 2 a la 3: el grafo ya no arranca en `agent` sino en un nuevo nodo `router`, que decide a cuál de cinco ramas ir. El ciclo `agent ↔ tools` quedó intacto como una de esas ramas (`query`). Volvió un nodo `chat` (el de la fase 1, ahora sin herramientas y con otro prompt) y aparecieron `clarify` y dos marcadores (`action_stub`, `report_stub`).

---

## Fase 1: un nodo (`fase-01`)

```mermaid
flowchart LR
    S((START)) -->|"fija"| C["chat<br/>prompt del sistema + messages<br/>llama a Claude"]
    C -->|"fija"| E((END))
```

**Resumen:** 1 nodo propio, 2 nodos especiales, 2 aristas fijas, 0 condicionales.

| Nodo | Quién lo escribió | Qué hace | Escribe en el estado |
| --- | --- | --- | --- |
| `chat` | Nosotros (`src/graph/nodes/chat.ts`) | Antepone el prompt del sistema y llama a Claude, sin herramientas | Agrega 1 mensaje de IA a `messages` |

| # | Desde | Hasta | Tipo | Cómo se declara |
| --- | --- | --- | --- | --- |
| 1 | `START` | `chat` | Fija | `.addEdge(START, "chat")` |
| 2 | `chat` | `END` | Fija | `.addEdge("chat", END)` |

**Recorrido:** siempre `START → chat → END`, un solo paso. El grafo no recuerda nada entre invocaciones: la terminal le vuelve a pasar el historial que devolvió.

---

## Fase 2: ciclo agente ↔ herramientas (`fase-02`)

```mermaid
flowchart TD
    S((START)) -->|"fija"| A["agent<br/>arma el prompt y llama a Claude"]
    A -.->|"condicional: el modelo pidió herramientas"| T["tools<br/>ToolNode ejecuta las llamadas"]
    A -.->|"condicional: respuesta final"| E((END))
    T -->|"fija: devuelve los resultados"| A
```

**Resumen:** 2 nodos propios, 2 nodos especiales, 2 aristas fijas, 2 condicionales (salen de una sola decisión), 4 conexiones.

| Nodo | Quién lo escribió | Qué hace | Lee del estado | Escribe en el estado |
| --- | --- | --- | --- | --- |
| `agent` | Nosotros (`src/graph/nodes/agent.ts`) | Antepone el prompt del sistema (con la fecha de hoy) y llama a Claude con las herramientas enlazadas | `messages` | Agrega 1 mensaje de IA a `messages` |
| `tools` | LangGraph (`ToolNode`) | Ejecuta cada `tool_call` del último mensaje; un error se convierte en mensaje de error | `messages` | Agrega 1 mensaje de herramienta por cada llamada |

| # | Desde | Hasta | Tipo | Cómo se declara (`src/graph/index.ts`) |
| --- | --- | --- | --- | --- |
| 1 | `START` | `agent` | Fija | `.addEdge(START, "agent")` |
| 2 | `agent` | `tools` | Condicional | `.addConditionalEdges("agent", routeAfterAgent, ["tools", END])` |
| 3 | `agent` | `END` | Condicional | (misma llamada que la 2) |
| 4 | `tools` | `agent` | Fija | `.addEdge("tools", "agent")` |

La decisión condicional es `routeAfterAgent`: si el último mensaje es de IA y trae `tool_calls`, devuelve `"tools"`; si no, devuelve `END`.

| Situación | Camino | Pasos del grafo |
| --- | --- | --- |
| Charla sin datos ("hola") | `START → agent → END` | 1 |
| Una consulta ("¿cuántos turnos hay mañana?") | `START → agent → tools → agent → END` | 3 |
| Dos herramientas encadenadas (buscar cliente, luego sus turnos) | `START → agent → tools → agent → tools → agent → END` | 5 |
| Error de una herramienta | igual que una consulta: el error vuelve como mensaje y el agente lo informa | 3 |

El tope `recursionLimit` es 10 pasos, así que el ciclo `agent ↔ tools` puede repetirse hasta 4 veces antes de cortar.

---

## Fase 3: router de intención (`fase-03`)

```mermaid
flowchart TD
    S((START)) -->|"fija"| R["router<br/>Haiku, salida estructurada"]
    R -.->|"query"| A["agent<br/>Claude con herramientas"]
    R -.->|"chat"| C["chat<br/>Claude sin herramientas"]
    R -.->|"action"| AS["action_stub<br/>mensaje fijo"]
    R -.->|"report"| RS["report_stub<br/>mensaje fijo"]
    R -.->|"unclear"| CL["clarify<br/>pide una aclaración"]
    A -.->|"pidió herramientas"| T["tools<br/>ToolNode"]
    T -->|"resultados"| A
    A -.->|"respuesta final"| E((END))
    C --> E
    AS --> E
    RS --> E
    CL --> E
```

**Resumen:** 7 nodos propios, 2 nodos especiales, 6 aristas fijas y 7 condicionales, que salen de dos decisiones (`routeByIntent` con 5 destinos y `routeAfterAgent` con 2): 13 conexiones.

| Nodo | Quién lo escribió | Qué hace | Modelo | Escribe en el estado |
| --- | --- | --- | --- | --- |
| `router` | Nosotros (`nodes/router.ts`) | Ve una transcripción acotada (6 mensajes, 500 caracteres, sin herramientas) y clasifica el último mensaje | `MODEL_ROUTER` (Haiku) con salida estructurada | `intent`, `intentReason` |
| `agent` | Nosotros (`nodes/agent.ts`) | Igual que en la fase 2: prompt con la fecha de hoy y herramientas enlazadas | `MODEL_AGENT` | 1 mensaje de IA |
| `tools` | LangGraph (`ToolNode`) | Igual que en la fase 2 | — | 1 mensaje por llamada |
| `chat` | Nosotros (`nodes/chat.ts`) | Charla breve **sin herramientas** | `MODEL_AGENT` | 1 mensaje de IA |
| `clarify` | Nosotros (`nodes/clarify.ts`) | Escribe una sola pregunta de aclaración que termina en `?` | `MODEL_ROUTER` | 1 mensaje de IA |
| `action_stub` | Nosotros (`nodes/stubs.ts`) | Mensaje fijo: las acciones llegan en la fase 5 | ninguno | 1 mensaje de IA |
| `report_stub` | Nosotros (`nodes/stubs.ts`) | Mensaje fijo: los reportes llegan en la fase 6 | ninguno | 1 mensaje de IA |

| # | Desde | Hasta | Tipo | Cómo se declara (`src/graph/index.ts`) |
| --- | --- | --- | --- | --- |
| 1 | `START` | `router` | Fija | `.addEdge(START, "router")` |
| 2 | `router` | `agent` | Condicional (`intent = query`) | `.addConditionalEdges("router", routeByIntent, [...])` |
| 3 | `router` | `chat` | Condicional (`chat`) | (misma llamada) |
| 4 | `router` | `action_stub` | Condicional (`action`) | (misma llamada) |
| 5 | `router` | `report_stub` | Condicional (`report`) | (misma llamada) |
| 6 | `router` | `clarify` | Condicional (`unclear`) | (misma llamada) |
| 7 | `agent` | `tools` | Condicional | `.addConditionalEdges("agent", routeAfterAgent, ["tools", END])` |
| 8 | `agent` | `END` | Condicional | (misma llamada que la 7) |
| 9 | `tools` | `agent` | Fija | `.addEdge("tools", "agent")` |
| 10 | `chat` | `END` | Fija | `.addEdge("chat", END)` |
| 11 | `action_stub` | `END` | Fija | `.addEdge("action_stub", END)` |
| 12 | `report_stub` | `END` | Fija | `.addEdge("report_stub", END)` |
| 13 | `clarify` | `END` | Fija | `.addEdge("clarify", END)` |

La decisión del router es `routeByIntent`: un `Record<Intent, nodo>` que TypeScript obliga a completar para las cinco intenciones. Sin intención, cae en `agent` (la rama de solo lectura).

| Situación | Camino | Pasos del grafo |
| --- | --- | --- |
| Charla ("hola") | `START → router → chat → END` | 2 |
| Pedido de acción o de reporte | `START → router → action_stub / report_stub → END` | 2 |
| Pedido ambiguo | `START → router → clarify → END` | 2 |
| Una consulta | `START → router → agent → tools → agent → END` | 4 |
| Dos herramientas encadenadas | `START → router → agent → tools → agent → tools → agent → END` | 6 |

El tope `recursionLimit` subió a 12 porque el router suma un paso: caben 4 rondas de herramientas más la respuesta final.

---

## Próximas fases (planeado, aún no existe)

| Fase | Cambio previsto en el grafo |
| --- | --- |
| 4 | Sin cambios en nodos ni aristas: se compila con un checkpointer y el grafo recuerda por `thread_id` |
| 5 | Nodos para proponer la acción y esperar la aprobación humana (`interrupt`), más las herramientas de escritura |
| 6 | Reportes en paralelo con `Send` (varios nodos a la vez que se juntan en uno) |
| 7 | Los caminos pasan a ser subgrafos coordinados por un supervisor |
