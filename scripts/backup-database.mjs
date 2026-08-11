/**
 * Full logical backup of the CRM database.
 *
 * Why this exists: the project runs on Supabase's free plan, which has no automated
 * backups, and this machine has neither pg_dump nor Docker (so `supabase db dump` is
 * not available either). This script needs nothing beyond the `postgres` driver the
 * app already depends on.
 *
 * Output is JSON rather than SQL on purpose. Hand-generating SQL literals means
 * hand-writing escaping for text, arrays, bytea and jsonb, which is exactly the kind
 * of code that looks right and silently corrupts one row in ten thousand. JSON round-
 * trips through the driver's own parameter binding instead, so nothing is ever
 * interpolated into a query string.
 *
 * Usage:
 *   DATABASE_URL='postgresql://...' node scripts/backup-database.mjs
 *   DATABASE_URL='postgresql://...' node scripts/backup-database.mjs --out backups/pre-0005.json
 *
 * Restore with scripts/restore-database.mjs.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import postgres from 'postgres';

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error('DATABASE_URL is required. Never paste it into a shared terminal or chat.');
  process.exit(1);
}

// Ordered parent-first so a restore can insert without tripping foreign keys.
const TABLES = [
  'users',
  'customers',
  'contacts',
  'handlers',
  'cases',
  'actions',
  'quotations',
  'quote_boq',
  'recycle_bin',
  'settings',
  'counters',
  'activity_log',
  'import_customers',
  'import_contacts',
  'schema_migrations'
];

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function outputPath() {
  const flagIndex = process.argv.indexOf('--out');
  if (flagIndex > -1 && process.argv[flagIndex + 1]) {
    return path.resolve(root, process.argv[flagIndex + 1]);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(root, 'backups', `backup-${stamp}.json`);
}

/**
 * The driver hands back rich JS values. Buffers and Dates have no JSON representation
 * that survives a round trip, so they are tagged and rebuilt on restore. Numerics are
 * deliberately left as the strings the driver returns - converting them to JS numbers
 * would quietly lose precision on money columns.
 */
function encodeValue(value) {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) return { __type: 'bytea', data: value.toString('base64') };
  if (value instanceof Date) return { __type: 'timestamp', value: value.toISOString() };
  if (Array.isArray(value)) return value.map(encodeValue);
  return value;
}

const sql = postgres(databaseUrl, { prepare: false });
const target = outputPath();

try {
  await mkdir(path.dirname(target), { recursive: true });

  const dump = {
    takenAt: new Date().toISOString(),
    tables: {}
  };
  const counts = {};

  for (const table of TABLES) {
    const [{ exists }] = await sql`
      select exists(
        select 1 from information_schema.tables
        where table_schema = 'public' and table_name = ${table}
      ) as exists
    `;

    if (!exists) {
      console.log(`  - ${table}: table not present, skipped`);
      continue;
    }

    const rows = await sql`select * from ${sql(table)}`;
    dump.tables[table] = rows.map((row) => {
      const encoded = {};
      for (const [column, value] of Object.entries(row)) encoded[column] = encodeValue(value);
      return encoded;
    });
    counts[table] = rows.length;
    console.log(`  - ${table}: ${rows.length} row(s)`);
  }

  dump.rowCounts = counts;
  await writeFile(target, JSON.stringify(dump, null, 2), 'utf8');

  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  console.log(`\nBackup written to ${target}`);
  console.log(`${total} row(s) across ${Object.keys(counts).length} table(s).`);
  console.log('\nVerify it before relying on it:');
  console.log('  node scripts/verify-backup.mjs ' + path.relative(root, target));
} finally {
  await sql.end();
}
