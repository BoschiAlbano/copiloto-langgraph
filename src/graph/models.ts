import { ChatAnthropic } from "@langchain/anthropic";
import type { Env } from "../config/env.js";
import { routerOutputSchema } from "./intents.js";
import { memoryOutputSchema } from "./nodes/memory.js";
import { planOutputSchema } from "./report/plan.js";

// Sin `temperature`: Haiku 5.5 rechaza ese parámetro ("deprecated for this model").
export const claude = (env: Env, model: string) => new ChatAnthropic({ model, apiKey: env.ANTHROPIC_API_KEY });

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
