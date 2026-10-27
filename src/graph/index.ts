import { END, START, StateGraph } from "@langchain/langgraph";
import { makeChatNode, type ChatModel } from "./nodes/chat.js";
import { AgentState } from "./state.js";

/** START → chat → END */
export function buildGraph(model: ChatModel) {
  return new StateGraph(AgentState)
    .addNode("chat", makeChatNode(model))
    .addEdge(START, "chat")
    .addEdge("chat", END)
    .compile();
}
