/**
 * Un turno en curso por hilo (fase 9, R9). Dos pestañas, o un doble clic en «Aprobar», no pueden correr dos turnos a
 * la vez sobre el mismo hilo: el segundo recibe 409. Vive en memoria: la app web es un solo proceso local. (La acción
 * igual se ejecutaría una sola vez —la clave de la fase 5—, pero así ni siquiera se intenta.)
 */
export class ThreadLocks {
  private readonly running = new Set<string>();

  /** Toma el hilo. Devuelve la función que lo suelta, o `undefined` si ya tenía un turno en curso. */
  acquire(threadId: string): (() => void) | undefined {
    if (this.running.has(threadId)) return undefined;
    this.running.add(threadId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.running.delete(threadId);
    };
  }

  isRunning(threadId: string): boolean {
    return this.running.has(threadId);
  }
}
