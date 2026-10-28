import type { BaseMessage } from "@langchain/core/messages";
import { loadEnv } from "../config/env.js";
import { createAgent } from "../graph/create-agent.js";
import { runTurn } from "../graph/run-turn.js";
import { costOfUsage, mergeUsage, totalUsage, type ModelUsage } from "../graph/usage-tracker.js";
import { usd } from "./format.js";

// Mide el costo real de una batería de preguntas típicas: cada caso es una conversación nueva.
// Uso: npm run bench   (modelos de .env; se pueden pisar con $env:MODEL_AGENT y $env:MODEL_ROUTER)
interface Case {
  name: string;
  turns: string[];
  /** "base" = los 11 casos de la fase 2 (comparables); "extra" = ramas nuevas de la fase 3. */
  group: "base" | "extra";
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
  { group: "extra", name: "Pedido de acción (marcador)", turns: ["Cancelá el turno de Facundo Sosa de hoy."] },
  { group: "extra", name: "Pedido de reporte (marcador)", turns: ["Armame el resumen de la semana."] },
  { group: "extra", name: "Pedido ambiguo (aclaración)", turns: ["Cancelalo."] },
];

const env = loadEnv();
const agent = createAgent(env);

const rows: Record<Case["group"], string[]> = { base: [], extra: [] };
const usageByGroup: Record<Case["group"], ModelUsage[]> = { base: [], extra: [] };
const costByGroup: Record<Case["group"], number> = { base: 0, extra: 0 };

for (const testCase of CASES) {
  let history: BaseMessage[] = [];
  let usage: ModelUsage[] = [];
  const tools: string[] = [];
  const routes: string[] = [];
  let error = "";
  try {
    for (const text of testCase.turns) {
      const turn = await runTurn(agent, history, text);
      history = turn.messages;
      usage = mergeUsage(usage, turn.summary.usage);
      tools.push(...turn.summary.toolCalls.map((c) => c.name));
      if (turn.route.intent) routes.push(turn.route.intent);
    }
  } catch (e) {
    error = ` (ERROR: ${(e as Error).message})`;
  }
  const total = totalUsage(usage);
  const cost = costOfUsage(usage) ?? 0;
  usageByGroup[testCase.group] = mergeUsage(usageByGroup[testCase.group], usage);
  costByGroup[testCase.group] += cost;
  rows[testCase.group].push(
    `| ${testCase.name}${error} | ${routes.join(", ") || "—"} | ${tools.join(", ") || "—"} | ${total.calls} | ${total.inputTokens} | ${total.outputTokens} | ${usd(cost).replace("US$ ", "")} |`,
  );
}
await agent.close();

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
