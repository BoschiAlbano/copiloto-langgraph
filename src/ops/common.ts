import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

// Lo que comparten los comandos de operación (fase 12): correr otros comandos, saber si la base es la del
// docker-compose.yml del repositorio y esperar a que esté lista.

/** El contenedor y el puerto de la base propia (docker-compose.yml). */
export const BUNDLED_CONTAINER = "copiloto-db";
export const BUNDLED_PORT = 54329;

/** Corre un comando con la salida a la vista. Devuelve true si terminó bien. */
export function run(command: string, args: string[], options: SpawnSyncOptions = {}): boolean {
  const result = spawnSync(command, args, { stdio: "inherit", shell: process.platform === "win32", ...options });
  return result.status === 0;
}

/** Corre un comando sin mostrar nada y devuelve su salida (o undefined si falló). */
export function capture(command: string, args: string[]): string | undefined {
  const result = spawnSync(command, args, { encoding: "utf8", shell: process.platform === "win32" });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

/** ¿La URL apunta a la base propia (localhost:54329)? Si no, es otra base (por ejemplo, un Supabase): no se toca. */
export function isBundledDb(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(u.hostname) && Number(u.port) === BUNDLED_PORT;
  } catch {
    return false;
  }
}

export const hasDocker = () => capture("docker", ["version", "--format", "{{.Server.Version}}"]) !== undefined;

export function nodeMajor(): number {
  return Number(process.versions.node.split(".")[0]);
}

/** Levanta la base propia y espera a que su healthcheck diga que está lista. */
export async function startBundledDb(timeoutMs = 90_000): Promise<void> {
  if (!run("docker", ["compose", "up", "-d", "db"])) throw new Error("No se pudo levantar la base con `docker compose up -d db`.");
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (capture("docker", ["inspect", "-f", "{{.State.Health.Status}}", BUNDLED_CONTAINER]) === "healthy") return;
    await sleep(1000);
  }
  throw new Error(`La base (${BUNDLED_CONTAINER}) no quedó lista en ${timeoutMs / 1000} s. Mirá \`docker compose logs db\`.`);
}

/** Corta el proceso con un mensaje claro (sin el detalle de la pila). */
export function fail(message: string): never {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

export const hasEnvFile = () => existsSync(".env");
