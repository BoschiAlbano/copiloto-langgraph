# Fase 1: Entorno y primer grafo

Estado: **terminada** (etiqueta `fase-01`)

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
- [x] CA1: dado `.env` con la clave, cuando corro `npm run chat` y escribo un mensaje, entonces Claude responde.
- [x] CA2: dado que le dije mi nombre en el primer mensaje, cuando pregunto "¿cómo me llamo?" en el segundo, entonces responde bien (el historial viene del estado del grafo).
- [x] CA3: dado Supabase corriendo, cuando corro `npm run db:reset`, entonces se recrean las tablas del negocio en `public` (sin tocar otros esquemas) y corre el seed.
- [x] CA4: dado el seed cargado, entonces las filas por tabla son: `clients` = 30, `staff` = 3, `services` = 4, `products` = 15, y `appointments`, `sales` y `sale_items` tienen datos de ~90 días (rangos exactos fijados en T5).
- [x] CA5: dado el seed, entonces ningún barbero tiene turnos superpuestos, cada `sales.total` es igual a la suma de sus `sale_items` y ningún `products.stock` es negativo.
- [x] CA6: dado un intento de insertar un turno que se superpone con otro del mismo barbero, entonces la base lo rechaza.
- [x] CA7: dado `.env` fuera de git (`git check-ignore .env`), entonces `.env` no se versiona y `.env.example` sí.
- [x] CA8: dado que falta `ANTHROPIC_API_KEY`, cuando arranco `npm run chat`, entonces falla con un mensaje que nombra la variable faltante.
- [x] CA9: `npm test` pasa (CA4, CA5 y CA6 automatizados con Vitest; el grafo con un modelo falso).

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
- [x] T5: esquema y constraint de no superposición en el Supabase local. *Verif.:* CA3 y CA6.
- [x] T6: seed determinístico y tests de conteos y coherencia. *Verif.:* CA4, CA5 y CA9.
- [x] T7: README con los comandos en PowerShell, nota "qué aprendí", commit y etiqueta `fase-01`.

## Decisiones tomadas durante la fase
- **Prisma 7.10.1** y no la 8: `prisma@latest` es todavía un release candidate (8.0.0-rc.28) y `@prisma/client` estable sigue en 7.x. Se revisa más adelante.
- **Montos en pesos enteros** (`Int`), sin centavos: simplifica sumas, reportes y las herramientas de fases siguientes.
- **Esquema por migración SQL** generada con `prisma migrate diff` y completada a mano con lo que Prisma no expresa: exclusion constraint de turnos (los cancelados no ocupan horario), CHECKs de integridad y RLS activado en las 8 tablas (Supabase expone `public` por su API REST).
- **`db:reset`** borra solo las tablas del negocio, no el esquema `public`.
- **Seed anclado a la fecha de ejecución**: las cantidades de turnos, ventas y renglones varían según el día; las fijas (30/3/4/15) no. Hoy: 2021 turnos, 1567 ventas, 2069 renglones.
- El seed incluye un cliente con una nota que simula una inyección de instrucciones, para las pruebas de las fases 2 y 5.
- Para la fase 2: los roles de lectura y escritura tendrán que contemplar RLS (políticas o `BYPASSRLS`), porque hoy las tablas tienen RLS activo sin políticas.

## Qué aprendí
- **`StateGraph` + estado.** El estado es un esquema (`StateSchema`); cada campo puede tener un reducer. `MessagesValue` agrega mensajes en vez de reemplazarlos.
- **Nodo.** Es una función `(estado) → actualización parcial`. Devuelve solo lo nuevo (`{ messages: [respuesta] }`) y LangGraph lo combina con el estado.
- **`START` / `END` y `compile()`.** Las aristas definen el recorrido; compilar produce un objeto que se invoca con `graph.invoke(...)`.
- **Sin checkpointer el grafo no recuerda nada entre invocaciones.** El historial lo devuelve el grafo y la terminal se lo vuelve a pasar. En la fase 4 eso lo reemplaza el checkpointer.
- **Inyección de dependencias para probar.** El nodo recibe el modelo como parámetro, así los tests usan uno falso sin gastar API.
- Dudas abiertas: cuándo conviene `MessagesDeltaValue` (experimental) en hilos largos; cómo se verá una traza de este grafo (fase 11).
