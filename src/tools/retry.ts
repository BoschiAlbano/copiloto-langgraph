// Reintentos de las lecturas de la base (fase 10, R1 y R4). Solo se reintenta lo que puede andar al repetirlo: una
// conexión que se cayó, un servidor que se reinicia, un conflicto de concurrencia. Un dato inválido, un permiso o un bug
// dan lo mismo la segunda vez: se informan enseguida.

/** Códigos de error que valen la pena repetir: de Node (red), de Prisma y de Postgres (SQLSTATE). */
const TRANSIENT_CODES = new Set([
  // Red (Node)
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "EHOSTUNREACH",
  "EAI_AGAIN",
  // Prisma: no se llega al servidor, se vence el tiempo, el servidor cerró la conexión
  "P1001",
  "P1002",
  "P1008",
  "P1017",
  // Postgres: el servidor se reinicia o no acepta conexiones todavía, demasiadas conexiones, conflictos de concurrencia
  "57P01",
  "57P02",
  "57P03",
  "53300",
  "40001",
  "40P01",
]);

/** Mensajes de conexión caída que algunos drivers dan sin código. */
const TRANSIENT_MESSAGE =
  /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EMAXCONN|Connection terminated|connection (?:refused|reset|closed)|server closed the connection|too many (?:clients|connections)|timeout exceeded when trying to connect/i;

/** Los códigos y mensajes de un error y de sus causas (Prisma y el adaptador de pg anidan el error original). */
function* facets(error: unknown, depth = 0): Generator<{ code?: string; message?: string }> {
  if (!error || typeof error !== "object" || depth > 4) return;
  const e = error as { code?: unknown; errno?: unknown; message?: unknown; meta?: { code?: unknown }; cause?: unknown; originalCode?: unknown };
  for (const code of [e.code, e.meta?.code, e.originalCode]) if (typeof code === "string") yield { code };
  if (typeof e.message === "string") yield { message: e.message };
  yield* facets(e.cause, depth + 1);
}

/** ¿Vale la pena repetir esta operación? Ver la lista en la spec (R1). */
export function isTransient(error: unknown): boolean {
  for (const { code, message } of facets(error)) {
    if (code && (TRANSIENT_CODES.has(code) || code.startsWith("08"))) return true;
    if (message && TRANSIENT_MESSAGE.test(message)) return true;
  }
  return false;
}

export interface RetryOptions {
  /** Intentos en total (el primero más los reintentos). */
  attempts?: number;
  /** Espera antes de cada reintento; si hay más reintentos que esperas, se repite la última. */
  delaysMs?: number[];
  /** Variación al azar de cada espera, como fracción (0,25 = ±25 %): que varios pedidos no reintenten a la vez. */
  jitter?: number;
  /** Para los tests: cómo se espera y de dónde sale el azar. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  isRetryable?: (error: unknown) => boolean;
  /** Se llama antes de cada reintento: `attempt` es el número del intento que viene (2, 3…). */
  onRetry?: (info: { attempt: number; attempts: number; delayMs: number; error: unknown }) => void;
}

export const DEFAULT_ATTEMPTS = 3;
export const DEFAULT_DELAYS_MS = [200, 600];

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Corre `fn` y la repite ante una falla transitoria. Si falla el último intento (o la falla no es transitoria), lanza. */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const delays = options.delaysMs ?? DEFAULT_DELAYS_MS;
  const jitter = options.jitter ?? 0.25;
  const sleep = options.sleep ?? realSleep;
  const random = options.random ?? Math.random;
  const retryable = options.isRetryable ?? isTransient;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= attempts || !retryable(error)) throw error;
      const base = delays[Math.min(attempt - 1, delays.length - 1)] ?? 0;
      const delayMs = Math.round(base * (1 + jitter * (2 * random() - 1)));
      options.onRetry?.({ attempt: attempt + 1, attempts, delayMs, error });
      await sleep(delayMs);
    }
  }
}
