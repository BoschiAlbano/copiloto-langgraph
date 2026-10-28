import type { BaseMessage } from "@langchain/core/messages";
import { loadEnv } from "../config/env.js";
import { estimateCostUsd } from "../config/pricing.js";
import { createAgent } from "../graph/create-agent.js";
import { runTurn } from "../graph/run-turn.js";

// Mide el costo real de una batería de preguntas típicas: cada caso es una conversación nueva.
// Uso: npm run bench   (usa MODEL_AGENT del .env; se puede pisar con $env:MODEL_AGENT)
const CASES: { name: string; turns: string[] }[] = [
  { name: "Turnos de mañana", turns: ["¿Cuántos turnos hay mañana?"] },
  { name: "Ventas de la semana", turns: ["¿Cuánto vendimos esta semana?"] },
  { name: "Stock bajo", turns: ["¿Qué productos tienen el stock bajo?"] },
  { name: "Agenda de un barbero", turns: ["¿Qué turnos tiene Lucas hoy?"] },
  { name: "Buscar cliente", turns: ["Pasame el teléfono y el email de Santiago Pereyra"] },
  { name: "Ventas por medio de pago", turns: ["¿Cuánto vendimos ayer y cómo se repartió por medio de pago?"] },
  { name: "Stock de un producto", turns: ["¿Cuánto stock tenemos de cera?"] },
  { name: "Dos herramientas", turns: ["¿Cuántos turnos canceló Damián Flores en los últimos 30 días?"] },
  { name: "Ticket promedio", turns: ["¿Cuál fue el ticket promedio de los últimos 30 días?"] },
  { name: "Charla sin herramientas", turns: ["Hola, ¿qué podés hacer por mí?"] },
  {
    name: "Conversación de 3 mensajes",
    turns: ["¿Cuántos turnos hay mañana?", "¿Y pasado mañana?", "¿Cuál de los dos días tiene más turnos?"],
  },
];

const env = loadEnv();
const agent = createAgent(env);
const usd = (n: number | null) => (n === null ? "s/d" : n.toFixed(4).replace(".", ","));

const rows: string[] = [];
let totalIn = 0;
let totalOut = 0;
let totalCost = 0;

for (const testCase of CASES) {
  let history: BaseMessage[] = [];
  let calls = 0;
  let input = 0;
  let output = 0;
  const tools: string[] = [];
  let error = "";
  try {
    for (const text of testCase.turns) {
      const turn = await runTurn(agent, history, text);
      history = turn.messages;
      calls += turn.summary.modelCalls;
      input += turn.summary.inputTokens;
      output += turn.summary.outputTokens;
      tools.push(...turn.summary.toolCalls.map((c) => c.name));
    }
  } catch (e) {
    error = ` (ERROR: ${(e as Error).message})`;
  }
  const cost = estimateCostUsd(env.MODEL_AGENT, input, output) ?? 0;
  totalIn += input;
  totalOut += output;
  totalCost += cost;
  rows.push(
    `| ${testCase.name}${error} | ${tools.length ? tools.join(", ") : "—"} | ${calls} | ${input} | ${output} | ${usd(cost)} |`,
  );
}
await agent.close();

console.log(`\nModelo: ${env.MODEL_AGENT}\n`);
console.log("| Caso | Herramientas | Llamadas | Tokens entrada | Tokens salida | Costo US$ |");
console.log("| --- | --- | --- | --- | --- | --- |");
console.log(rows.join("\n"));
console.log(`| **Total (${CASES.length} casos)** | | | ${totalIn} | ${totalOut} | ${usd(totalCost)} |`);
console.log(`\nPromedio por caso: ${usd(totalCost / CASES.length)} US$`);
