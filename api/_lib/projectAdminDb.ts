// Direct Postgres access as the project_admin role, for server-side code
// that needs to call project_admin-gated RPCs (confirm_ticket_payment,
// finalize_pending_purchase, etc.) — those functions have no EXECUTE grant
// for anon/authenticated/service_role, by design (mirrors InsForge's own
// narrower admin-key boundary), and project_admin itself has no meaningful
// path through PostgREST on this project (see the JWT-signing-key
// investigation this replaced). project_admin does have LOGIN now (see
// supabase/migrations/0021_project_admin_login.sql), scoped to exactly
// this: a direct connection for privileged backend RPC calls, never used
// client-side (PROJECT_ADMIN_DATABASE_URL is not VITE_-prefixed, so Vite
// never bundles it into browser code, and nothing under src/ references
// this module or that env var).
//
// A module-level singleton Pool is reused across warm Vercel invocations
// (each cold start creates its own); max: 1 keeps this within the Session
// Pooler's per-connection model since these are low-frequency webhook
// calls, not a request-serving pool.
import { Pool } from 'pg';

let pool: Pool | null = null;

function getPool(): Pool {
  if (pool) return pool;
  const connectionString = process.env.PROJECT_ADMIN_DATABASE_URL;
  if (!connectionString) throw new Error('PROJECT_ADMIN_DATABASE_URL not set');
  pool = new Pool({ connectionString, max: 1, ssl: { rejectUnauthorized: false } });
  return pool;
}

/**
 * Calls a project_admin-gated Postgres function that returns a scalar or
 * jsonb value (e.g. finalize_pending_purchase, confirm_ticket_payment) and
 * returns that single result. NOT for TABLE(...)-returning functions —
 * those come back as an unparsed composite string this way, not named
 * fields; use callProjectAdminTableRpc for those instead.
 */
export async function callProjectAdminRpc<T = any>(fnName: string, args: any[]): Promise<T> {
  const placeholders = args.map((_, i) => `$${i + 1}`).join(', ');
  const { rows } = await getPool().query(`SELECT ${fnName}(${placeholders}) AS result`, args);
  return rows[0]?.result as T;
}

/**
 * Calls a project_admin-gated Postgres function declared as
 * `RETURNS TABLE(...)` (e.g. complete_organizer_payout,
 * fail_organizer_payout) and returns its rows with real named columns —
 * `SELECT fn(...) AS result` would instead return each row as an
 * unparsed composite string ("(val1,val2,...)"), not an object.
 */
export async function callProjectAdminTableRpc<T = any>(fnName: string, args: any[]): Promise<T[]> {
  const placeholders = args.map((_, i) => `$${i + 1}`).join(', ');
  const { rows } = await getPool().query(`SELECT * FROM ${fnName}(${placeholders})`, args);
  return rows as T[];
}
