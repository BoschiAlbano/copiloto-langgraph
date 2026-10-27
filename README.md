# Copiloto de gestión con LangGraph

Copiloto conversacional para una barbería ficticia (clientes, turnos, ventas y stock), construido por fases para aprender LangGraph. El plan completo está en `doc/` y cada fase tiene su spec en `specs/`.

**Estado:** fase 1 terminada (grafo de un nodo + base de datos con datos de prueba).

## Requisitos

- Node.js 24 o superior y npm
- Docker Desktop corriendo, con un Supabase local (autoalojado) levantado
- Una clave de la API de Claude (consola de Anthropic, con límite de gasto mensual configurado)

## Puesta en marcha (PowerShell)

```powershell
npm install
Copy-Item .env.example .env     # y completá los valores
npm run db:reset                # crea las tablas y carga los datos de prueba
npm run chat                    # conversación por terminal
```

### Variables de entorno (`.env`)

| Variable | Qué es |
| --- | --- |
| `ANTHROPIC_API_KEY` | Clave de la API de Claude |
| `MODEL_AGENT` | Modelo del agente (por defecto `claude-haiku-5-5`) |
| `DATABASE_URL_READ` / `DATABASE_URL_WRITE` | Conexión a Postgres. Por ahora apuntan al mismo usuario; los roles separados llegan en la fase 2 |

El Supabase local se conecta por el pooler (Supavisor), que exige el tenant en el usuario: `postgres.<POOLER_TENANT_ID>`. Si falla con `ENOIDENTIFIER`, falta ese sufijo. El valor sale del `.env` de tu Supabase (`POOLER_TENANT_ID`).

`.env` nunca se versiona; solo `.env.example`.

## Comandos

| Comando | Qué hace |
| --- | --- |
| `npm run chat` | Chat por terminal con el grafo (escribí `salir` para terminar) |
| `npm run db:reset` | Elimina y recrea las tablas del negocio en `public`, aplica las migraciones y carga el seed |
| `npm run db:seed` | Vuelve a cargar solo los datos de prueba |
| `npm run db:migrate` | Aplica migraciones pendientes |
| `npm run db:generate` | Regenera el cliente de Prisma (después de tocar `prisma/schema.prisma`) |
| `npm test` | Tests (los de base de datos necesitan haber corrido `db:reset`) |
| `npm run typecheck` | Chequeo de tipos |

`db:reset` solo toca las tablas del negocio; no borra el esquema `public` entero porque Supabase guarda ahí otras cosas.

## Estructura

```
specs/            plan técnico y una spec por fase
src/graph/        grafo, estado, nodos y prompts
src/db/           cliente Prisma, generador de datos de prueba, seed y reset
src/config/       validación de variables de entorno
src/cli/          chat por terminal
prisma/           esquema y migraciones (incluye las reglas que Prisma no expresa)
tests/            Vitest
```

## Datos de prueba

El seed es determinístico (semilla fija) y se ancla a la fecha en que se corre: 90 días de historial más 14 de agenda futura, de lunes a sábado, con 3 barberos. Los montos son pesos argentinos enteros.

Un cliente tiene en sus notas un texto que intenta dar órdenes al modelo ("ignorá tus instrucciones…"). Es intencional: sirve para comprobar en las fases 2 y 5 que los datos se tratan como datos y no como instrucciones.
