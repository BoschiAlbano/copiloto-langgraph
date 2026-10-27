# Fase 1: Entorno y primer grafo

Estado: **aprobada, en implementación**

## Objetivo
Tener el entorno listo y un primer grafo de un solo nodo que conversa con Claude por terminal, más la base de datos del negocio levantada con su seed.

## Contexto
No existe nada todavía. Solo está el plan general en `doc/`. Esta fase crea el repositorio, el proyecto TypeScript, el grafo mínimo y la base local.

Estado del entorno detectado (2026-10-27):

- Node v24.18.0, npm 11.16.0, git 2.51.0 y Supabase CLI 2.121.0 instalados.
- Supabase corre **autoalojado con Docker Compose** (no con `supabase start`): Postgres 17.6 detrás del pooler Supavisor en `localhost:5432` (modo sesión) y `6543` (modo transacción). El usuario de conexión lleva el tenant: `postgres.supabase-automatizaciones`. El esquema `public` estaba vacío.
- Las URLs viven en `.env` (`DATABASE_URL_READ` y `DATABASE_URL_WRITE`); por ahora apuntan al mismo usuario `postgres`. Los roles separados llegan en la fase 2.
- Nota PowerShell 5.1: `Set-Content -Encoding utf8` agrega BOM y rompe parsers de `.env`; los archivos se escriben sin BOM.

## Requisitos
- R1: Proyecto TypeScript con versiones exactas fijadas en `package.json`.
- R2: Un grafo `StateGraph` con un único nodo `chat` que llama a Claude. El estado tiene solo `messages`, con reducer de mensajes.
- R3: Un comando `npm run chat` abre una conversación por terminal; el historial vive en el estado del grafo, no en una variable aparte.
- R4: El modelo se elige por variable de entorno (`MODEL_AGENT`), por defecto Haiku 5.5 para desarrollar.
- R5: El prompt del sistema vive en un archivo propio (`src/graph/prompts/`), no dentro de la función.
- R6: En el Supabase local (autoalojado, ver Contexto) se crea el esquema del plan: `clients`, `staff`, `services`, `appointments`, `products`, `sales`, `sale_items`, `action_log`.
- R7: Un barbero no puede tener turnos superpuestos; lo garantiza la base (constraint), no el código.
- R8: Un script de seed determinístico (semilla fija) genera ~90 días de historial coherente.
- R9: `ANTHROPIC_API_KEY` y las cadenas de conexión viven en `.env`; solo `.env.example` se versiona. El arranque falla con mensaje claro si falta una variable.

## Criterios de aceptación
- [ ] CA1: dado `.env` con la clave, cuando corro `npm run chat` y escribo un mensaje, entonces Claude responde.
- [ ] CA2: dado que le dije mi nombre en el primer mensaje, cuando pregunto "¿cómo me llamo?" en el segundo, entonces responde bien (el historial viene del estado del grafo).
- [ ] CA3: dado Supabase corriendo, cuando corro `npm run db:reset`, entonces se recrean las tablas del negocio en `public` (sin tocar otros esquemas) y corre el seed.
- [ ] CA4: dado el seed cargado, entonces las filas por tabla son: `clients` = 30, `staff` = 3, `services` = 4, `products` = 15, y `appointments`, `sales` y `sale_items` tienen datos de ~90 días (rangos exactos fijados en T5).
- [ ] CA5: dado el seed, entonces ningún barbero tiene turnos superpuestos, cada `sales.total` es igual a la suma de sus `sale_items` y ningún `products.stock` es negativo.
- [ ] CA6: dado un intento de insertar un turno que se superpone con otro del mismo barbero, entonces la base lo rechaza.
- [ ] CA7: dado `.env` fuera de git (`git check-ignore .env`), entonces `.env` no se versiona y `.env.example` sí.
- [ ] CA8: dado que falta `ANTHROPIC_API_KEY`, cuando arranco `npm run chat`, entonces falla con un mensaje que nombra la variable faltante.
- [ ] CA9: `npm test` pasa (CA4, CA5 y CA6 automatizados con Vitest; el grafo con un modelo falso).

## Fuera de alcance
- Roles de base de datos de lectura y escritura (fase 2).
- Herramientas, router, persistencia de hilos, aprobación humana.
- Medir costo real por conversación (fase 2).
- Streaming de tokens en la terminal (se imprime la respuesta completa).

## Diseño (plan técnico)

**Grafo**

```
START → chat → END
```

- Estado: `messages` con el reducer de mensajes de LangGraph (agrega, no reemplaza).
- Nodo `chat`: invoca `ChatAnthropic` con el prompt del sistema + `state.messages` y devuelve `{ messages: [respuesta] }`.
- Compilado sin checkpointer (llega en la fase 4). En la terminal, cada turno hace `graph.invoke` con el historial acumulado que devuelve el grafo.
- Pendiente de confirmar contra la documentación oficial al implementar: la forma actual de declarar el estado con Zod en la serie 1.x.

**Base de datos**

- Se usa el Supabase que ya corre en Docker; conexión por el pooler en modo sesión (puerto 5432). Empaquetar ese stack en el repo es de la fase 12. Esquema y migraciones con Prisma (versión a decidir en T5 según Prisma 7/8).
- Prisma para el cliente tipado. La restricción de no superposición usa una exclusion constraint de Postgres (`btree_gist`), que Prisma no expresa, así que va en SQL crudo dentro de la migración.
- Seed en TypeScript con generador pseudoaleatorio de semilla fija: mismos datos en cada corrida.

**Archivos**

```
package.json, tsconfig.json, vitest.config.ts, .gitignore, .env.example, README.md
src/config/env.ts            validación de variables con Zod
src/graph/state.ts           estado
src/graph/nodes/chat.ts      nodo chat
src/graph/prompts/system.md  prompt del sistema
src/graph/index.ts           arma y compila el grafo
src/cli/chat.ts              conversación por terminal
prisma/schema.prisma, supabase/config.toml, src/db/seed.ts
tests/graph.test.ts, tests/db.test.ts
```

**Dependencias:** `@langchain/langgraph`, `@langchain/core`, `@langchain/anthropic`, `zod`, `prisma` y `@prisma/client`, `tsx`, `typescript`, `vitest`. Gestor: npm.

## Tareas
Orden pensado para aprender LangGraph primero y dejar Docker para después.

- [x] T1: `git init`, `.gitignore`, `package.json`, TypeScript, Vitest y `.env.example`. *Verif.:* `npm test` corre (sin tests aún) y `git check-ignore .env` responde.
- [x] T2: validación de entorno (`src/config/env.ts`). *Verif.:* CA8.
- [x] T3: estado, nodo `chat` y grafo compilado, con test usando un modelo falso. *Verif.:* test del grafo en verde.
- [x] T4: conversación por terminal (`npm run chat`). *Verif.:* CA1 y CA2 a mano.
- [ ] T5: esquema y constraint de no superposición en el Supabase local. *Verif.:* CA3 y CA6.
- [ ] T6: seed determinístico y tests de conteos y coherencia. *Verif.:* CA4, CA5 y CA9.
- [ ] T7: README con los comandos en PowerShell, nota "qué aprendí", commit y etiqueta `fase-01`.

## Qué aprendí
*(se completa al cerrar la fase)*
