import { loadEnvOrExit } from "../config/env.js";
import { createAgent } from "../graph/create-agent.js";
import pg from "pg";
import { mondayInThreeWeeks } from "../../evals/action-cases.js";
import { resumeTurn, runTurn } from "../graph/run-turn.js";
import { newThreadId } from "../graph/thread-id.js";
import { deleteThread } from "../graph/threads.js";
import { costOfUsage, mergeUsage, totalUsage, type ModelUsage } from "../graph/usage-tracker.js";
import { usd } from "./format.js";
import { evalNamespace } from "../../evals/memory.js";
import { clearMemories, saveMemory } from "../memory/store.js";

// Mide el costo real de una batería de preguntas típicas: cada caso es un hilo nuevo (se borra al terminar).
// Uso: npm run bench   (modelos de .env; se pueden pisar con $env:MODEL_AGENT y $env:MODEL_ROUTER)
interface Case {
  name: string;
  turns: string[];
  /** "base" = los 11 casos de la fase 2 (comparables); "extra" = ramas nuevas de la fase 3. */
  group: "base" | "extra";
  /** Memorias del negocio en el Store durante el caso (fase 8); se borran al terminar. */
  memories?: { kind: "rule" | "preference"; text: string }[];
}

const CASES: Case[] = [
  { group: "base", name: "Turnos de mañana", turns: ["¿Cuántos turnos hay mañana?"] },
  { group: "base", name: "Ventas de la semana", turns: ["¿Cuánto vendimos esta semana?"] },
  { group: "base", name: "Stock bajo", turns: ["¿Qué productos tienen el stock bajo?"] },
  { group: "base", name: "Agenda de un barbero", turns: ["¿Qué turnos tiene Lucas hoy?"] },
  { group: "base", name: "Buscar cliente", turns: ["Pasame el teléfono y el email de Santiago Pereyra"] },
  { group: "base", name: "Ventas por medio de pago", turns: ["¿Cuánto vendimos ayer y cómo se repartió por medio de pago?"] },
  { group: "base", name: "Stock de un producto", turns: ["¿Cuánto stock tenemos de cera?"] },
  { group: "base", name: "Dos herramientas", turns: ["¿Cuántos turnos canceló Damián Flores en los últimos 30 días?"] },
  { group: "base", name: "Ticket promedio", turns: ["¿Cuál fue el ticket promedio de los últimos 30 días?"] },
  { group: "base", name: "Charla sin herramientas", turns: ["Hola, ¿qué podés hacer por mí?"] },
  {
    group: "base",
    name: "Conversación de 3 mensajes",
    turns: ["¿Cuántos turnos hay mañana?", "¿Y pasado mañana?", "¿Cuál de los dos días tiene más turnos?"],
  },
  // Acciones: se pide, el copiloto propone y se RECHAZA (no se modifica ningún dato). Tiene las mismas llamadas al modelo
  // que aprobar: en los dos casos el agente contesta una vez más después de la decisión.
  { group: "extra", name: "Acción: ajustar stock (propuesta y rechazo)", turns: ["Sumá 20 unidades al stock de shampoo anticaspa."] },
  {
    group: "extra",
    name: "Acción: agendar turno (propuesta y rechazo)",
    turns: [`Agendá un corte para Julián Romero el ${mondayInThreeWeeks(new Date()).spoken} a las 15 con Lucas.`],
  },
  // Reporte: planificador + tres secciones en paralelo (sin modelo) + «Lectura». Sin ciclo de herramientas.
  { group: "extra", name: "Reporte en paralelo (resumen de la semana)", turns: ["Armame el resumen de la semana."] },
  { group: "extra", name: "Reporte en paralelo (últimos 30 días)", turns: ["Dame un panorama completo del negocio de los últimos 30 días."] },
  { group: "extra", name: "Pedido ambiguo (aclaración)", turns: ["Cancelalo."] },
  // Pedidos mixtos (fase 7): el supervisor pasa por dos agentes en el mismo turno. La acción se rechaza, como arriba.
  {
    group: "extra",
    name: "Mixto: venta y stock (M1, propuesta y rechazo)",
    turns: ["Registrá la venta de un gel fijación fuerte en efectivo y decime cuánto stock queda."],
  },
  { group: "extra", name: "Mixto: stock y reporte del mes (M3)", turns: ["Decime cuánto stock queda de gel fijación fuerte y armame el resumen del mes."] },
  // Memoria (fase 8): anotar una regla, y la consulta de «Turnos de mañana» con 5 memorias en contexto (compararla con esa).
  { group: "extra", name: "Memoria: anotar una regla", turns: ["Acordate de que los lunes no se agendan turnos."] },
  {
    group: "extra",
    name: "Turnos de mañana con 5 memorias en contexto",
    turns: ["¿Cuántos turnos hay mañana?"],
    memories: [
      { kind: "rule", text: "Los lunes no se agendan turnos." },
      { kind: "rule", text: "Los turnos de color duran 90 minutos." },
      { kind: "rule", text: "Lucas no trabaja los sábados." },
      { kind: "preference", text: "Decí los montos con la palabra pesos, sin el signo." },
      { kind: "preference", text: "Contestá en no más de tres oraciones." },
    ],
  },
];

// `npm run bench -- --extra` mide solo las ramas nuevas (más barato, útil con Sonnet).
const onlyExtra = process.argv.includes("--extra");
const cases = onlyExtra ? CASES.filter((c) => c.group === "extra") : CASES;

const env = loadEnvOrExit();
// Memoria en un namespace propio: el bench no toca las memorias del negocio.
const agent = createAgent(env, { memoryNamespace: evalNamespace() });

const benchThreads: string[] = [];
const rows: Record<Case["group"], string[]> = { base: [], extra: [] };
const usageByGroup: Record<Case["group"], ModelUsage[]> = { base: [], extra: [] };
const costByGroup: Record<Case["group"], number> = { base: 0, extra: 0 };

for (const testCase of cases) {
  const threadId = newThreadId();
  await clearMemories(agent.memory);
  for (const m of testCase.memories ?? []) await saveMemory(agent.memory, m);
  let usage: ModelUsage[] = [];
  const tools: string[] = [];
  const routes: string[] = [];
  let error = "";
  try {
    for (const text of testCase.turns) {
      const turn = await runTurn(agent, threadId, text);
      usage = mergeUsage(usage, turn.summary.usage);
      tools.push(...turn.summary.toolCalls.map((c) => c.name));
      if (turn.route.intent) routes.push((turn.route.tasks ?? []).map((t) => t.intent).join("→") || turn.route.intent);
      if (turn.awaiting) {
        // Se rechaza: tiene las mismas llamadas al modelo que aprobar (el agente contesta una vez más) y no toca datos.
        const decided = await resumeTurn(agent, threadId, { decision: "reject", comment: "medición de costo" });
        usage = mergeUsage(usage, decided.summary.usage);
        tools.push(...decided.summary.toolCalls.map((c) => c.name));
      }
    }
  } catch (e) {
    error = ` (ERROR: ${(e as Error).message})`;
  } finally {
    await deleteThread(agent.checkpointer, threadId); // la batería no deja hilos en la base
    await agent.traces.deleteThread(threadId);
    benchThreads.push(threadId);
  }
  const total = totalUsage(usage);
  const cost = costOfUsage(usage) ?? 0;
  usageByGroup[testCase.group] = mergeUsage(usageByGroup[testCase.group], usage);
  costByGroup[testCase.group] += cost;
  rows[testCase.group].push(
    `| ${testCase.name}${error} | ${routes.join(", ") || "—"} | ${tools.join(", ") || "—"} | ${total.calls} | ${total.inputTokens} | ${total.outputTokens} | ${usd(cost).replace("US$ ", "")} |`,
  );
}
await clearMemories(agent.memory);
await agent.close();

// Los rechazos dejan filas en la auditoría: la batería es de medición, no de uso, así que las borra (con el dueño).
if (process.env.DATABASE_URL_WRITE) {
  const owner = new pg.Client({ connectionString: process.env.DATABASE_URL_WRITE });
  await owner.connect();
  await owner.query(`DELETE FROM action_log WHERE thread_id = ANY($1)`, [benchThreads]);
  await owner.end();
}

const header = [
  "| Caso | Ruta | Herramientas | Llamadas | Tokens entrada | Tokens salida | Costo US$ |",
  "| --- | --- | --- | --- | --- | --- | --- |",
];
const totalRow = (label: string, group: Case["group"]) => {
  const t = totalUsage(usageByGroup[group]);
  return `| **${label}** | | | ${t.calls} | ${t.inputTokens} | ${t.outputTokens} | ${usd(costByGroup[group]).replace("US$ ", "")} |`;
};

console.log(`\nRouter: ${env.MODEL_ROUTER} · Agente: ${env.MODEL_AGENT}\n`);
console.log([...header, ...rows.base, totalRow("Total (11 casos, comparables con la fase 2)", "base")].join("\n"));
console.log(`\nPromedio por caso: ${usd(costByGroup.base / rows.base.length)}\n`);
console.log([...header, ...rows.extra, totalRow("Total (ramas nuevas)", "extra")].join("\n"));
