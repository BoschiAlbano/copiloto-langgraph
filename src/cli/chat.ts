import { createInterface } from "node:readline/promises";
import { loadEnv } from "../config/env.js";
import type { ApprovalRequest, HumanDecision } from "../graph/approval.js";
import { createAgent } from "../graph/create-agent.js";
import { AGENT_RECURSION_LIMIT } from "../graph/limits.js";
import { continueTurn, resumeTurn, runTurn, type TurnResult } from "../graph/run-turn.js";
import { newThreadId, parseThreadId } from "../graph/thread-id.js";
import { conversationMessages, getStatus } from "../graph/threads.js";
import { costOfUsage, mergeUsage, type ModelUsage } from "../graph/usage-tracker.js";
import { describeActionResult, describeCard, describeUsagePerModel, describeUsageTotal, parseDecisionInput, usd } from "./format.js";

let env;
try {
  env = loadEnv();
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

// npm run chat                       → hilo nuevo
// npm run chat <id>                  → retoma ese hilo (si no existe, lo crea)
// npm run chat -- --thread <id>      → lo mismo; en PowerShell 5.1 el `--` lo come el shell y npm se queda con la
//                                      opción, por eso también se acepta el id suelto.
function requestedThread(argv: string[]): string | undefined {
  const at = argv.indexOf("--thread");
  if (at !== -1) {
    const value = argv[at + 1];
    if (!value) throw new Error("Falta el id después de --thread.");
    return parseThreadId(value);
  }
  const bare = argv.find((a) => !a.startsWith("-"));
  return bare ? parseThreadId(bare) : undefined;
}

let threadId: string;
try {
  threadId = requestedThread(process.argv.slice(2)) ?? newThreadId();
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

const agent = createAgent(env);
const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;
const clip = (text: string, max = 200) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

console.log(
  `Copiloto de la barbería (router: ${env.MODEL_ROUTER} · agente: ${env.MODEL_AGENT}). Escribí "salir" para terminar.\n`,
);

// El historial vive en Postgres, por hilo. Acá solo se sabe en qué situación está el hilo:
//   pending   un turno quedó a medias por una falla → "/continuar"
//   awaiting  una acción espera la decisión de la persona → s / n / e
let pending = false;
let awaiting: ApprovalRequest | undefined;
let editing = false; // el próximo renglón son los parámetros nuevos (JSON)
let session: ModelUsage[] = [];

function showCard(request: ApprovalRequest) {
  console.log("");
  for (const line of describeCard(request)) console.log(line);
  console.log("");
}

try {
  const status = await getStatus(agent.graph, threadId);
  pending = status.pending;
  awaiting = status.awaiting;
  if (status.exists) {
    const recent = conversationMessages(status.messages).slice(-4);
    console.log(`Retomando el hilo ${threadId} (${conversationMessages(status.messages).length} mensajes). Lo último:`);
    for (const m of recent) console.log(dim(`  ${m.type === "human" ? "Vos" : "Copiloto"}: ${clip(m.text)}`));
    console.log("");
  } else {
    console.log(`Hilo nuevo: ${threadId}`);
    console.log(dim(`  Para retomarlo más tarde: npm run chat ${threadId}\n`));
  }
  if (awaiting) {
    console.log("⏸ Este hilo estaba esperando tu decisión sobre esta acción:");
    showCard(awaiting);
  } else if (pending) {
    console.log(`⚠ El turno anterior de este hilo quedó a medias (falta: ${status.next.join(", ")}).`);
    console.log('  Escribí "/continuar" para terminarlo. Hasta entonces no se aceptan mensajes nuevos.\n');
  }
} catch (error) {
  console.error(`No se pudo leer el hilo: ${(error as Error).message}`);
  await agent.close();
  process.exit(1);
}

/** `withRoute`: solo un mensaje nuevo pasa por el router; al decidir o continuar, la ruta ya se había mostrado. */
function show(turn: TurnResult, withRoute: boolean) {
  const { summary, route } = turn;
  session = mergeUsage(session, summary.usage);
  if (withRoute && route.intent) console.log(dim(`\n  [ruta] ${route.intent}: ${route.reason ?? "sin motivo"}`));
  for (const call of summary.toolCalls) console.log(dim(`  [herramienta] ${call.name} ${JSON.stringify(call.args)}`));
  // Lo que pasó con la acción lo cuenta el código; el modelo lo comenta después.
  for (const result of summary.actions) console.log(`\n${describeActionResult(result)}`);
  if (turn.reply) console.log(`\nCopiloto: ${turn.reply}\n`);
  console.log(dim(`  [uso] ${describeUsageTotal(summary.usage)} (sesión: ${usd(costOfUsage(session))})`));
  for (const detail of describeUsagePerModel(summary.usage)) console.log(dim(`        ${detail}`));
  console.log("");
}

/**
 * Corre un turno (nuevo, reanudado tras una falla o con una decisión) y deja `pending` y `awaiting` al día,
 * también si falló: el mensaje de la persona ya está guardado, así que se reanuda, no se vuelve a escribir.
 */
async function attempt(run: () => Promise<TurnResult>, withRoute = false) {
  try {
    show(await run(), withRoute);
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
  const status = await getStatus(agent.graph, threadId).catch(() => undefined);
  pending = status?.pending ?? pending;
  awaiting = status ? status.awaiting : awaiting;
  if (awaiting) showCard(awaiting);
  else if (pending) console.error('El turno quedó a medias. Escribí "/continuar" para reintentarlo desde donde se cortó.\n');
}

const decide = (decision: HumanDecision) => attempt(() => resumeTurn(agent, threadId, decision));

// La entrada se abre recién ahora, después de leer el hilo: si se hubiera abierto antes, las líneas
// que llegan mientras se espera a la base (entrada por tubería) se perderían sin oyente.
const rl = createInterface({ input: process.stdin, output: process.stdout });
let closed = false;
rl.on("close", () => (closed = true));

const promptText = () => (editing ? "Parámetros (JSON): " : awaiting ? "¿Aprobás? [s/n/e]: " : "Vos: ");
rl.setPrompt(promptText());
rl.prompt();

// for await encola las líneas y termina solo cuando se cierra la entrada (Ctrl+Z / EOF).
for await (const line of rl) {
  const input = line.trim();
  if (input.toLowerCase() === "salir") break;

  if (editing) {
    // Los parámetros nuevos pasan por las mismas reglas que la propuesta: si no valen, el grafo vuelve a preguntar.
    editing = false;
    if (!input) {
      console.log("Edición cancelada.\n");
      showCard(awaiting!);
    } else {
      try {
        const params = JSON.parse(input) as unknown;
        if (typeof params !== "object" || params === null || Array.isArray(params)) throw new Error("tiene que ser un objeto JSON");
        await decide({ decision: "edit", params: params as Record<string, unknown> });
      } catch (error) {
        if (error instanceof SyntaxError || (error as Error).message.startsWith("tiene que ser")) {
          console.log(`No es un JSON válido (${(error as Error).message}). Probá de nuevo con la opción e.\n`);
          showCard(awaiting!);
        } else throw error;
      }
    }
  } else if (awaiting) {
    const decision = parseDecisionInput(input);
    if (!decision) {
      if (input) console.log("Este hilo espera tu decisión. Respondé s (aprobar), n (rechazar, con motivo opcional) o e (editar).\n");
    } else if (decision.decision === "edit") {
      console.log(`Parámetros actuales: ${JSON.stringify(awaiting.action.params)}`);
      console.log("Escribí los parámetros completos en una línea (JSON), o dejá el renglón vacío para cancelar.");
      editing = true;
    } else await decide(decision);
  } else if (input.toLowerCase() === "/continuar") {
    if (pending) await attempt(() => continueTurn(agent, threadId));
    else console.log("No hay ningún turno a medias en este hilo.\n");
  } else if (input && pending) {
    console.log('Este hilo tiene un turno a medias. Escribí "/continuar" para terminarlo antes de seguir.\n');
  } else if (input) {
    await attempt(() => runTurn(agent, threadId, input), true);
  }

  if (!closed) {
    rl.setPrompt(promptText());
    rl.prompt();
  }
}

rl.close();
if (awaiting) console.log(dim("\nLa acción quedó esperando tu decisión. Para decidir más tarde: npm run chat " + threadId));
else console.log(dim(`\nHilo guardado: npm run chat ${threadId}`));
await agent.close();
