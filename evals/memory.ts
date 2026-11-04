import { randomBytes } from "node:crypto";
import type { Agent } from "../src/graph/create-agent.js";
import { runTurn, type TurnResult } from "../src/graph/run-turn.js";
import { deleteThread } from "../src/graph/threads.js";
import { clearMemories, listMemories, saveMemory, type MemoryBank } from "../src/memory/store.js";
import { applyCases, MEMORY_CASES, type ApplyCase, type MemoryCase, type SeedMemory } from "./memory-cases.js";

// Evalúa la memoria de largo plazo con el modelo real (fase 8). Corre el copiloto completo, con un namespace de
// memoria PROPIO (nunca toca las memorias del negocio): G1 a G8 miran el plan y lo que quedó en el Store; A1 a A4,
// lo que hace el copiloto en un hilo nuevo con memorias ya cargadas. Las acciones solo se proponen: nunca se aprueban,
// y los hilos se borran al terminar.

/** Un namespace nuevo para una corrida de evaluación. */
export const evalNamespace = () => ["test", `eval-memoria-${randomBytes(4).toString("hex")}`];

type EvalAgent = Pick<Agent, "graph" | "checkpointer" | "memory">;

async function seed(bank: MemoryBank, memories: SeedMemory[]) {
  await clearMemories(bank);
  const ids = new Map<string, string>();
  let t = Date.now();
  for (const m of memories) ids.set(m.ref, (await saveMemory(bank, { kind: m.kind, text: m.text }, new Date(t++))).id);
  return ids;
}

async function turnInNewThread(agent: EvalAgent, message: string): Promise<TurnResult> {
  const id = `test-memoria-${randomBytes(4).toString("hex")}`;
  try {
    return await runTurn(agent, id, message);
  } finally {
    await deleteThread(agent.checkpointer, id);
  }
}

export interface MemoryCaseResult {
  case: MemoryCase;
  ok: boolean;
  plan: string[];
  /** Lo que quedó en el Store al final: tipo y texto. */
  after: string[];
  reply: string;
  problem?: string;
}

export async function evaluateMemoryCases(agent: EvalAgent, cases: MemoryCase[] = MEMORY_CASES): Promise<MemoryCaseResult[]> {
  const bank = agent.memory;
  const results: MemoryCaseResult[] = [];
  for (const c of cases) {
    const ids = await seed(bank, c.before);
    const turn = await turnInNewThread(agent, c.message);
    const after = await listMemories(bank);
    const plan = (turn.route.tasks ?? []).map((t) => t.intent);

    const problems: string[] = [];
    if (plan.join(",") !== c.expected.plan.join(",")) problems.push(`plan ${plan.join(" → ")} en vez de ${c.expected.plan.join(" → ")}`);
    const seededIds = new Set(ids.values());
    const added = after.filter((m) => !seededIds.has(m.id));
    if (c.expected.saved && (added.length !== 1 || added[0]!.kind !== c.expected.saved)) {
      problems.push(`se esperaba guardar una ${c.expected.saved} y se guardaron ${added.length} (${added.map((m) => m.kind).join(", ") || "ninguna"})`);
    }
    if (!c.expected.saved && added.length) problems.push(`no tenía que guardar nada y guardó: ${added.map((m) => m.text).join(" | ")}`);
    for (const [ref, id] of ids) {
      const present = after.some((m) => m.id === id);
      if (present !== c.expected.kept.includes(ref)) problems.push(`la memoria «${ref}» ${present ? "sigue" : "se borró"} y no tenía que`);
    }
    results.push({
      case: c,
      ok: problems.length === 0,
      plan,
      after: after.map((m) => `${m.kind}: ${m.text}`),
      reply: turn.reply,
      ...(problems.length && { problem: problems.join("; ") }),
    });
  }
  await clearMemories(bank);
  return results;
}

export interface ApplyCaseResult {
  case: ApplyCase;
  ok: boolean;
  observed: string;
  problem?: string;
}

export async function evaluateApplyCases(agent: EvalAgent, cases: ApplyCase[] = applyCases()): Promise<ApplyCaseResult[]> {
  const bank = agent.memory;
  const results: ApplyCaseResult[] = [];
  for (const c of cases) {
    await seed(bank, c.memories);
    const turn = await turnInNewThread(agent, c.message);
    const proposal = turn.awaiting?.action;
    const observed = proposal ? `propuso ${proposal.tool} ${JSON.stringify(proposal.params)}` : `respondió: ${turn.reply.replace(/\s+/g, " ").slice(0, 220)}`;
    let problem: string | undefined;
    const e = c.expected;
    if (e.kind === "no_proposal") {
      if (proposal) problem = "propuso la acción aunque una regla lo impide";
      else if (!e.mentions.test(turn.reply)) problem = `la respuesta no menciona la regla (${e.mentions})`;
    } else if (e.kind === "propose") {
      if (proposal?.tool !== e.tool) problem = `no propuso ${e.tool}`;
      else if (proposal.params.date !== e.date) problem = `propuso otra fecha: ${String(proposal.params.date)} (se esperaba ${e.date})`;
    } else {
      if (!e.includes.test(turn.reply)) problem = `la respuesta no cumple ${e.includes}`;
      else if (e.excludes.test(turn.reply)) problem = `la respuesta tiene ${e.excludes}`;
    }
    results.push({ case: c, ok: problem === undefined, observed, ...(problem && { problem }) });
  }
  await clearMemories(bank);
  return results;
}

export interface MemoryCriteria {
  hits: number;
  total: number;
  criticalPass: boolean;
  applyPass: boolean;
  pass: boolean;
}

/** CA5: G1 a G8, al menos 7 de 8, y G1, G5 y G7 nunca fallan. CA1 y CA3: A1 a A4 se cumplen todos. */
export function checkMemoryCriteria(memory: MemoryCaseResult[], apply: ApplyCaseResult[]): MemoryCriteria {
  const hits = memory.filter((r) => r.ok).length;
  const criticalPass = memory.filter((r) => r.case.critical).every((r) => r.ok);
  const applyPass = apply.every((r) => r.ok);
  return { hits, total: memory.length, criticalPass, applyPass, pass: hits >= 7 && criticalPass && applyPass };
}

export function formatMemoryReport(memory: MemoryCaseResult[], apply: ApplyCaseResult[]): string {
  const lines = ["Memoria con el modelo real (namespace propio de evaluación):", "", "Guardar, listar y borrar:"];
  for (const r of memory) {
    lines.push(`${r.ok ? "✔" : "✖"} ${r.case.id}${r.case.critical ? " (crítico)" : ""}  ${r.case.message}`);
    lines.push(`     plan: ${r.plan.join(" → ") || "—"} · al final: ${r.after.join(" | ") || "(vacía)"}`);
    lines.push(`     respuesta: ${r.reply.replace(/\s+/g, " ").slice(0, 200)}`);
    if (r.problem) lines.push(`     PROBLEMA: ${r.problem}`);
  }
  lines.push("", "Aplicar en un hilo nuevo:");
  for (const r of apply) {
    lines.push(`${r.ok ? "✔" : "✖"} ${r.case.id}  [${r.case.memories.map((m) => m.text).join(" | ") || "sin memorias"}]  ${r.case.message}`);
    lines.push(`     ${r.observed}`);
    if (r.problem) lines.push(`     PROBLEMA: ${r.problem}`);
  }
  const c = checkMemoryCriteria(memory, apply);
  lines.push(
    "",
    `G: ${c.hits}/${c.total} · críticos (G1, G5 y G7): ${c.criticalPass ? "bien" : "FALLÓ"} · A: ${apply.filter((r) => r.ok).length}/${apply.length} · ${c.pass ? "CUMPLE" : "NO CUMPLE"}`,
  );
  return lines.join("\n");
}
