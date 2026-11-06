# Guía de operación

Cómo arrancar, parar, revisar, respaldar y mantener el copiloto en esta máquina. Los comandos son de PowerShell, desde la carpeta del repositorio.

## Arrancar y parar

| Para | Comando |
| --- | --- |
| La primera vez (de un clon nuevo) | `npm install`, `Copy-Item .env.example .env`, poner `ANTHROPIC_API_KEY` en `.env`, `npm run setup` |
| Cada vez | `npm run start`: levanta la base, revisa que todo esté en orden y sirve la web en `http://127.0.0.1:3000` |
| Parar la web | `Ctrl+C` en la terminal donde corre `npm run start` |
| Parar la base | `npm run stop` (los datos quedan guardados) |
| Usar la terminal en vez de la web | `npm run chat` (la base tiene que estar levantada) |

`npm install` puede avisar que bloqueó scripts de instalación (`allow-scripts`, de `prisma`, `@prisma/engines` y `esbuild`). Es normal con npm 11: el copiloto no los necesita.

**Con la base propia** (`docker-compose.yml`, Postgres 17 en el puerto 54329) hace falta Docker Desktop abierto. La base vuelve sola si Docker se reinicia, pero si Docker Desktop se cierra, no hay base: `start` lo detecta y pide abrirlo.

**Con un Supabase propio** (la forma 2 de `.env.example`), `start` y `stop` no tocan la base: se levanta y se para como siempre.

## Saber si está sano

`npm run doctor` revisa todo y dice qué hacer si algo falla:
- la configuración;
- cada rol con su contraseña;
- las tablas y los esquemas;
- las migraciones;
- la clave de la API, pidiendo la lista de modelos, que no gasta tokens.

`setup` y `start` lo corren solos.

| Si dice… | Hacé esto |
| --- | --- |
| «la base no responde» | Abrí Docker Desktop y corré `npm run start` (o levantá tu Supabase) |
| «el rol … no puede entrar con la contraseña de .env» | `npm run setup` (le asigna a cada rol la contraseña de su URL) |
| «no existe» (un esquema) | `npm run setup` (o `npm run db:checkpoints` / `npm run db:observability`) |
| «la clave no es válida» | Revisá `ANTHROPIC_API_KEY` (console.anthropic.com → API Keys) |
| «Faltan variables de entorno…» | Completá `.env` a partir de `.env.example` |

Si la web muestra «se cortó la conexión» o un turno queda «a medias», no se perdió nada: «Continuar» lo retoma desde donde quedó.

## Respaldos

| Para | Comando |
| --- | --- |
| Hacer un respaldo | `npm run db:backup`: queda en `backups/` (se guardan los últimos 10) |
| Ver qué reemplazaría una restauración | `npm run db:restore -- backups\<archivo>.dump` (sin `--yes` no cambia nada) |
| Restaurar | Pará la web (`Ctrl+C`) y corré `npm run db:restore -- backups\<archivo>.dump --yes` |

- **Qué se respalda:** solo los esquemas del copiloto. Son las tablas del negocio (`public`), los hilos y las memorias (`langgraph`), y las trazas y las evaluaciones (`observability`). Con un Supabase compartido, nunca se toca lo de otras aplicaciones; para respaldarlo, definí `BACKUP_CONTAINER` con el nombre de su contenedor (por ejemplo, `supabase-db`).
- **Cómo es la restauración:** antes de restaurar hace un respaldo de lo actual (`…-antes-de-restaurar-….dump`), restaura en una sola transacción (si algo falla, no cambia nada) y al final corre `doctor`.

**Restauración probada, paso a paso** (con la base propia, el 6 de noviembre de 2026):
1. `npm run db:backup` → `backups\copiloto-db-2026-11-06-175036.dump` (0,1 MB).
2. `npm run db:restore -- <ese archivo>` → mostró lo que hay (30 clientes, 2.021 turnos) y no cambió nada.
3. `npm run db:restore -- <ese archivo> --yes` → hizo el respaldo de seguridad, restauró y `doctor` dio todo en orden.

El test `tests/writes/backup-restore.test.ts` hace lo mismo con datos de verdad: agrega un hilo, una traza y un turno, respalda, los borra, restaura y comprueba que volvieron. Comprueba también que la restricción de turnos superpuestos y los permisos del esquema `public` sigan iguales.

**Respaldos automáticos:** no hay, pero se pueden programar con el Programador de tareas de Windows. Por ejemplo, todos los días a las 22:

```powershell
schtasks /Create /SC DAILY /ST 22:00 /TN "Copiloto - respaldo" /TR "cmd /c cd /d `"$PWD`" && npm run db:backup"
```

**Cifrado:** la base no se cifra; los respaldos y los registros tienen datos de clientes. Para protegerlos en reposo, cifrá el disco (BitLocker, en Configuración → Privacidad y seguridad → Cifrado de dispositivo).

## Límites

| Límite | Por defecto | Dónde se cambia | Qué pasa al alcanzarlo |
| --- | --- | --- | --- |
| Gasto por día en la API | US$ 1 | `DAILY_BUDGET_USD` (0 lo desactiva) | El turno no llama al modelo y lo dice; el hilo queda igual. Se reinicia a la medianoche de Argentina. Las evaluaciones no cuentan |
| Una llamada al modelo | 60 s | `MODEL_TIMEOUT_MS` | Se corta y LangChain la reintenta (hasta 3 veces) |
| Un turno entero | 3 min | `TURN_TIMEOUT_MS` | Se corta: el hilo queda a medias y «Continuar» lo retoma |
| Una consulta a la base | 10 s (5 s las escrituras de una acción) | fijo (`src/db/client.ts`) | La herramienta lo informa como falla; no se reintenta |
| Un turno a la vez por hilo, 4.000 caracteres por mensaje, 4 rondas de herramientas por tarea | — | fijos (fases 4, 9 y 10) | La web lo dice; el agente cierra la tarea con un mensaje |

Lo que se gastó cada día sale de las trazas: en `/traces` está el costo de cada turno.

**El límite de la consola de Anthropic** es aparte y vale para toda la cuenta: console.anthropic.com → Settings → Limits. Ahí se pone un tope de gasto mensual, que corta la API cuando se alcanza, sea cual sea el programa que la use. Conviene tenerlo, además del tope diario del copiloto.

## Registros y trazas

| Qué | Dónde | Cuánto se guarda |
| --- | --- | --- |
| **Registro de operación:** arranque, parada, cada turno (estado, duración, costo, id de la traza), reintentos, cortes, errores con su detalle | `logs\copiloto-AAAA-MM-DD.log`, una línea JSON por evento | 14 días (`LOG_RETENTION_DAYS`) |
| **Trazas:** el árbol de cada turno (nodos, llamadas al modelo con tokens, herramientas con argumentos y resultado) | `/traces` en la web, o «Ver traza» al pie de cada respuesta | 30 días (`TRACE_RETENTION_DAYS`) |
| **Evaluaciones:** las corridas de `npm run eval` | `/evals` en la web | sin límite |

El registro no guarda lo que dijo la persona ni los resultados de las herramientas: para eso están las trazas, que viven en la base con el mismo rol que los hilos. Las contraseñas de las URL se tapan (`rol:***@`).

Para ver los errores del día:

```powershell
Get-Content logs\copiloto-$(Get-Date -Format yyyy-MM-dd).log | Select-String '"level":"error"'
```

## Actualizar

- **Código nuevo** (por ejemplo, después de un `git pull`): `npm install`, `npm run setup` (aplica las migraciones nuevas y no pisa datos) y `npm run start` (recompila la web si cambió el código).
- **Después de cambiar algo en `src/`** con la web en modo desarrollo (`npm run web`), reiniciala: guarda el agente en memoria para no abrir conexiones nuevas en cada recarga.
- **Antes de cambiar un prompt**, compará: `npm run eval -- --compare evals/prompts/<carpeta> --runs 3` (ver `evals/prompts/README.md`).
- **Después de actualizar `@langchain/langgraph-checkpoint-postgres`**, corré `npm run db:checkpoints` (aplica las migraciones internas del paquete).

## El servidor local de LangGraph

LangGraph trae su propio servidor para correr un grafo como una API (el «Agent Server»), con dos modos:

- **`langgraph dev`:** corre el grafo como una API en la máquina, sin Docker y sin clave. Es para desarrollar: guarda el estado en una carpeta local (`.langgraph_api`) y se usa con LangGraph Studio para depurar.
- **`langgraph up`:** lo corre en Docker, con Postgres y Redis, pero pide una clave de LangSmith incluso para probar en local, y una licencia para producción.

El copiloto **no lo usa**. El plan pide no depender de servicios externos, salvo la API de Claude, y `langgraph up` depende de LangSmith. Además, el copiloto ya resuelve lo que daría ese servidor:
- los hilos guardados en Postgres (fase 4);
- el streaming a la web, con su propio servidor de eventos (fase 9);
- las pausas para aprobar (fase 5);
- las trazas propias (fase 11).

Para probarlo igual, haría falta un `langgraph.json` que apunte al grafo (`src/graph/index.ts`) y `npx @langchain/langgraph-cli dev`; no está en el repositorio.

## Checklist de operación

Cada punto se comprobó al cerrar la fase 12 (6 de noviembre de 2026):

- [x] **Arranque desde cero:** un clon limpio levantó con `npm install`, `.env`, `npm run setup` y `npm run start`, y contestó «¿Cuántos turnos hay mañana?» con la cantidad de SQL (23), por la web y por la terminal.
- [x] **Configuración:** sin `.env` o con una variable de menos, `setup`, `start`, la web y la terminal no arrancan y dicen cuál falta (`tests/doctor.test.ts` y pruebas a mano).
- [x] **Salud:** `npm run doctor` da todo en orden con la base propia y con Supabase, y señala cada problema con su arreglo (7 casos en `tests/doctor.test.ts`).
- [x] **Límite de gasto:** con el tope alcanzado, un turno no llama al modelo, la web responde con el aviso y una tarjeta pendiente sigue pendiente (`tests/budget.test.ts`).
- [x] **Límites de tiempo:** una llamada al modelo tiene 60 s. Una consulta lenta se corta con el código 57014, también por el pooler de Supabase (probado: `pg_sleep(12)` se cortó a los 10 s). Un turno que se pasa queda a medias y se continúa (`tests/timeouts.test.ts`).
- [x] **Registros:** un turno, un reintento, un corte y un error quedan en el archivo del día, sin el texto de los mensajes; los de más de 14 días se borran (`tests/log.test.ts`).
- [x] **Respaldo y restauración:** probados a mano y con `tests/writes/backup-restore.test.ts`: lo borrado vuelve, y los permisos y las restricciones quedan iguales.
- [x] **Claves fuera del repositorio:** `.env`, `backups/` y `logs/` están en `.gitignore`.
- [x] **Todo lo demás sigue andando:** los tests de las fases 2 a 11 pasan con la base propia y con Supabase.
