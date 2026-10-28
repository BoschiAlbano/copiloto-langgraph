import { createInterface } from "node:readline/promises";
import type { BaseMessage } from "@langchain/core/messages";
import { loadEnv } from "../config/env.js";
import { createAgent } from "../graph/create-agent.js";
import { AGENT_RECURSION_LIMIT } from "../graph/limits.js";
import { runTurn } from "../graph/run-turn.js";
import { costOfUsage, mergeUsage, type ModelUsage } from "../graph/usage-tracker.js";
import { describeUsagePerModel, describeUsageTotal, usd } from "./format.js";

let env;
try {
  env = loadEnv();
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

const agent = createAgent(env);
const rl = createInterface({ input: process.stdin, output: process.stdout });

const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;

console.log(
  `Copiloto de la barbería (router: ${env.MODEL_ROUTER} · agente: ${env.MODEL_AGENT}). Escribí "salir" para terminar.\n`,
);

// El historial es lo que devuelve el grafo en cada turno; acá solo se lo volvemos a pasar.
let messages: BaseMessage[] = [];
let session: ModelUsage[] = [];

let closed = false;
rl.on("close", () => (closed = true));
rl.setPrompt("Vos: ");
rl.prompt();

// for await encola las líneas y termina solo cuando se cierra la entrada (Ctrl+Z / EOF).
for await (const line of rl) {
  const input = line.trim();
  if (input.toLowerCase() === "salir") break;

  if (input) {
    try {
      const turn = await runTurn(agent, messages, input);
      messages = turn.messages;
      const { summary, route } = turn;
      session = mergeUsage(session, summary.usage);

      if (route.intent) console.log(dim(`\n  [ruta] ${route.intent}: ${route.reason ?? "sin motivo"}`));
      for (const call of summary.toolCalls) console.log(dim(`  [herramienta] ${call.name} ${JSON.stringify(call.args)}`));
      console.log(`\nCopiloto: ${turn.reply}\n`);
      console.log(dim(`  [uso] ${describeUsageTotal(summary.usage)} (sesión: ${usd(costOfUsage(session))})`));
      for (const detail of describeUsagePerModel(summary.usage)) console.log(dim(`        ${detail}`));
      console.log("");
    } catch (error) {
      const e = error as Error;
      const message =
        e.name === "GraphRecursionError"
          ? `El agente superó el límite de ${AGENT_RECURSION_LIMIT} pasos y se detuvo. Probá con una pregunta más concreta.`
          : `Error al procesar el pedido: ${e.message}`;
      console.error(`\n${message}\n`);
    }
  }
  if (!closed) rl.prompt();
}

rl.close();
await agent.close();
