import { ChatAnthropic } from "@langchain/anthropic";
import type { Env } from "../config/env.js";
import { routerOutputSchema } from "./intents.js";
import { memoryOutputSchema } from "./nodes/memory.js";
import { planOutputSchema } from "./report/plan.js";

// Sin `temperature`: Haiku 5.5 rechaza ese parámetro ("deprecated for this model").
// maxRetries (fase 10): las llamadas al modelo las reintenta LangChain (AsyncCaller), no el SDK de Anthropic (que se crea
// con 0). Reintenta todo salvo los errores 4xx que no cambian al repetir (400, 401, 403, 404…): la sobrecarga (529), los
// 5xx, el 429 y la red. Por defecto son 6 reintentos con espera creciente (casi un minuto antes de informar un error);
// se bajan a 3. Los reintentos de la base van aparte (src/tools/retry.ts).
export const CLAUDE_MAX_RETRIES = 3;
// timeout (fase 12): el SDK espera hasta 10 minutos por defecto. Una llamada que no responde en MODEL_TIMEOUT_MS se corta
// y LangChain la reintenta como un error de red; el turno entero tiene su propio límite (TURN_TIMEOUT_MS).
export const claude = (env: Env, model: string) =>
  new ChatAnthropic({ model, apiKey: env.ANTHROPIC_API_KEY, maxRetries: CLAUDE_MAX_RETRIES, clientOptions: { timeout: env.MODEL_TIMEOUT_MS } });

/**
 * Para los modelos de salida estructurada (router, memoria, período del reporte): Claude contesta todo junto aunque
 * alguien esté escuchando los tokens. Con el chat web (fase 9), el grafo corre con el modo `messages`, que le pide a
 * cada modelo que transmita; transmitida, la salida estructurada llegaba sin parsear (`parsed` en null) y el router
 * caía siempre a su respaldo (el parser lee los bloques de contenido, que transmitidos traen `input` vacío). Su salida no es texto para la persona: no hay nada que mostrar en vivo.
 */
export function claudeWhole(env: Env, model: string) {
  const chat = claude(env, model);
  // Se asigna después de crearlo: el constructor de @langchain/core 1.3.0 declara la opción pero no la toma.
  chat.disableStreaming = true;
  return chat;
}

/** Router: modelo barato con salida estructurada. `includeRaw` deja `parsed` en null si la salida es inválida. */
export const makeRouterModel = (env: Env) =>
  claudeWhole(env, env.MODEL_ROUTER).withStructuredOutput(routerOutputSchema, { name: "route", includeRaw: true });

/** Modelo de la rama de aclaración: el mismo modelo barato del router, sin herramientas. */
export const makeClarifyModel = (env: Env) => claude(env, env.MODEL_ROUTER);

/** Planificador de reportes: modelo barato con salida estructurada que elige el período (las fechas las calcula el código). */
export const makeReportPlanModel = (env: Env) =>
  claudeWhole(env, env.MODEL_ROUTER).withStructuredOutput(planOutputSchema, { name: "report_period", includeRaw: true });

/** Memoria (fase 8): modelo barato con salida estructurada que decide guardar, listar o borrar. El resto lo hace el código. */
export const makeMemoryModel = (env: Env) =>
  claudeWhole(env, env.MODEL_ROUTER).withStructuredOutput(memoryOutputSchema, { name: "memory", includeRaw: true });

/** Escribe la «Lectura» de un reporte (sin herramientas). Las cifras del reporte las arma el código. */
export const makeReportModel = (env: Env) => claude(env, env.MODEL_REPORT);
