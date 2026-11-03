# Plan: Copiloto de gestión con LangGraph (SDD)

## Resumen

Vamos a construir un copiloto conversacional que opera un sistema de gestión (clientes, turnos, ventas y stock) para aprender LangGraph usando casi todas sus herramientas. El proyecto se divide en 12 fases; cada una se especifica, se implementa y se verifica antes de pasar a la siguiente.

**Objetivo de aprendizaje.** Dominar el modelo mental de LangGraph (estado, nodos, aristas, ciclos) y sus capacidades de producción: persistencia, aprobación humana, memoria, streaming, paralelismo, subgrafos y operación local del servidor.

**Negocio de ejemplo.** Una barbería ficticia que da turnos y también vende productos. Los datos son sintéticos, así que se puede probar sin riesgo.

**Qué hace el copiloto al terminar:**

- Responde consultas con datos reales ("¿cuánto vendimos esta semana?").
- Propone acciones que modifican datos (agendar, cancelar, registrar venta, ajustar stock) y espera aprobación humana.
- Arma reportes combinando varias fuentes en paralelo.
- Recuerda reglas y preferencias del negocio entre conversaciones.
- Se usa desde un chat web con respuesta en streaming.

**Fuera de alcance.** Autenticación (el chat funciona sin login), despliegue en la nube, facturación, integración con WhatsApp y carga real de producción. Pueden ser extensiones posteriores.

## Cómo trabajamos con SDD

Cada fase sigue el mismo ciclo: la especificación se escribe y se aprueba antes de generar código, y el código se acepta solo si cumple los criterios de esa spec.

1. **Spec:** qué se construye, por qué y cómo se verifica (criterios de aceptación medibles).
2. **Plan técnico:** decisiones de diseño, archivos a tocar, dependencias.
3. **Tareas:** lista corta de pasos chicos, cada uno con su verificación.
4. **Implementación con IA:** una tarea por vez, con la spec y el plan como contexto.
5. **Verificación:** se corren los criterios de aceptación (tests, evals o una prueba manual descrita en la spec).
6. **Cierre:** se actualiza la spec con lo aprendido, se agrega el diagrama de la fase a `specs/mapa-del-grafo.md` y se marca la fase como terminada.

**Reglas del proceso**

- La spec es la fuente de verdad: si el código y la spec difieren, se corrige primero la spec.
- Una fase a la vez. No se empieza la siguiente sin cumplir todos los criterios de la actual.
- Cada criterio se puede comprobar con un comando, un test o una conversación de prueba escrita.
- Cada fase termina con un commit etiquetado (`fase-01`, `fase-02`, …) para poder volver atrás.
- Cada fase cierra con una nota "qué aprendí" sobre el concepto de LangGraph practicado: es el objetivo real del proyecto.
- A la IA se le pide que explique cada pieza de LangGraph que introduce, no solo que la escriba.

**Plantilla de spec por fase**

```markdown
# Fase N: <nombre>

## Objetivo
Una frase.

## Contexto
Qué existe de las fases anteriores.

## Requisitos
- R1: ...

## Criterios de aceptación
- [ ] CA1: dado ..., cuando ..., entonces ...

## Fuera de alcance
- ...

## Diseño (plan técnico)
Nodos, aristas, estado, herramientas, archivos.

## Tareas
- [ ] T1: ...

## Qué aprendí
Concepto de LangGraph practicado y dudas abiertas.
```

## Stack tecnológico

Todo el proyecto va en TypeScript y se apoya en tu stack habitual, sumando LangGraph.js y la API de Claude.

| Capa | Elección | Para qué se usa |
| --- | --- | --- |
| Lenguaje y runtime | TypeScript + Node.js LTS reciente | Todo el proyecto (LangGraph.js requiere Node 18 o superior) |
| Orquestación | `@langchain/langgraph`, serie 1.x | Grafo, estado, checkpoints, interrupt, streaming |
| Modelos en código | `@langchain/anthropic` + `@langchain/core` | Llamar a Claude y definir herramientas |
| Modelos | Claude por API: Haiku 5.5 y Sonnet 5.5 (Opus 5.5 opcional) | Router barato; agentes con Sonnet |
| Validación | Zod | Esquemas del estado y de las herramientas |
| Base de datos | Supabase local en Docker (Postgres) | Datos del negocio, checkpoints y memoria |
| Acceso a datos | Prisma | Herramientas de lectura y escritura tipadas |
| Persistencia del grafo | Checkpointer y Store de Postgres para LangGraph.js | Estado por hilo y memoria de largo plazo |
| Frontend | Next.js (App Router), Tailwind, shadcn/ui | Chat con streaming |
| Observabilidad | Trazas locales y CLI de LangGraph en modo local; sin LangSmith | Trazas, depuración y evaluaciones |
| Tests | Vitest | Nodos, herramientas y criterios de aceptación |
| Entorno | Windows, PowerShell, Docker Desktop (WSL2) | Desarrollo local |

**Versiones.** En la fase 1 se fijan versiones exactas en `package.json`; LangGraph se actualiza seguido (la serie Python iba por la 1.2.x en octubre de 2026). Confirmado en la fase 4 (leyendo el paquete publicado): checkpointer y Store para JS viven en el mismo paquete, `@langchain/langgraph-checkpoint-postgres` (1.1.2), con las clases `PostgresSaver` y `PostgresStore`; el Store se usa recién en la fase 8. Más detalle en la [documentación oficial de LangGraph](https://docs.langchain.com/oss/javascript/learn).

**Referencia de la versión TypeScript:** [guía de LangGraph en TypeScript](https://codehalwell.github.io/AgentGuides/langgraph-guide/typescript/).

## Arquitectura

Un router clasifica cada pedido y lo deriva a uno de cuatro caminos; solo las acciones pasan por aprobación humana antes de escribir en la base.

&#91;embedded content: arquitectura del grafo · 4 caminos, 1 aprobación humana\]

El diagrama muestra el grafo en su versión final. Hasta la fase 6 los agentes eran nodos simples del mismo grafo; desde la fase 7 son subgrafos (consultas, acciones y reportes) coordinados por un supervisor: el router parte el pedido en tareas y el supervisor se las pasa a cada agente, lo que permite pedidos mixtos. El checkpointer guarda el estado del grafo en cada paso, también el de los subgrafos.

## Modelo de datos

El negocio de ejemplo necesita siete tablas propias más una de auditoría; las de checkpoints y memoria las crea LangGraph.

| Tabla | Campos clave | Notas |
| --- | --- | --- |
| `clients` | id, name, phone, email, notes, created\_at | Unos 30 clientes de prueba |
| `staff` | id, name, active | 3 barberos |
| `services` | id, name, duration\_min, price | 4 servicios (corte, barba, combo, color) |
| `appointments` | id, client\_id, staff\_id, service\_id, starts\_at, ends\_at, status | Estados: scheduled, done, cancelled, no\_show; un barbero no puede tener turnos superpuestos |
| `products` | id, name, sku, price, stock, min\_stock | Unos 15 productos |
| `sales` | id, client\_id (opcional), total, payment\_method, created\_at | Una venta puede ser de productos, servicios o ambos |
| `sale_items` | id, sale\_id, product\_id o service\_id, qty, unit\_price | Detalle de cada venta |
| `action_log` | id, thread\_id, action, payload, decision, decided\_at | Auditoría: qué propuso el agente y qué decidió la persona |

**Tablas de LangGraph.** El checkpointer (estado por hilo de conversación) y el Store (memoria de largo plazo) crean sus propias tablas en el mismo Postgres; no se tocan a mano. Las del checkpointer viven en un esquema aparte, `langgraph`, y la aplicación entra con un rol propio (`copilot_checkpointer`) que solo lee y escribe datos ahí (fase 4).

**Datos de prueba.** Un script de seed genera unos 90 días de historial: turnos, ventas y movimientos de stock coherentes entre sí, para que los reportes tengan sentido.

**Permisos.** Se crean roles de base de datos distintos para cada cosa: uno de solo lectura para las herramientas de consulta (`copilot_reader`), otro con permisos acotados de escritura que solo se usa después de una aprobación (`copilot_actions`, fase 5: inserta turnos, ventas y renglones, cambia el estado de un turno y el stock de un producto, sin `DELETE` ni otros cambios, y con la auditoría de solo agregado) y uno para los hilos (`copilot_checkpointer`, fase 4). El dueño de la base solo se usa para migraciones, seed y tests. Así, un error del modelo no puede borrar ni alterar datos fuera de lo permitido.

## Estado del grafo y herramientas

El estado crece fase a fase: arranca con solo los mensajes y termina con once campos (el plan original contaba nueve; `intentReason` en la fase 3, `report` en la 6 y `plan` en la 7 se sumaron al implementar). Todos se validan con Zod. Desde la fase 7, los campos que usa un solo agente son **privados** de su subgrafo y no están en el estado principal: `pendingAction` y `approval` (acciones) y `reportParts` (reportes).

| Campo | Contenido | Cómo se actualiza | Fase |
| --- | --- | --- | --- |
| `messages` | Historial de la conversación | Se agregan mensajes nuevos | 1 |
| `intent` | Consulta, acción, reporte, charla o aclaración (`unclear`) | Reemplaza el valor | 3 |
| `intentReason` | Motivo que escribió el router (para mostrar la ruta y depurar) | Reemplaza el valor | 3 |
| `pendingAction` | Acción propuesta: id, tipo, parámetros, riesgo y el resumen que arma el código | Reemplaza el valor (`null` cuando no hay ninguna) | 5 |
| `approval` | Aprobada, rechazada o editada (o inválida, si hay que volver a preguntar), con comentario | Reemplaza el valor (`null` cuando no hay ninguna) | 5 |
| `report` | Reporte en curso: id, período (fechas calculadas por código), título y aviso | Reemplaza el valor | 6 |
| `reportParts` | Secciones de un reporte armadas en paralelo (ventas, turnos y stock) | Se concatenan; un reporte nuevo (otro `reportId`) reemplaza las partes del anterior | 6 |
| `plan` | Las tareas del turno (intención, parte del pedido y estado de cada una) y un aviso opcional | Reemplaza el valor (lo escribe el router; el supervisor marca cada tarea) | 7 |
| `activeAgent` | Agente que atiende la tarea en curso (`null` al terminar el turno) | Reemplaza el valor | 7 |
| `businessContext` | Reglas y preferencias leídas de la memoria | Reemplaza el valor | 8 |
| `lastError` | Último error y cantidad de reintentos | Reemplaza e incrementa | 10 |

**Herramientas.** Cada una tiene esquema Zod, descripción clara para el modelo y devuelve datos acotados (límite de filas).

| Herramienta | Tipo | Requiere aprobación | Fase |
| --- | --- | --- | --- |
| `findClient` | Lectura | No | 2 |
| `listAppointments` | Lectura | No | 2 |
| `getSalesSummary` | Lectura | No | 2 |
| `getStockLevels` | Lectura | No | 2 |
| `createAppointment` | Escritura | Sí | 5 |
| `cancelAppointment` | Escritura | Sí | 5 |
| `registerSale` | Escritura | Sí | 5 |
| `adjustStock` | Escritura | Sí | 5 |

## Plan por fases

Las 12 fases se hacen en orden, una a la vez. Lo de abajo es el objetivo y los criterios de aceptación iniciales de cada una; al empezar la fase se baja a una spec completa con la plantilla de arriba.

### Fase 1 · Entorno y primer grafo

**Objetivo:** tener el entorno listo y un primer grafo de un solo nodo funcionando.

**Entregable:** proyecto TypeScript, Supabase local en Docker con el esquema y el seed, y un grafo que llama a Claude desde una conversación por terminal.

**Concepto de LangGraph:** `StateGraph`, estado con reducer de mensajes, `START` y `END`, compilar e invocar.

**Criterios de aceptación:**

- [ ] Un comando de npm abre una conversación por terminal y Claude responde.
- [ ] El historial se mantiene durante la sesión gracias al estado del grafo.
- [ ] Supabase local levanta y el seed carga la cantidad de filas esperada por tabla.
- [ ] La clave de la API vive en `.env`, fuera del control de versiones.

### Fase 2 · Agente con herramientas de lectura

**Objetivo:** que el modelo consulte datos reales mediante herramientas.

**Entregable:** las cuatro herramientas de lectura con Zod y Prisma (rol de solo lectura), un nodo agente y un nodo de herramientas conectados en ciclo.

**Concepto de LangGraph:** tool calling, `ToolNode`, aristas condicionales simples, el ciclo agente ↔ herramientas.

**Criterios de aceptación:**

- [ ] Una pregunta como "¿cuántos turnos hay mañana?" responde con el número correcto, verificado contra una consulta SQL.
- [ ] Si una herramienta falla, el agente informa el error y no inventa datos.
- [ ] El agente no ejecuta SQL libre: solo usa las herramientas definidas.
- [ ] Un test prueba que el rol de lectura no puede modificar datos.

### Fase 3 · Router de intención

**Objetivo:** clasificar cada pedido y derivarlo al camino correcto.

**Entregable:** un nodo router con Haiku 5.5 y salida estructurada (Zod) que elige entre consulta, acción, reporte y charla; las ramas de acción y reporte quedan como marcadores.

**Concepto de LangGraph:** salida estructurada, aristas condicionales con varias ramas, campos nuevos en el estado.

**Criterios de aceptación:**

- [ ] De 20 frases de prueba (5 por categoría), el router acierta al menos 18.
- [ ] La rama de charla no usa herramientas.
- [ ] Un pedido ambiguo cae en una rama que pide aclaración.

### Fase 4 · Persistencia de conversaciones

**Objetivo:** retomar una conversación después de cerrar el programa.

**Entregable:** checkpointer en el Postgres del Supabase local, identificación por `thread_id` y comandos para listar y retomar hilos.

**Concepto de LangGraph:** checkpointer, `thread_id`, lectura del estado e historial de checkpoints.

**Criterios de aceptación:**

- [ ] Tras reiniciar el proceso, retomar un `thread_id` conserva el contexto.
- [ ] Dos hilos distintos no se mezclan.
- [ ] Se puede inspeccionar el historial de checkpoints de un hilo.

### Fase 5 · Aprobación humana antes de escribir

**Objetivo:** que ninguna modificación de datos ocurra sin una decisión explícita de la persona.

**Entregable:** las cuatro herramientas de escritura; un nodo que propone la acción, pausa el grafo y reanuda según la decisión (aprobar, rechazar o editar los parámetros); registro en `action_log`.

**Concepto de LangGraph:** `interrupt`, reanudar con `Command`, human-in-the-loop sobre checkpoints.

**Criterios de aceptación:**

- [ ] Un test que intenta saltear la aprobación no logra escribir en la base.
- [ ] Rechazar no modifica ningún dato.
- [ ] Editar cambia los parámetros antes de ejecutar la acción.
- [ ] Cada decisión queda en `action_log` con el hilo y la fecha.
- [ ] Un hilo pausado sobrevive a un reinicio del proceso y se puede aprobar después.

### Fase 6 · Reportes en paralelo

**Objetivo:** armar un reporte que combine varias fuentes sin ejecutarlas una detrás de otra.

**Entregable:** el pedido "resumen de la semana" lanza en paralelo ventas, turnos y stock bajo; un nodo final consolida todo en un solo texto.

**Concepto de LangGraph:** fan-out y fan-in con `Send`, patrón map-reduce, reducers que concatenan resultados.

**Criterios de aceptación:**

- [ ] Las tres consultas corren en paralelo (se ve en la traza).
- [ ] El reporte final incluye las tres secciones.
- [ ] Si una consulta falla, el reporte indica qué sección falta en lugar de fallar completo.

### Fase 7 · Subgrafos y supervisor

**Objetivo:** reorganizar el sistema en agentes especializados coordinados por un supervisor.

**Entregable:** subgrafos de consultas, acciones y reportes; un supervisor que reparte el trabajo, incluso en pedidos mixtos ("registrá la venta y decime cuánto stock queda").

**Concepto de LangGraph:** subgrafos, estado compartido y privado, patrón supervisor, traspaso entre agentes.

**Criterios de aceptación:**

- [ ] Los tests de las fases 2 a 6 siguen pasando sin cambios de comportamiento.
- [ ] Un pedido mixto se resuelve pasando por dos agentes.
- [ ] Cada subgrafo se puede probar por separado.

### Fase 8 · Memoria de largo plazo

**Objetivo:** que el copiloto recuerde reglas y preferencias del negocio entre conversaciones.

**Entregable:** Store de Postgres; el copiloto guarda y lee reglas como "los lunes no se agendan turnos" y las carga en `businessContext`.

**Concepto de LangGraph:** Store, namespaces, diferencia entre memoria dentro de un hilo y memoria entre hilos.

**Criterios de aceptación:**

- [ ] Una regla dicha en un hilo se aplica en un hilo nuevo.
- [ ] Las reglas se pueden listar y borrar.
- [ ] El copiloto sigue funcionando si la memoria está vacía.
- [ ] La spec define qué NO se guarda (por ejemplo, datos personales de clientes).

### Fase 9 · Streaming y frontend

**Objetivo:** usar el copiloto desde un chat web con respuesta en vivo.

**Entregable:** chat en Next.js con respuesta token por token, pasos del agente visibles (qué herramienta está usando) y una tarjeta de aprobación para las acciones.

**Concepto de LangGraph:** modos de streaming (valores, actualizaciones y mensajes), integración con rutas de API de Next.js, interrupciones resueltas desde la interfaz.

**Criterios de aceptación:**

- [ ] La respuesta aparece de forma progresiva.
- [ ] Las llamadas a herramientas se muestran mientras ocurren.
- [ ] Aprobar, rechazar o editar desde la tarjeta reanuda el grafo.
- [ ] Recargar la página retoma el mismo hilo.

### Fase 10 · Errores, reintentos y viaje en el tiempo

**Objetivo:** que el sistema se recupere de fallas sin quedar en loops ni inventar resultados.

**Entregable:** políticas de reintento en nodos y herramientas, un nodo de recuperación, tope de iteraciones y manejo de salidas inválidas del modelo; posibilidad de repetir una ejecución desde un checkpoint anterior.

**Concepto de LangGraph:** políticas de reintento, límite de recursión, time travel y bifurcación desde un checkpoint.

**Criterios de aceptación:**

- [ ] Una falla simulada de la base se reintenta y se informa a la persona.
- [ ] El agente respeta un tope de iteraciones y no entra en loops.
- [ ] Una salida mal formada del modelo se corrige o se reporta.
- [ ] Se puede re-ejecutar desde un checkpoint anterior con otros parámetros.

### Fase 11 · Observabilidad y evaluaciones

**Objetivo:** medir si el copiloto funciona bien y detectar cuándo un cambio lo empeora.

**Entregable:** trazas locales de cada ejecución (pasos, herramientas y tokens usados) y un set de evaluaciones (conversaciones con resultado esperado) que se corre por comando.

**Concepto de LangGraph:** eventos de streaming y callbacks para trazar ejecuciones, evaluación de agentes.

**Criterios de aceptación:**

- [ ] Cada conversación deja una traza local consultable (pasos, herramientas y tokens).
- [ ] Existe un set de al menos 30 casos con resultado esperado.
- [ ] Correr el set produce un informe de aciertos por categoría.
- [ ] Se pueden comparar dos versiones de un prompt con el mismo set.

### Fase 12 · Empaquetado y operación local

**Objetivo:** dejar todo el sistema listo para levantarse desde cero con pocos comandos, sin servicios externos salvo la API de Claude.

**Entregable:** scripts de PowerShell o Docker Compose que levantan Supabase local, el grafo y la app web, con respaldo y restauración de la base y una guía de operación.

**Concepto de LangGraph:** servidor local de LangGraph, configuración y operación de agentes con estado.

**Criterios de aceptación:**

- [ ] Desde un clon limpio del repositorio, el sistema levanta siguiendo el README y responde con los datos de prueba.
- [ ] Las claves están fuera del repositorio y el arranque falla con un mensaje claro si falta una variable de entorno.
- [ ] Hay una checklist de operación cumplida: límites de uso, timeouts, logs y restauración de la base desde un respaldo.

## Presupuesto de la API de Claude

El copiloto usa la API de Claude, que se factura aparte del plan Pro, con créditos prepagos en la consola de la API. Conviene cargar unos US$ 20 al empezar: alcanza para todo el proyecto si desarrollás con Haiku 5.5, y para llegar hasta la fase 8 aproximadamente si usás Sonnet 5.5 desde el principio.

**Precios por millón de tokens (USD, octubre de 2026)**

| Modelo | Entrada | Salida | Rol sugerido |
| --- | --- | --- | --- |
| Haiku 5.5 | 0,10 | 0,50 | Router y desarrollo diario (el precio vale para prompts de hasta 100.000 tokens) |
| Sonnet 5.5 | 2 | 10 | Agentes, reportes y evaluaciones |
| Opus 5.5 | 4 | 20 | Opcional; no hace falta para aprender |

La API Batch cobra la mitad en Sonnet 5.5 (1 y 5), útil para correr las evaluaciones de la fase 11.

**Costo estimado por tipo de pedido**

| Pedido | Con Sonnet 5.5 | Con Haiku 5.5 |
| --- | --- | --- |
| Consulta típica (medido en la fase 3, con router) | US$ 0,014 | US$ 0,0009 |
| Acción con aprobación (medido en la fase 5) | US$ 0,032 | US$ 0,0019 |
| Reporte en paralelo (medido en la fase 6; con Sonnet escribiendo la «Lectura») | US$ 0,005 | US$ 0,0009 |
| Pedido mixto: acción y consulta (medido en la fase 7) | US$ 0,041 | US$ 0,0028 |
| Set de evaluaciones (30 casos) | US$ 0,90 | US$ 0,05 |

**Supuestos.** Una consulta típica son una llamada del router y dos del agente, con unos 7.000 tokens de entrada y 600 de salida en total. Para las 12 fases se calculan entre 50 y 150 corridas de prueba por fase y unas 12 corridas del set de evaluaciones.

**Escenarios para todo el proyecto**

| Escenario | Costo estimado |
| --- | --- |
| Todo con Sonnet 5.5 | Unos US$ 40 |
| Haiku 5.5 para desarrollar y Sonnet 5.5 para evaluaciones y pruebas finales | Unos US$ 15 |

**Notas**

- Salvo la consulta típica, medida en las fases 2 y 3 (ver sus specs), son estimaciones propias, no mediciones. Con Sonnet como agente el costo medido es ~30 % menor que el estimado y el router de Haiku agrega solo ~US$ 0,0002 por turno (~1,5 %). Con Haiku como agente el router sí pesa (+30 %), porque el agente ya era muy barato. La acción con aprobación se midió en la fase 5 (una consulta previa, la propuesta y la respuesta tras la decisión: 4 llamadas y ~4.100 tokens de entrada por llamada, porque cada una lleva el prompt de acciones y las 8 definiciones de herramientas): +27 % con Haiku y +8 % con Sonnet respecto de la estimación. El reporte en paralelo se midió en la fase 6 y salió **muy por debajo** de la estimación (−94 % con Sonnet y −78 % con Haiku): en el diseño final las tres secciones no usan modelo (son consultas directas a la base) y solo hay dos llamadas baratas, el planificador del período (Haiku) y la «Lectura» (`MODEL_REPORT`), más el router; las cifras las escribe el código. La estimación original suponía un agente por sección. El pedido mixto (una acción y una consulta en el mismo mensaje) se midió en la fase 7: cuesta lo de una acción más una consulta corta (5 o 6 llamadas). Partir el pedido no suma llamadas, porque lo hace el mismo router; su prompt, más largo, encarece un ~5 % las consultas simples con Haiku (de US$ 0,0129 a US$ 0,0136 los 11 casos del bench).
- Los precios salen de páginas que reproducen la documentación oficial; confirmalos en la consola antes de cargar crédito.
- El gasto de la IA con la que programás (el desarrollo con SDD) es aparte y depende de la herramienta y el plan que uses.
- Todo lo demás corre en local (Supabase, grafo y app web), así que la API de Claude es el único gasto del proyecto.

Fuentes: [precios de Sonnet 5.5](https://apidog.com/blog/claude-sonnet-5-5-pricing/), [precios de Opus 5.5](https://anotherwrapper.com/llm-pricing/claude-opus-5-5), [comparativa Haiku, Sonnet y Opus 5.5](https://www.aiagentslibrary.com/?p=11959).

## Repositorio y entorno local

Las specs viven dentro del repositorio, junto al código, para que la IA las lea como contexto en cada tarea.

```
copiloto-langgraph/
├─ specs/              plan general y una spec por fase (fase-01-entorno.md, …)
├─ src/
│  ├─ graph/           grafo principal, estado y nodos
│  ├─ agents/          subgrafos: consultas, acciones, reportes
│  ├─ tools/           herramientas con esquemas Zod
│  ├─ db/              cliente Prisma, roles y seed
│  └─ memory/          Store y reglas del negocio
├─ evals/              casos de evaluación y su runner
├─ tests/              tests de nodos, herramientas y criterios
├─ prisma/             esquema y migraciones
├─ supabase/           configuración local
├─ web/                app Next.js (desde la fase 9)
├─ .env.example        variables necesarias, sin valores reales
└─ README.md           cómo levantar y probar el proyecto
```

**Convenciones**

- **Idiomas:** código e identificadores en inglés; specs, comentarios y respuestas del copiloto en español, con montos en pesos argentinos.
- **Git:** una rama por fase, un commit por tarea y una etiqueta al cerrar la fase.
- **Variables de entorno:** `ANTHROPIC_API_KEY`, los modelos, y una cadena de conexión por rol: lectura (`DATABASE_URL_READ`), acciones aprobadas (`DATABASE_URL_ACTIONS`), hilos (`DATABASE_URL_CHECKPOINTS`) y la del dueño para migraciones, seed y tests (`DATABASE_URL_WRITE`, que la aplicación no usa). Solo `.env.example` se versiona.
- **Modelos configurables:** el modelo de cada rol (router, agentes, reportes) se define por variable de entorno, para cambiarlo sin tocar código.
- **Prompts:** viven en archivos propios y versionados, no dentro de las funciones.
- **Terminal:** todos los comandos del proyecto se documentan para PowerShell, con Docker Desktop y WSL2 activos para Supabase local.
- **Gasto:** antes de la fase 2 se configura un límite de gasto mensual en la consola de la API.

## Riesgos, decisiones y definición de terminado

Los riesgos más probables son el gasto descontrolado de la API y que el modelo modifique datos que no debía; ambos tienen contención desde las primeras fases.

| Riesgo | Mitigación |
| --- | --- |
| Un loop del agente dispara el gasto de la API | Tope de iteraciones (fase 10), límite de gasto mensual en la consola, Haiku para tareas simples |
| El modelo ejecuta una acción no deseada | Rol de base de datos de solo lectura, herramientas acotadas y aprobación humana obligatoria (fase 5) |
| Texto malicioso en los datos (por ejemplo, una nota de cliente con "instrucciones") | Los datos de la base se tratan como datos, no como órdenes; las escrituras siempre pasan por aprobación |
| Cambios en la API de LangGraph entre versiones | Versiones fijas y lectura de las notas de versión antes de actualizar |
| La spec y el código se desalinean | Regla de SDD: se corrige primero la spec |
| Un corte o reinicio de Docker deja una ejecución a medias | El checkpointer permite retomar el hilo (fase 4) y el respaldo de la base se prueba en la fase 12 |

**Decisiones tomadas**

- Acceso a datos con Prisma.
- Sin LangSmith: las trazas y evaluaciones son locales (fase 11).
- Todo corre en local (Supabase, grafo y app web); no hay despliegue en la nube.
- Sin autenticación: el chat funciona sin login.
- Pendiente para la fase 11: cómo guardar y ver las trazas locales (registros propios o una herramienta de código abierto autoalojada).

**Definición de terminado**

- [ ] Las 12 fases cumplen todos sus criterios de aceptación.
- [ ] El README permite levantar el proyecto desde cero siguiendo los pasos.
- [ ] El set de evaluaciones pasa y su informe queda guardado.
- [ ] Cada fase tiene su nota "qué aprendí" con el concepto de LangGraph practicado.
