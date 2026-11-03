import { AIMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { interrupt } from "@langchain/langgraph";
import type { ExecuteInput, ExecutionOutcome } from "../../tools/actions/execute.js";
import { describeZodError } from "../../tools/actions/rules.js";
import { isActionName, type ActionName, type PreparedAction } from "../../tools/actions/schemas.js";
import { ToolUserError } from "../../tools/safe.js";
import {
  humanDecisionSchema,
  type Approval,
  type ApprovalRequest,
  type PendingAction,
} from "../approval.js";
/** Lo que leen los nodos de la aprobación: el historial y la propuesta y la decisión (privadas del subgrafo de acciones). */
interface ActionNodeState {
  messages: BaseMessage[];
  pendingAction?: PendingAction | null;
  approval?: Approval | null;
}

// Los tres nodos del flujo de aprobación. Se separan por una razón de LangGraph: cuando un nodo con
// `interrupt` se reanuda, se vuelve a ejecutar DESDE EL PRINCIPIO. Por eso:
//   propose_action  puro, sin efectos: valida y arma la propuesta
//   approval        solo pregunta (interrupt) y valida la respuesta: repetirlo es inocuo
//   execute_action  el único que escribe, y solo con una decisión guardada en el estado

/** Lo que los nodos necesitan para trabajar con las acciones; en producción lo arma `makeActionRunner`. */
export interface ActionRunner {
  /** Valida y normaliza (solo lee). Lanza ToolUserError si no se puede. */
  prepare(tool: ActionName, params: unknown, now: Date): Promise<PreparedAction>;
  /** Aplica la decisión (escribe). Solo lo llama `execute_action`. */
  execute(input: ExecuteInput, now: Date): Promise<ExecutionOutcome>;
}

const lastAiMessage = (messages: BaseMessage[]) => {
  const last = messages.at(-1);
  return last && AIMessage.isInstance(last) ? last : undefined;
};

const threadIdOf = (config?: RunnableConfig) => {
  const id = config?.configurable?.thread_id;
  if (typeof id !== "string" || !id) throw new Error("Las acciones necesitan un hilo (thread_id) para poder pausar y reanudar.");
  return id;
};

const errorMessage = (callId: string | undefined, name: string, content: string) =>
  new ToolMessage({ content, tool_call_id: callId ?? "sin-id", name, status: "error" });

/** El mensaje que el modelo ve cuando pidió más de una cosa a la vez. */
export const ONE_ACTION_ONLY =
  "Proponé UNA sola acción por mensaje y sin otras llamadas en el mismo mensaje. Pedí primero lo que necesites " +
  "consultar o la acción más importante, y después seguimos con lo demás. No se propuso ni se hizo nada.";

interface ProposeUpdate {
  messages?: ToolMessage[];
  pendingAction: PendingAction | null;
  approval: null;
}

export function makeProposeActionNode(runner: Pick<ActionRunner, "prepare">, options: { now?: () => Date } = {}) {
  const now = options.now ?? (() => new Date());
  return async (state: ActionNodeState, config?: RunnableConfig): Promise<ProposeUpdate> => {
    const last = lastAiMessage(state.messages);
    const calls = last?.tool_calls ?? [];
    const cleared = { pendingAction: null, approval: null };

    // Una acción por vez, sin mezclar con consultas: si no, todas las llamadas reciben el error (el historial
    // tiene que quedar válido: cada llamada necesita su respuesta).
    if (calls.length !== 1) {
      return { messages: calls.map((c) => errorMessage(c.id, c.name, ONE_ACTION_ONLY)), ...cleared };
    }
    const call = calls[0]!;
    if (!isActionName(call.name)) {
      // No debería pasar (la arista solo manda acá acciones), pero no se confía en eso.
      return { messages: [errorMessage(call.id, call.name, `${call.name} no es una acción.`)], ...cleared };
    }
    const threadId = threadIdOf(config);

    let prepared: PreparedAction;
    try {
      prepared = await runner.prepare(call.name, call.args, now());
    } catch (error) {
      if (!(error instanceof ToolUserError)) throw error;
      return { messages: [errorMessage(call.id, call.name, `${error.message} No se propuso ni se hizo nada.`)], ...cleared };
    }
    const pendingAction: PendingAction = {
      id: `${threadId}:${call.id ?? "sin-id"}`,
      toolCallId: call.id ?? "sin-id",
      tool: prepared.tool,
      params: prepared.params,
      risk: prepared.risk,
      summary: prepared.summary,
    };
    return { pendingAction, approval: null };
  };
}

export function makeApprovalNode(runner: Pick<ActionRunner, "prepare">, options: { now?: () => Date } = {}) {
  const now = options.now ?? (() => new Date());
  return async (state: ActionNodeState): Promise<{ approval: Approval; pendingAction?: PendingAction }> => {
    const action = state.pendingAction;
    if (!action) throw new Error("approval necesita una acción propuesta.");

    // La ejecución se PAUSA acá. Lo que se pasa a interrupt es lo que recibe quien invoca el grafo.
    const request: ApprovalRequest = {
      kind: "approve_action",
      action,
      ...(state.approval?.decision === "invalid" && state.approval.error ? { error: state.approval.error } : {}),
      ...(state.approval?.decision === "revised" ? { edited: true as const } : {}),
    };
    const answer: unknown = interrupt(request);

    const parsed = humanDecisionSchema.safeParse(answer);
    if (!parsed.success) {
      return { approval: { actionId: action.id, decision: "invalid", error: `Decisión inválida: ${describeZodError(parsed.error)}.` } };
    }
    const decision = parsed.data;
    switch (decision.decision) {
      case "approve":
        return { approval: { actionId: action.id, decision: "approved" } };
      case "reject":
        return { approval: { actionId: action.id, decision: "rejected", ...(decision.comment && { comment: decision.comment }) } };
      case "edit":
        try {
          // La edición pasa por las mismas reglas que la propuesta original. NO se ejecuta: reemplaza a la propuesta
          // (con su resumen y riesgo recalculados) y el grafo vuelve a preguntar. Los parámetros que propuso el
          // modelo se guardan una sola vez, para la auditoría.
          const edited = await runner.prepare(action.tool, decision.params, now());
          return {
            pendingAction: {
              ...action,
              params: edited.params,
              risk: edited.risk,
              summary: edited.summary,
              originalParams: action.originalParams ?? action.params,
            },
            approval: { actionId: action.id, decision: "revised" },
          };
        } catch (error) {
          if (!(error instanceof ToolUserError)) throw error;
          return { approval: { actionId: action.id, decision: "invalid", error: `Edición rechazada: ${error.message}` } };
        }
    }
  };
}

/** Se lanza cuando se intenta ejecutar sin una aprobación vigente para esa acción. */
export class ApprovalRequiredError extends Error {
  constructor(reason: string) {
    super(`No se ejecuta: ${reason}`);
    this.name = "ApprovalRequiredError";
  }
}

export function makeExecuteActionNode(runner: Pick<ActionRunner, "execute">, options: { now?: () => Date } = {}) {
  const now = options.now ?? (() => new Date());
  return async (state: ActionNodeState, config?: RunnableConfig) => {
    const { pendingAction: action, approval } = state;
    // Barrera de último momento: sin una decisión válida sobre ESTA acción no se llama a la base.
    if (!action) throw new ApprovalRequiredError("no hay ninguna acción propuesta.");
    if (!approval) throw new ApprovalRequiredError("la acción no tiene una decisión de la persona.");
    if (approval.actionId !== action.id) throw new ApprovalRequiredError("la decisión es de otra acción.");
    // Solo una aprobación o un rechazo cierran la propuesta. Una edición (`revised`) o una respuesta inválida no.
    if (approval.decision !== "approved" && approval.decision !== "rejected") {
      throw new ApprovalRequiredError(approval.decision === "revised" ? "la propuesta se editó y falta aprobarla." : "la decisión no es válida.");
    }

    // Si la persona editó, se ejecuta lo editado (`action.params`) y la auditoría conserva lo que propuso el modelo.
    const edited = action.originalParams !== undefined;
    const outcome = await runner.execute(
      {
        threadId: threadIdOf(config),
        actionId: action.id,
        tool: action.tool,
        proposed: action.originalParams ?? action.params,
        params: action.params,
        summary: action.summary,
        risk: action.risk,
        decision: approval.decision === "rejected" ? "rejected" : edited ? "edited" : "approved",
        ...(approval.comment && { comment: approval.comment }),
      },
      now(),
    );

    // Respuesta a la llamada del modelo: así el historial queda válido y el modelo puede contestar.
    return {
      messages: [
        new ToolMessage({
          content: outcome.message,
          tool_call_id: action.toolCallId,
          name: action.tool,
          status: outcome.status === "failed" ? "error" : "success",
        }),
      ],
      pendingAction: null,
      approval: null,
    };
  };
}
