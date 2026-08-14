import { pathToFileURL } from 'node:url';

import { PostgresDatabase } from './postgres.js';

export const revokeRestoredAccess = async (pool) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tables = await client.query(`
      SELECT to_regclass('public.auth_sessions') AS sessions,
             to_regclass('public.auth_tokens') AS tokens,
             to_regclass('public.auth_login_limits') AS limits
    `);
    const now = new Date().toISOString();
    let revokedSessions = 0;
    let revokedTokens = 0;
    let clearedLimits = 0;
    if (tables.rows[0]?.sessions) {
      revokedSessions = (await client.query(
        'UPDATE auth_sessions SET revoked_at=COALESCE(revoked_at,$1) WHERE revoked_at IS NULL',
        [now],
      )).rowCount;
    }
    if (tables.rows[0]?.tokens) {
      revokedTokens = (await client.query(
        'UPDATE auth_tokens SET revoked_at=COALESCE(revoked_at,$1) WHERE used_at IS NULL AND revoked_at IS NULL',
        [now],
      )).rowCount;
    }
    if (tables.rows[0]?.limits) {
      clearedLimits = (await client.query('DELETE FROM auth_login_limits')).rowCount;
    }
    await client.query('COMMIT');
    return { revokedSessions, revokedTokens, clearedLimits };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const database = new PostgresDatabase(connectionString);
  try {
    const result = await revokeRestoredAccess(database.pool);
    console.log(`RESTORED_ACCESS_REVOKED sessions=${result.revokedSessions} tokens=${result.revokedTokens} limits=${result.clearedLimits}`);
  } finally {
    await database.close();
  }
}
