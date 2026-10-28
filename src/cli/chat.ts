import { createInterface } from "node:readline/promises";
import type { BaseMessage } from "@langchain/core/messages";
import { estimateCostUsd } from "../config/pricing.js";
import { loadEnv } from "../config/env.js";
import { AGENT_RECURSION_LIMIT, createAgent } from "../graph/create-agent.js";
import { runTurn } from "../graph/run-turn.js";

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
const number = (n: number) => n.toLocaleString("es-AR");
const usd = (n: number | null) => (n === null ? "s/d" : `US$ ${n.toFixed(4).replace(".", ",")}`);

console.log(`Copiloto de la barbería (modelo: ${env.MODEL_AGENT}). Escribí "salir" para terminar.\n`);

// El historial es lo que devuelve el grafo en cada turno; acá solo se lo volvemos a pasar.
let messages: BaseMessage[] = [];
const session = { inputTokens: 0, outputTokens: 0 };

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
      const { summary } = turn;
      session.inputTokens += summary.inputTokens;
      session.outputTokens += summary.outputTokens;

      for (const call of summary.toolCalls) console.log(dim(`  [herramienta] ${call.name} ${JSON.stringify(call.args)}`));
      console.log(`\nCopiloto: ${turn.reply}\n`);
      console.log(
        dim(
          `  [uso] ${summary.modelCalls} llamada(s) al modelo · entrada ${number(summary.inputTokens)} · salida ${number(summary.outputTokens)} tokens · ` +
            `${usd(estimateCostUsd(env.MODEL_AGENT, summary.inputTokens, summary.outputTokens))} ` +
            `(sesión: ${usd(estimateCostUsd(env.MODEL_AGENT, session.inputTokens, session.outputTokens))})\n`,
        ),
      );
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
