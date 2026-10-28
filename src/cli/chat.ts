import { createInterface } from "node:readline/promises";
import { loadEnv } from "../config/env.js";
import { createAgent } from "../graph/create-agent.js";
import { AGENT_RECURSION_LIMIT } from "../graph/limits.js";
import { continueTurn, runTurn, type TurnResult } from "../graph/run-turn.js";
import { newThreadId, parseThreadId } from "../graph/thread-id.js";
import { conversationMessages, getStatus } from "../graph/threads.js";
import { costOfUsage, mergeUsage, type ModelUsage } from "../graph/usage-tracker.js";
import { describeUsagePerModel, describeUsageTotal, usd } from "./format.js";

let env;
try {
  env = loadEnv();
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

// npm run chat                       → hilo nuevo
// npm run chat -- --thread <id>      → retoma ese hilo (si no existe, lo crea)
function requestedThread(argv: string[]): string | undefined {
  const at = argv.indexOf("--thread");
  if (at === -1) return undefined;
  const value = argv[at + 1];
  if (!value) throw new Error("Falta el id después de --thread.");
  return parseThreadId(value);
}

let threadId: string;
try {
  threadId = requestedThread(process.argv.slice(2)) ?? newThreadId();
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

const agent = createAgent(env);
const rl = createInterface({ input: process.stdin, output: process.stdout });
const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;
const clip = (text: string, max = 200) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

console.log(
  `Copiloto de la barbería (router: ${env.MODEL_ROUTER} · agente: ${env.MODEL_AGENT}). Escribí "salir" para terminar.\n`,
);

// El historial vive en Postgres, por hilo: acá solo sabemos si el hilo quedó a medias.
let pending = false;
let session: ModelUsage[] = [];

try {
  const status = await getStatus(agent.graph, threadId);
  pending = status.pending;
  if (status.exists) {
    const recent = conversationMessages(status.messages).slice(-4);
    console.log(`Retomando el hilo ${threadId} (${conversationMessages(status.messages).length} mensajes). Lo último:`);
    for (const m of recent) console.log(dim(`  ${m.type === "human" ? "Vos" : "Copiloto"}: ${clip(m.text)}`));
    console.log("");
  } else {
    console.log(`Hilo nuevo: ${threadId}`);
    console.log(dim(`  Para retomarlo más tarde: npm run chat -- --thread ${threadId}\n`));
  }
  if (pending) {
    console.log(`⚠ El turno anterior de este hilo quedó a medias (falta: ${status.next.join(", ")}).`);
    console.log('  Escribí "/continuar" para terminarlo. Hasta entonces no se aceptan mensajes nuevos.\n');
  }
} catch (error) {
  console.error(`No se pudo leer el hilo: ${(error as Error).message}`);
  await agent.close();
  process.exit(1);
}

function show(turn: TurnResult) {
  const { summary, route } = turn;
  session = mergeUsage(session, summary.usage);
  if (route.intent) console.log(dim(`\n  [ruta] ${route.intent}: ${route.reason ?? "sin motivo"}`));
  for (const call of summary.toolCalls) console.log(dim(`  [herramienta] ${call.name} ${JSON.stringify(call.args)}`));
  console.log(`\nCopiloto: ${turn.reply}\n`);
  console.log(dim(`  [uso] ${describeUsageTotal(summary.usage)} (sesión: ${usd(costOfUsage(session))})`));
  for (const detail of describeUsagePerModel(summary.usage)) console.log(dim(`        ${detail}`));
  console.log("");
}

/** Corre un turno nuevo o la reanudación del pendiente y deja `pending` al día, también si falló. */
async function attempt(run: () => Promise<TurnResult>) {
  try {
    show(await run());
  } catch (error) {
    const e = error as Error;
    console.error(
      `\n${
        e.name === "GraphRecursionError"
          ? `El agente superó el límite de ${AGENT_RECURSION_LIMIT} pasos y se detuvo.`
          : `Error al procesar el pedido: ${e.message}`
      }`,
    );
  }
  // El mensaje de la persona ya quedó guardado: si el turno no terminó, se reanuda, no se vuelve a escribir.
  const status = await getStatus(agent.graph, threadId).catch(() => undefined);
  pending = status?.pending ?? pending;
  if (pending) console.error('El turno quedó a medias. Escribí "/continuar" para reintentarlo desde donde se cortó.\n');
}

let closed = false;
rl.on("close", () => (closed = true));
rl.setPrompt("Vos: ");
rl.prompt();

// for await encola las líneas y termina solo cuando se cierra la entrada (Ctrl+Z / EOF).
for await (const line of rl) {
  const input = line.trim();
  if (input.toLowerCase() === "salir") break;

  if (input.toLowerCase() === "/continuar") {
    if (pending) await attempt(() => continueTurn(agent, threadId));
    else console.log("No hay ningún turno a medias en este hilo.\n");
  } else if (input && pending) {
    console.log('Este hilo tiene un turno a medias. Escribí "/continuar" para terminarlo antes de seguir.\n');
  } else if (input) {
    await attempt(() => runTurn(agent, threadId, input));
  }
  if (!closed) rl.prompt();
}

rl.close();
console.log(dim(`\nHilo guardado: npm run chat -- --thread ${threadId}`));
await agent.close();
