import { readFileSync } from "node:fs";
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { ACTION_STUB_MESSAGE, REPORT_STUB_MESSAGE } from "../src/graph/messages.js";
import type { AgentModel } from "../src/graph/nodes/agent.js";
import { makeChatNode } from "../src/graph/nodes/chat.js";
import { makeClarifyNode } from "../src/graph/nodes/clarify.js";
import { actionStubNode, reportStubNode } from "../src/graph/nodes/stubs.js";

function fakeModel(reply: string) {
  const calls: BaseMessage[][] = [];
  const model: AgentModel = {
    async invoke(messages) {
      calls.push(messages);
      return new AIMessage(reply);
    },
  };
  return { model, calls };
}

const state = (messages: BaseMessage[]) => ({ messages, intent: undefined, intentReason: undefined });

describe("nodo chat", () => {
  it("responde con su propio prompt y el historial, y devuelve solo el mensaje nuevo", async () => {
    const { model, calls } = fakeModel("¡Buen día!");
    const update = await makeChatNode(model)(state([new HumanMessage("Hola")]));

    expect(update.messages).toHaveLength(1);
    expect(update.messages[0]!.text).toBe("¡Buen día!");
    expect(calls[0]![0]!.type).toBe("system");
    expect(calls[0]![0]!.text).toContain("charla breve");
    expect(calls[0]![1]!.text).toBe("Hola");
  });

  it("su prompt no promete datos ni cifras", () => {
    const prompt = readFileSync(new URL("../src/graph/prompts/chat.md", import.meta.url), "utf8");
    expect(prompt).toMatch(/No inventes cifras/);
    expect(prompt).not.toContain("{{");
  });
});

describe("nodo clarify", () => {
  it("le pasa la transcripción acotada y devuelve la pregunta", async () => {
    const { model, calls } = fakeModel("¿Qué turno querés cancelar?");
    const update = await makeClarifyNode(model)(
      state([
        new HumanMessage("Cancelá el turno"),
        new AIMessage({ content: "", tool_calls: [{ id: "1", name: "x", args: {}, type: "tool_call" }] }),
        new ToolMessage({ content: "secreto interno de una herramienta", tool_call_id: "1" }),
      ]),
    );

    expect(update.messages[0]!.text).toBe("¿Qué turno querés cancelar?");
    const [system, human] = calls[0]!;
    expect(system!.text).toContain("UNA pregunta de aclaración");
    expect(human!.text).toContain("[persona] Cancelá el turno");
    expect(human!.text).not.toContain("secreto interno");
  });
});

describe("marcadores de acción y reporte", () => {
  it("responden con un mensaje fijo que dice en qué fase llega la función", async () => {
    const action = await actionStubNode();
    const report = await reportStubNode();
    expect(action.messages).toHaveLength(1);
    expect(action.messages[0]!.text).toBe(ACTION_STUB_MESSAGE);
    expect(action.messages[0]!.text).toContain("fase 5");
    expect(report.messages[0]!.text).toBe(REPORT_STUB_MESSAGE);
    expect(report.messages[0]!.text).toContain("fase 6");
  });

  it("no piden herramientas", async () => {
    for (const node of [actionStubNode, reportStubNode]) {
      const [message] = (await node()).messages;
      expect((message as AIMessage).tool_calls ?? []).toEqual([]);
    }
  });
});
