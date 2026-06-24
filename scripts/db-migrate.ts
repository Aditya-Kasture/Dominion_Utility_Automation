/**
 * Apply the db/*.sql migrations in dependency order.
 *
 *   npm run db:migrate
 *
 * Uses the same .env connection as the rest of the pipeline. Every file is
 * idempotent DDL (CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS), so
 * re-running is safe. Order matters: base tables before the FKs that reference
 * them (e.g. migrations.sql audit logs reference property/unit; qb_csv_import
 * references orchestration_run).
 */
import fs from 'fs';
import path from 'path';
import * as dotenv from 'dotenv';
import { getPool, closePool, validateEnv } from '../tests/helpers/db';

dotenv.config();

// Applied in this exact order (dependencies first).
const FILES = [
  'base-schema.sql',
  'migrations.sql',
  'ws1-orchestration.sql',
  'ws2-routing.sql',
  'ws3-ws4-payments.sql',
  'ws6-audit-summary.sql',
];

async function main(): Promise<void> {
  validateEnv(['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD']);
  const dbDir = path.resolve(__dirname, '..', 'db');
  const pool = getPool();

  for (const name of FILES) {
    const file = path.join(dbDir, name);
    if (!fs.existsSync(file)) {
      console.warn(`[migrate] SKIP ${name} (not found)`);
      continue;
    }
    const sql = fs.readFileSync(file, 'utf8');
    process.stdout.write(`[migrate] applying ${name} ... `);
    await pool.query(sql);          // multi-statement simple-query, no params
    console.log('OK');
  }
  console.log('[migrate] all migrations applied.');
}

main()
  .then(async () => { await closePool(); process.exit(0); })
  .catch(async (err) => {
    console.error('\n[migrate] FAILED:', err?.message ?? err);
    await closePool().catch(() => {});
    process.exit(1);
  });
