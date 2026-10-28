import pg from 'pg';

const { Pool } = pg;

const toPostgresSql = (source) => {
  let index = 0;
  let sql = source.trim().replace(/\?/g, () => `$${++index}`);
  const ignore = /INSERT\s+OR\s+IGNORE\s+INTO/i.test(sql);
  sql = sql.replace(/INSERT\s+OR\s+IGNORE\s+INTO/i, 'INSERT INTO');
  if (ignore && !/ON\s+CONFLICT/i.test(sql)) sql = `${sql.replace(/;\s*$/, '')} ON CONFLICT DO NOTHING`;
  return sql;
};

class Statement {
  constructor(database, sql, values = []) {
    this.database = database;
    this.sql = sql;
    this.values = values;
  }

  bind(...values) {
    return new Statement(this.database, this.sql, values);
  }

  async execute(client = this.database.pool) {
    return client.query(toPostgresSql(this.sql), this.values);
  }

  async run() {
    const result = await this.execute();
    return { changes: result.rowCount, meta: { changes: result.rowCount } };
  }

  async first() {
    const result = await this.execute();
    return result.rows[0] ?? null;
  }

  async all() {
    const result = await this.execute();
    return { results: result.rows };
  }
}

export class PostgresDatabase {
  constructor(connectionString) {
    this.pool = new Pool({
      connectionString,
      max: Number(process.env.POSTGRES_POOL_SIZE) || 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
  }

  prepare(sql) {
    return new Statement(this, sql);
  }

  async batch(statements) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const results = [];
      for (const statement of statements) {
        const result = await statement.execute(client);
        results.push({ changes: result.rowCount, meta: { changes: result.rowCount }, results: result.rows });
      }
      await client.query('COMMIT');
      return results;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** Serialize cross-project finance checks and the revisioned write in one transaction. */
  async financialTransaction(work) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // One workspace lock also covers newly created projects, which have no row to lock yet.
      await client.query("SELECT pg_advisory_xact_lock(731104, 280026)");
      const scoped = {
        prepare: sql => new Statement({ pool: client }, sql),
        batch: async statements => {
          const results = [];
          for (const statement of statements) {
            const result = await statement.execute(client);
            results.push({ changes: result.rowCount, meta: { changes: result.rowCount }, results: result.rows });
          }
          return results;
        },
      };
      const result = await work(scoped);
      // HTTP validation failures do not keep partial preparatory writes.
      await client.query(result instanceof Response && result.status >= 400 ? 'ROLLBACK' : 'COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async close() {
    await this.pool.end();
  }
}

export { toPostgresSql };
