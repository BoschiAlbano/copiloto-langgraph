import { ChatAnthropic } from "@langchain/anthropic";
import type { Env } from "../config/env.js";
import { routerOutputSchema } from "./intents.js";
import { planOutputSchema } from "./report/plan.js";

// Sin `temperature`: Haiku 5.5 rechaza ese parámetro ("deprecated for this model").
export const claude = (env: Env, model: string) => new ChatAnthropic({ model, apiKey: env.ANTHROPIC_API_KEY });

/** Router: modelo barato con salida estructurada. `includeRaw` deja `parsed` en null si la salida es inválida. */
export const makeRouterModel = (env: Env) =>
  claude(env, env.MODEL_ROUTER).withStructuredOutput(routerOutputSchema, { name: "route", includeRaw: true });

/** Modelo de la rama de aclaración: el mismo modelo barato del router, sin herramientas. */
export const makeClarifyModel = (env: Env) => claude(env, env.MODEL_ROUTER);

/** Planificador de reportes: modelo barato con salida estructurada que elige el período (las fechas las calcula el código). */
export const makeReportPlanModel = (env: Env) =>
  claude(env, env.MODEL_ROUTER).withStructuredOutput(planOutputSchema, { name: "report_period", includeRaw: true });

/** Escribe la «Lectura» de un reporte (sin herramientas). Las cifras del reporte las arma el código. */
export const makeReportModel = (env: Env) => claude(env, env.MODEL_REPORT);
