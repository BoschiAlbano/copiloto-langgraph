import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";

export const ROUTER_MAX_MESSAGES = 6;
export const ROUTER_MAX_CHARS = 500;

export interface RouterTurn {
  role: "persona" | "copiloto";
  text: string;
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * Contexto que ve el router: los últimos mensajes de la persona o de la IA que tengan texto
 * (el nuevo incluido), recortados. Nunca pasan mensajes de herramientas ni de sistema, que son
 * largos, no ayudan a clasificar y son la vía por la que entraría texto de terceros.
 */
export function buildRouterContext(
  messages: BaseMessage[],
  { maxMessages = ROUTER_MAX_MESSAGES, maxChars = ROUTER_MAX_CHARS } = {},
): RouterTurn[] {
  const turns: RouterTurn[] = [];
  for (const message of messages) {
    const text = message.text.trim();
    if (!text) continue;
    if (HumanMessage.isInstance(message)) turns.push({ role: "persona", text: clip(text, maxChars) });
    else if (AIMessage.isInstance(message)) turns.push({ role: "copiloto", text: clip(text, maxChars) });
  }
  return turns.slice(-maxMessages);
}

/**
 * La conversación se le muestra al router como una transcripción dentro de un solo mensaje,
 * no como mensajes con roles: es material para clasificar, no una charla que continuar.
 * Eso evita además las reglas de alternancia de roles de la API.
 */
export function formatTranscript(turns: RouterTurn[]): string {
  return turns.map((t) => `[${t.role}] ${t.text}`).join("\n");
}
