# Copiloto de gestión con LangGraph

Copiloto conversacional para una barbería ficticia (clientes, turnos, ventas y stock), construido por fases para aprender LangGraph. El plan completo está en `doc/` y cada fase tiene su spec en `specs/`.

**Estado:** fase 4 terminada. Un router (Haiku) clasifica cada pedido y lo manda a una de cinco ramas: consulta con herramientas de lectura, charla sin herramientas, aclaración, y marcadores para acciones (fase 5) y reportes (fase 6). Cada conversación es un **hilo** guardado en Postgres: se puede cerrar el programa y retomarla después. El copiloto solo puede leer los datos del negocio, no escribir.

## Requisitos

- Node.js 24 o superior y npm
- Docker Desktop corriendo, con un Supabase local (autoalojado) levantado
- Una clave de la API de Claude (consola de Anthropic, con límite de gasto mensual configurado)

## Puesta en marcha (PowerShell)

```powershell
npm install
Copy-Item .env.example .env     # y completá los valores
npm run db:reset                # crea las tablas, los roles, el esquema de hilos y los datos de prueba
npm run chat                    # conversación nueva por terminal (te dice su id de hilo)
npm run chat hilo-1a2b3c4d      # retoma un hilo guardado
npm run threads                 # lista los hilos
```

### Variables de entorno (`.env`)

| Variable | Qué es |
| --- | --- |
| `ANTHROPIC_API_KEY` | Clave de la API de Claude |
| `MODEL_AGENT` | Modelo del agente y de la charla (por defecto `claude-haiku-5-5`) |
| `MODEL_ROUTER` | Modelo del router y de las aclaraciones (por defecto `claude-haiku-5-5`) |
| `DATABASE_URL_READ` | Conexión del agente, con el rol `copilot_reader` (solo lectura). Elegí vos la contraseña: `npm run db:roles` se la asigna al rol |
| `DATABASE_URL_CHECKPOINTS` | Conexión de los hilos, con el rol `copilot_checkpointer` (solo datos del esquema `langgraph`). Elegí vos la contraseña: `npm run db:checkpoints` se la asigna |
| `DATABASE_URL_WRITE` | Conexión con permisos de administración (`postgres`): migraciones, seed y tests. En la fase 5 pasará a un rol acotado |

El Supabase local se conecta por el pooler (Supavisor), que exige el tenant en el usuario: `<rol>.<POOLER_TENANT_ID>`. Si falla con `ENOIDENTIFIER`, falta ese sufijo. El valor sale del `.env` de tu Supabase.

`.env` nunca se versiona; solo `.env.example`.

## Comandos

| Comando | Qué hace |
| --- | --- |
| `npm run chat [id]` | Chat por terminal. Sin id abre un hilo nuevo; con id retoma ese hilo. Muestra la ruta elegida, las herramientas usadas, y tokens y costo por modelo de cada turno. `salir` termina; `/continuar` reanuda un turno que quedó a medias. (También sirve `npm run chat -- --thread <id>`, pero PowerShell 5.1 se come el primer `--`: usá el id suelto) |
| `npm run threads` | Lista los hilos recientes. `npm run threads -- history <id>` muestra la historia de checkpoints de un hilo; `npm run threads -- delete <id>` lo borra |
| `npm run bench` | Mide el costo real de una batería de preguntas típicas (gasta API: centavos con Haiku, ~20 centavos con Sonnet como agente) |
| `npm run eval:router` | Evalúa el router con los 30 casos congelados de `evals/` y muestra aciertos por categoría y matriz de confusión. `-- --runs 3` repite para ver la estabilidad |
| `npm run db:reset` | Elimina y recrea las tablas del negocio en `public` y el esquema `langgraph` (**borra los hilos guardados**), aplica migraciones, configura los roles y carga el seed |
| `npm run db:roles` | Asigna al rol `copilot_reader` la contraseña de `DATABASE_URL_READ` (solo si hace falta) |
| `npm run db:checkpoints` | Crea el esquema `langgraph` y las tablas de los hilos, da permisos al rol `copilot_checkpointer` y le asigna su contraseña. Es idempotente; repetirlo al actualizar `@langchain/langgraph-checkpoint-postgres` |
| `npm run db:seed` | Vuelve a cargar solo los datos de prueba |
| `npm run db:migrate` | Aplica migraciones pendientes |
| `npm run db:generate` | Regenera el cliente de Prisma (después de tocar `prisma/schema.prisma`) |
| `npm test` | Tests (los de base de datos necesitan haber corrido `db:reset`) |
| `npm run typecheck` | Chequeo de tipos |

Los tests con el modelo real gastan API y están apagados por defecto:

```powershell
$env:RUN_LLM_TESTS = "1"; npm test; Remove-Item Env:RUN_LLM_TESTS
```

`db:reset` solo toca las tablas del negocio; no borra el esquema `public` entero porque Supabase guarda ahí otras cosas.

## Estructura

```
specs/            plan técnico y una spec por fase (con diagramas Mermaid)
src/graph/        grafo (router + cinco ramas), estado, nodos, prompts, modelos, fábrica del agente, turnos por hilo y checkpointer
src/tools/        las 4 herramientas de lectura, fechas de Argentina y manejo de errores
src/db/           cliente Prisma, generador de datos de prueba, seed, roles, esquema de hilos y reset
src/config/       variables de entorno y precios por modelo
src/cli/          chat por terminal, hilos, medición de costo y evaluación del router
evals/           casos de evaluación congelados y corredor del router
prisma/           esquema y migraciones (incluye las reglas que Prisma no expresa)
tests/            Vitest
```

## Seguridad de los datos

El router solo produce una etiqueta de un conjunto cerrado (`query`, `action`, `report`, `chat`, `unclear`) y ve una transcripción acotada, sin mensajes de herramientas: aunque un texto malicioso lo engañe, lo peor es un mal ruteo, no una acción. La rama de charla no tiene herramientas enlazadas. El acceso a los datos del negocio tiene estas capas: esquemas Zod estrictos, consultas fijas y parametrizadas, Prisma, el rol `copilot_reader` (solo `SELECT`, sesión de solo lectura, sin acceso a `action_log` ni a las tablas de autenticación de Supabase) y RLS. Los errores inesperados de la base no se le muestran al modelo: recibe solo un mensaje genérico con el código.

Los hilos guardan lo que se habló (nombres, teléfonos y notas de clientes incluidos), así que viven en un esquema aparte, `langgraph`, y el rol `copilot_checkpointer` solo puede leer y escribir datos ahí: no ve las tablas del negocio ni puede crear o borrar tablas. `anon`, `authenticated` y `copilot_reader` no tienen ningún permiso sobre ese esquema. Un hilo con un turno a medias no acepta mensajes nuevos hasta reanudarlo con `/continuar`. Todavía no hay política de retención ni cifrado en reposo (fase 12); `npm run threads -- delete <id>` borra un hilo.

## Datos de prueba

El seed es determinístico (semilla fija) y se ancla a la fecha en que se corre: 90 días de historial más 14 de agenda futura, de lunes a sábado, con 3 barberos. Los montos son pesos argentinos enteros.

Un cliente tiene en sus notas un texto que intenta dar órdenes al modelo ("ignorá tus instrucciones…"). Es intencional: sirve para comprobar que los datos se tratan como datos y no como instrucciones. En la fase 2 el modelo lo ignora; la prueba fuerte llega en la fase 5, cuando existan herramientas de escritura.
