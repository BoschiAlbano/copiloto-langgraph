import type { UiEvent } from "./events.js";

// Server-Sent Events: un evento por bloque `data: <json>\n\n`. El tipo viaja dentro del JSON (`type`), así el
// navegador lee todo con un solo lector.

const encoder = new TextEncoder();

export const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  // Que ningún intermediario junte los eventos antes de mandarlos.
  "X-Accel-Buffering": "no",
} as const;

export const encodeEvent = (event: UiEvent) => encoder.encode(`data: ${JSON.stringify(event)}\n\n`);

/**
 * Convierte los eventos de un turno en una respuesta SSE. `onCancel` se llama si el navegador corta la conexión
 * (recarga o cierra la pestaña): quien llama lo usa para cortar el turno. `onClose` se llama siempre al terminar.
 */
export function sseResponse(events: AsyncIterator<UiEvent>, { onCancel, onClose }: { onCancel?: () => void; onClose?: () => void } = {}): Response {
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    onClose?.();
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await events.next();
        if (next.done) {
          controller.close();
          close();
        } else controller.enqueue(encodeEvent(next.value));
      } catch (error) {
        // `events` ya convierte las fallas en un evento `error`: esto es solo por si algo se escapa.
        controller.error(error);
        close();
      }
    },
    async cancel() {
      onCancel?.();
      await events.return?.(undefined);
      close();
    },
  });
  return new Response(body, { headers: SSE_HEADERS });
}

/** Lee un cuerpo SSE y devuelve sus eventos (para los tests y para el navegador). */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<UiEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = block
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data) yield JSON.parse(data) as UiEvent;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
