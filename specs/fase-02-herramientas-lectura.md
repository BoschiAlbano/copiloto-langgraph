# Fase 2: Agente con herramientas de lectura

Estado: **aprobada, en implementación**

## Objetivo
Que el modelo consulte datos reales del negocio mediante herramientas acotadas, sin poder leer ni escribir nada fuera de ellas.

## Contexto
Existe de la fase 1 (etiqueta `fase-01`):

- Grafo `START → chat → END` con estado `messages`, sin herramientas.
- Base con las 8 tablas, RLS activo **sin políticas** y datos de prueba (2021 turnos, 1567 ventas, 15 productos; 2 productos bajo el mínimo).
- Usuario único `postgres` en `DATABASE_URL_READ` y `DATABASE_URL_WRITE` (a propósito: los roles separados quedaron para esta fase).
- Un cliente con una nota que simula inyección de instrucciones.

Precondiciones que dependen de la persona (no las puede verificar el código):

- Límite de gasto mensual configurado en la consola de la API (el plan lo exige antes de esta fase).

## Requisitos
- R1: Cuatro herramientas de lectura con esquema Zod y descripción clara para el modelo: `findClient`, `listAppointments`, `getSalesSummary`, `getStockLevels`.
- R2: Cada herramienta devuelve datos acotados: límite de filas, y cuando hay recorte informa el total real y `truncated: true`. Los conteos y sumas los calcula la base, nunca el modelo.
- R3: Las fechas que entran y salen son de la hora de Argentina (UTC-3). La herramienta convierte el día local a un rango UTC. Las salidas llevan el offset `-03:00`.
- R4: El prompt del sistema recibe la fecha y hora actuales de Argentina, para que "mañana" y "esta semana" se resuelvan bien.
- R5: Un nodo `agent` (modelo con herramientas) y un nodo `tools` (`ToolNode`) conectados en ciclo: el agente decide si llama herramientas o responde.
- R6: Un rol de base `copilot_reader` con solo `SELECT` sobre las tablas del negocio, más política RLS de lectura. Las herramientas se conectan con ese rol (`DATABASE_URL_READ`). El rol no puede escribir, ni siquiera por error. `action_log` queda fuera de su alcance.
- R7: Si una herramienta falla, el error vuelve al modelo como mensaje de herramienta y el prompt le exige informarlo sin inventar datos.
- R8: El modelo solo accede a la base a través de esas cuatro herramientas. No existe ninguna herramienta que acepte SQL. Los textos que vienen de la base (por ejemplo, notas de clientes) se tratan como datos, no como órdenes.
- R9: Tope de iteraciones del ciclo (`recursionLimit`) bajo en la terminal, para que un loop no dispare el gasto. La política completa llega en la fase 10.
- R10: La terminal muestra, por turno, las herramientas usadas, los tokens de entrada y salida y el costo estimado, con la tabla de precios en un archivo de configuración.
- R11: Se mide el costo real de una batería de preguntas típicas y se compara con la estimación del plan.

## Herramientas

| Herramienta | Entrada (Zod) | Devuelve | Tope |
| --- | --- | --- | --- |
| `findClient` | `query`: texto de 2 a 80 caracteres (nombre, teléfono o email) | Coincidencias: id, nombre, teléfono, email, notas | 10 |
| `listAppointments` | `dateFrom`, `dateTo` (`YYYY-MM-DD`, ambos inclusive, máx. 31 días); opcionales `staffName`, `clientId`, `status` | `total` exacto y las filas: id, cliente, barbero, servicio, inicio, fin, estado | 50 |
| `getSalesSummary` | `dateFrom`, `dateTo` (máx. 92 días) | Cantidad de ventas, total, ticket promedio, total por medio de pago y por tipo (productos o servicios) | sin filas |
| `getStockLevels` | opcionales `onlyLow` (boolean) y `query` (nombre o sku) | Producto, sku, stock, mínimo y `isLow` | 50 |

Reglas comunes: esquemas `strict` (claves desconocidas se rechazan), fechas validadas, ningún parámetro se concatena en SQL (consultas con Prisma o SQL parametrizado fijo en el código).

## Criterios de aceptación
- [ ] CA1: dado el seed, cuando pregunto "¿cuántos turnos hay mañana?", entonces la respuesta contiene el número que da una consulta SQL independiente (turnos de mañana, hora de Argentina, sin contar cancelados). Se comprueba con un test que usa el modelo real, activable con una variable (`RUN_LLM_TESTS=1`) para no gastar API en cada `npm test`.
- [ ] CA2: dado que una herramienta falla (por ejemplo, base inaccesible), cuando pregunto un dato, entonces el agente informa que no pudo consultarlo y no da cifras. Plomería automatizada con modelo falso; conducta del modelo real comprobada en una conversación de prueba escrita en esta spec.
- [ ] CA3: el agente no ejecuta SQL libre: existen exactamente 4 herramientas, ninguna acepta SQL, y un `query` como `'; DROP TABLE clients;--` se trata como texto (devuelve vacío y la tabla sigue existiendo).
- [ ] CA4: dado `DATABASE_URL_READ`, un test confirma que el rol no puede `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE` ni crear/alterar tablas, ni leer `action_log`.
- [ ] CA5: cada herramienta tiene tests contra la base de prueba con resultados verificados por SQL independiente, incluidos el recorte (`truncated`) y los rangos de fecha inválidos.
- [ ] CA6: el ciclo agente ↔ herramientas funciona con un modelo falso guionado: pregunta, llamada a herramienta, resultado, respuesta final, y también varias herramientas en un mismo turno.
- [ ] CA7: dado un ciclo que no termina, entonces el grafo corta por `recursionLimit` y la terminal informa el error sin colgarse.
- [ ] CA8: dado un cliente con una nota con "instrucciones", cuando pido ver a ese cliente, entonces el agente la muestra como contenido de la nota y no la sigue. Conversación de prueba escrita en esta spec.
- [ ] CA9: la terminal muestra herramientas usadas, tokens y costo por turno. Se registran en esta spec el costo real de una batería de al menos 8 preguntas y la comparación con la estimación del plan; si difieren, se actualiza el presupuesto del plan.
- [ ] CA10: `npm test` y `npm run typecheck` pasan, y `npm run db:reset` deja la base con el rol listo desde cero.

## Fuera de alcance
- Router de intención y ramas (fase 3). Aquí hay un solo agente.
- Persistir conversaciones (fase 4): el historial sigue viniendo de la terminal.
- Herramientas de escritura, aprobación humana y el rol de escritura (fase 5): `DATABASE_URL_WRITE` sigue siendo `postgres`.
- Reportes en paralelo (fase 6). `getSalesSummary` es una consulta simple.
- Política completa de reintentos y manejo de salidas inválidas (fase 10).
- Streaming.

## Diseño (plan técnico)

**Grafo**

```
START → agent ──(¿pidió herramientas?)── sí → tools → agent
                                        └─ no → END
```

- Estado: sin cambios (`messages`).
- `agent`: llama al modelo con las herramientas enlazadas (`bindTools`) y devuelve el mensaje nuevo.
- `tools`: `ToolNode` de `@langchain/langgraph/prebuilt` con `handleToolErrors` activo: una excepción se convierte en un mensaje de herramienta con el error.
- Arista condicional escrita a mano (mira el último mensaje: si trae `tool_calls`, va a `tools`; si no, a `END`). `toolsCondition` hace lo mismo; escribirla a mano deja el mecanismo a la vista. Si el tipado del estado lo permite, se compara con la prebuilt.
- El modelo se inyecta con una interfaz mínima (como en la fase 1) para probar con modelos falsos guionados.

**Fecha y zona horaria**
- `src/tools/dates.ts`: convierte `YYYY-MM-DD` local a `[inicio, fin)` en UTC y formatea instantes con `-03:00`. Argentina no tiene horario de verano.
- El prompt del sistema usa un marcador (`{{currentDateTime}}`) que el nodo reemplaza en cada llamada.

**Permisos (defensa en capas)**
- Migración `0002_reader_role`: crea `copilot_reader` (sin login y sin secretos), `GRANT SELECT` sobre las 7 tablas del negocio, políticas `FOR SELECT TO copilot_reader USING (true)` y `default_transaction_read_only = on`. Es idempotente.
- `npm run db:roles`: toma la contraseña de `DATABASE_URL_READ` y hace `ALTER ROLE ... LOGIN PASSWORD`. Así el secreto vive solo en `.env`. `db:reset` lo ejecuta después de migrar.
- El usuario en la URL lleva el tenant: `copilot_reader.supabase-automatizaciones`.
- Pendiente de confirmar al implementar: que `postgres` tenga `CREATEROLE` en este Supabase.

**Costos**
- `src/config/pricing.ts`: precio por millón de tokens de entrada y salida por modelo (valores del plan; a confirmar en la consola).
- Los tokens salen de `usage_metadata` de cada respuesta del modelo; el CLI suma todas las llamadas del turno.

**Archivos**

```
prisma/migrations/0002_reader_role/migration.sql
src/db/roles.ts                 npm run db:roles
src/tools/dates.ts
src/tools/find-client.ts, list-appointments.ts, get-sales-summary.ts, get-stock-levels.ts
src/tools/index.ts              arma las 4 herramientas con un cliente Prisma de lectura
src/graph/nodes/agent.ts        reemplaza a chat.ts
src/graph/prompts/system.md     actualizado: herramientas, errores, datos como datos
src/config/pricing.ts
src/cli/chat.ts                 muestra herramientas, tokens y costo; fija recursionLimit
tests/tools/*.test.ts, tests/reader-role.test.ts, tests/graph-tools.test.ts, tests/agent.llm.test.ts
```

## Mapas

**1. El ciclo agente ↔ herramientas**

```mermaid
flowchart LR
    S((START)) --> A["nodo agent<br/>modelo con herramientas enlazadas"]
    A --> D{"¿el último mensaje<br/>pide herramientas?"}
    D -- "sí" --> T["nodo tools<br/>ToolNode ejecuta cada llamada"]
    T -- "resultados como mensajes de herramienta" --> A
    D -- "no: respuesta final" --> E((END))
    T -. "si falla: el error vuelve como mensaje" .-> A
    A -. "recursionLimit corta el ciclo si no termina" .-> X(["Error controlado"])
```

**2. Capas de protección entre el modelo y los datos**

```mermaid
flowchart TD
    M["Modelo (Claude)<br/>decide qué herramienta llamar"] --> Z["1. Esquema Zod strict<br/>valida y rechaza parámetros raros"]
    Z --> H["2. Código de la herramienta<br/>consulta fija y parametrizada, con tope de filas"]
    H --> P["3. Prisma<br/>nunca recibe SQL escrito por el modelo"]
    P --> R["4. Rol copilot_reader<br/>solo SELECT, sesión de solo lectura"]
    R --> L["5. RLS<br/>política de lectura solo para este rol"]
    L --> DB[("Postgres")]
    DB -. "los datos vuelven como texto: nunca como instrucciones" .-> M
```

**3. Una pregunta, de punta a punta**

```mermaid
sequenceDiagram
    actor U as Persona
    participant C as Terminal
    participant A as Nodo agent
    participant L as Claude
    participant T as Nodo tools
    participant D as Base (rol lectura)
    U->>C: ¿Cuántos turnos hay mañana?
    C->>A: historial + mensaje, recursionLimit
    A->>L: sistema (con fecha de hoy) + mensajes
    L-->>A: pide listAppointments con dateFrom y dateTo = mañana
    A->>T: mensaje con la llamada
    T->>D: consulta parametrizada
    D-->>T: total exacto y filas
    T-->>A: mensaje de herramienta
    A->>L: todo lo anterior + resultado
    L-->>A: respuesta final en español
    A-->>C: historial completo
    C-->>U: respuesta + herramientas, tokens y costo
```

## Tareas
- [x] T1: migración `0002_reader_role`, script `db:roles`, `db:reset` actualizado y contraseña propia en `DATABASE_URL_READ`. *Verif.:* CA4.
- [x] T2: utilidades de fecha y zona horaria. *Verif.:* tests con casos de borde (medianoche, fin de mes).
- [x] T3: `findClient`. *Verif.:* CA5 y el caso de texto tipo SQL de CA3.
- [x] T4: `listAppointments`. *Verif.:* CA5 con el total de mañana contrastado con SQL.
- [x] T5: `getStockLevels` y `getSalesSummary`. *Verif.:* CA5.
- [x] T6: nodo `agent`, `ToolNode`, arista condicional y prompt nuevo, con modelo falso guionado. *Verif.:* CA6 y plomería de CA2.
- [x] T7: terminal con herramientas, tokens, costo y `recursionLimit`. *Verif.:* CA7 y CA9 (parte de la terminal).
- [ ] T8: pruebas con el modelo real (CA1, CA2, CA8), batería de costo, ajuste del presupuesto del plan, README y etiqueta `fase-02`. *Verif.:* CA1, CA2, CA8, CA9 y CA10.

## Conversaciones de prueba
*(se completan en T8 con el resultado real)*

## Medición de costo
*(se completa en T8)*

## Qué aprendí
*(se completa al cerrar la fase)*
