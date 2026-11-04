// Controles de una app local sin usuarios (fase 9, R13). El servidor escucha solo en 127.0.0.1, pero el navegador de
// la persona también visita otras páginas: cualquiera podría intentar mandarle al copiloto «aprobá esa acción». Las
// rutas que cambian algo exigen dos cosas que una página ajena no puede falsificar:
//  - `Content-Type: application/json`, que obliga al navegador a preguntar antes (preflight CORS) y el servidor no
//    contesta ese permiso;
//  - un `Origin` igual al del propio servidor (el navegador lo pone y una página no lo puede cambiar).

/** Tamaño máximo del cuerpo de un pedido (un mensaje de 4.000 caracteres entra holgado). */
export const MAX_BODY_BYTES = 32 * 1024;

export const jsonError = (status: number, message: string) => Response.json({ error: message }, { status });

/**
 * Revisa un pedido que cambia algo. Devuelve la respuesta de error, o `undefined` si pasa.
 * El host propio sale del encabezado `Host` del pedido (el mismo que el navegador usó para llegar).
 */
export function checkMutation(request: Request): Response | undefined {
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^application\/json\b/i.test(contentType)) return jsonError(415, "El pedido tiene que ser JSON (Content-Type: application/json).");

  const origin = request.headers.get("origin");
  const host = request.headers.get("host") ?? new URL(request.url).host;
  let originHost: string | undefined;
  try {
    originHost = origin ? new URL(origin).host : undefined;
  } catch {
    originHost = undefined;
  }
  if (!originHost || originHost !== host) return jsonError(403, "Pedido rechazado: no viene de la página del copiloto.");

  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_BODY_BYTES) return jsonError(413, "El pedido es demasiado grande.");
  return undefined;
}

/** Lee el cuerpo JSON con un tope de tamaño (por si no vino `Content-Length`). */
export async function readJson(request: Request): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return { ok: false, response: jsonError(413, "El pedido es demasiado grande.") };
  try {
    return { ok: true, value: text ? JSON.parse(text) : {} };
  } catch {
    return { ok: false, response: jsonError(400, "El cuerpo del pedido no es un JSON válido.") };
  }
}
