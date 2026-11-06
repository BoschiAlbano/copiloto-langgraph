// Al arrancar el servidor de la web (fase 12, R4): si falta una variable de entorno o es inválida, no arranca y dice
// cuál, en vez de fallar recién en el primer pedido. Lo de Node va en su propio archivo: Next compila este también para
// el entorno «edge», que no tiene node:fs, y así descarta esa rama al compilar.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") await import("./instrumentation-node")
}
