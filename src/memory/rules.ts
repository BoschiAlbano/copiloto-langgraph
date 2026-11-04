// Qué se guarda en la memoria de largo plazo y qué no (fase 8, R6 a R9). El modelo propone el texto; estas reglas las
// aplica el código ANTES de escribir en el Store. Si una no pasa, no se guarda nada y la persona ve el motivo.

/** Máximo de memorias guardadas en total. */
export const MAX_MEMORIES = 30;
/** Máximo de caracteres por memoria. */
export const MAX_MEMORY_CHARS = 200;

export type MemoryCheck = { ok: true; text: string } | { ok: false; reason: string };

/** Para comparar textos sin que importen mayúsculas, acentos, signos ni espacios. */
export const normalizeForCompare = (text: string) =>
  text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9ñ ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const EMAIL = /[^\s@]+@[^\s@]+\.[a-z]{2,}/i;
/** Siete dígitos o más, aunque estén separados por espacios, guiones o puntos: teléfonos, documentos, CUIT. */
const LONG_NUMBER = /\d(?:[\s.\-]?\d){6,}/;
const DOCUMENT = /\b(dni|cuit|cuil|pasaporte|documento)\b/i;
/** Montos de dinero: «$ 8.000», «8000 pesos». Los precios y las ventas están en la base y cambian. */
const MONEY = /\$\s*\d|\d[\d.,]*\s*(pesos|ars)\b/i;
/** Cantidades de stock: «el stock de cera es 20», «quedan 12 geles». */
const STOCK_FIGURE = /\b(stock|quedan|hay)\b[^.]*\d/i;
/**
 * Un ejemplo marcado como tal: «(por ejemplo: cera mate 30 U/S)», «ejemplo: …». Va hasta el paréntesis que lo cierra o
 * hasta el final del texto. Sus números ilustran un formato, no son cifras del negocio. Solo lo ignora el control de
 * cifras (que existe porque una cifra guardada envejece); los de clientes, datos personales, credenciales y seguridad
 * miran todo el texto, ejemplos incluidos.
 */
const EXAMPLE = /\(?\b(?:por ejemplo|p\.\s?ej\.?|ejemplo)\s*:?[^)]*\)?/gi;

/** El texto sin sus ejemplos marcados, para el control de cifras. */
export const withoutExamples = (text: string) => text.replace(EXAMPLE, " ");
const CREDENTIALS = /\b(contrase[nñ]a|password|clave|token|api[\s_-]?key|secreto)\b|[a-z]+:\/\/\S+/i;
/**
 * Lo que intenta cambiar cómo funciona el copiloto: las aprobaciones, los permisos o sus instrucciones. Aunque se
 * guardara no cambiaría nada (las garantías están en el código), pero no se guarda para no sembrar confusión.
 */
const SECURITY = /\b(aprob\w*|confirmaci\w*|permis\w*|rol(es)?|instrucci\w*|prompt|sistema)\b/i;

export interface CheckOptions {
  /** Nombres completos de los clientes del negocio (de la base, con el rol de lectura). */
  clientNames?: string[];
  /** Los textos de las memorias que ya existen. */
  existing?: string[];
}

/**
 * Decide si un texto se puede guardar como memoria (R6 a R9). Devuelve el texto limpio (espacios de más fuera) o el
 * motivo por el que no se guarda, en palabras de la persona.
 */
export function checkMemory(raw: string, { clientNames = [], existing = [] }: CheckOptions = {}): MemoryCheck {
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text) return { ok: false, reason: "no hay nada que anotar." };
  if (text.length > MAX_MEMORY_CHARS) return { ok: false, reason: `es demasiado largo (el máximo es ${MAX_MEMORY_CHARS} caracteres): probá con una frase más corta.` };

  if (EMAIL.test(text) || LONG_NUMBER.test(text) || DOCUMENT.test(text)) {
    return { ok: false, reason: "tiene datos personales (un email, un teléfono o un documento). Esos datos no se guardan en la memoria." };
  }
  const normalized = normalizeForCompare(text);
  const client = clientNames.find((name) => {
    const n = normalizeForCompare(name);
    return n.includes(" ") && ` ${normalized} `.includes(` ${n} `);
  });
  if (client) {
    return { ok: false, reason: `habla de un cliente (${client}). Los datos de clientes no se guardan en la memoria; si hace falta, van en las notas del cliente.` };
  }
  const figures = withoutExamples(text);
  if (MONEY.test(figures) || STOCK_FIGURE.test(figures)) {
    return { ok: false, reason: "tiene cifras del negocio (precios, montos o stock), que cambian: esas se consultan siempre en la base." };
  }
  if (CREDENTIALS.test(text)) return { ok: false, reason: "parece tener una credencial o una dirección de conexión. Eso no se guarda." };
  if (SECURITY.test(text)) {
    return { ok: false, reason: "habla de aprobaciones, permisos o instrucciones del copiloto. Eso no se cambia con una memoria: las acciones siempre se aprueban." };
  }

  if (existing.some((e) => normalizeForCompare(e) === normalized)) return { ok: false, reason: "ya estaba anotada." };
  if (existing.length >= MAX_MEMORIES) return { ok: false, reason: `ya hay ${MAX_MEMORIES} memorias, el máximo. Borrá alguna antes de anotar otra.` };
  return { ok: true, text };
}
