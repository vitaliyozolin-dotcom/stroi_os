import assert from 'node:assert/strict';
import test from 'node:test';
import { toPostgresSql } from '../server/postgres.js';

test('converts D1 placeholders to PostgreSQL parameters', () => {
  assert.equal(
    toPostgresSql('SELECT * FROM project_state WHERE project_id = ? AND revision = ?'),
    'SELECT * FROM project_state WHERE project_id = $1 AND revision = $2',
  );
});

test('converts INSERT OR IGNORE to PostgreSQL conflict handling', () => {
  assert.equal(
    toPostgresSql('INSERT OR IGNORE INTO system_meta (key, value) VALUES (?, ?)'),
    'INSERT INTO system_meta (key, value) VALUES ($1, $2) ON CONFLICT DO NOTHING',
  );
});
