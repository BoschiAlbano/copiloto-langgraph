import { createInterface } from "node:readline/promises";
import { ChatAnthropic } from "@langchain/anthropic";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { loadEnv } from "../config/env.js";
import { buildGraph } from "../graph/index.js";

let env;
try {
  env = loadEnv();
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

const graph = buildGraph(new ChatAnthropic({ model: env.MODEL_AGENT, apiKey: env.ANTHROPIC_API_KEY }));
const rl = createInterface({ input: process.stdin, output: process.stdout });

console.log(`Copiloto de la barbería (modelo: ${env.MODEL_AGENT}). Escribí "salir" para terminar.\n`);

// El historial es lo que devuelve el grafo en cada turno; acá solo se lo volvemos a pasar.
let messages: BaseMessage[] = [];

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
      const state = await graph.invoke({ messages: [...messages, new HumanMessage(input)] });
      messages = state.messages;
      console.log(`\nCopiloto: ${messages.at(-1)?.text}\n`);
    } catch (error) {
      console.error(`\nError al llamar al modelo: ${(error as Error).message}\n`);
    }
  }
  if (!closed) rl.prompt();
}

rl.close();
