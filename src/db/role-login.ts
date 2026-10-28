import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";

/**
 * Deja a un rol listo para entrar por el pooler con la contraseña que está en su URL,
 * así el secreto vive solo en .env. Se conecta con el dueño (adminUrl).
 * Devuelve "ready" si ya estaba listo y "configured" si hubo que asignarle la contraseña.
 */
export async function ensureRoleLogin(opts: { adminUrl: string; roleUrl: string; expectedRole: string }) {
  const { adminUrl, roleUrl, expectedRole } = opts;

  // El usuario del pooler es "<rol>.<tenant>": el rol es lo que va antes del primer punto.
  const parsed = new URL(roleUrl);
  const roleName = decodeURIComponent(parsed.username).split(".")[0]!;
  const password = decodeURIComponent(parsed.password);
  if (roleName !== expectedRole || !password) {
    throw new Error(`La URL del rol debe usar el usuario ${expectedRole}.<tenant> y tener contraseña.`);
  }

  /** ¿Puede el rol entrar por el pooler con la contraseña de .env? */
  async function canLogin() {
    const client = new pg.Client({ connectionString: roleUrl });
    try {
      await client.connect();
      await client.query("SELECT 1");
      return true;
    } catch {
      return false;
    } finally {
      await client.end().catch(() => {});
    }
  }

  // El pooler puede aceptar una conexión con credenciales en caché aunque el rol ya no pueda entrar: se mira también la base.
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  const hasLogin = await admin
    .query("SELECT rolcanlogin FROM pg_roles WHERE rolname = $1", [roleName])
    .then(({ rows }) => rows[0]?.rolcanlogin === true)
    .finally(() => admin.end());

  // ALTER ROLE ... PASSWORD regenera el secreto del rol y el pooler guarda credenciales en caché:
  // durante unos instantes algunas conexiones nuevas fallan. Por eso solo se toca si hace falta.
  if (hasLogin && (await canLogin())) return { roleName, status: "ready" as const };

  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(
      `ALTER ROLE ${client.escapeIdentifier(roleName)} LOGIN PASSWORD ${client.escapeLiteral(password)}`,
    );
  } finally {
    await client.end();
  }

  // Esperar a que el pooler acepte las credenciales nuevas.
  for (let attempt = 0; attempt < 15; attempt++) {
    if (await canLogin()) return { roleName, status: "configured" as const };
    await sleep(1000);
  }
  throw new Error(`El rol ${roleName} se configuró, pero el pooler todavía no acepta la contraseña.`);
}
