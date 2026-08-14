/**
 * Restore a backup produced by scripts/backup-database.mjs.
 *
 * THIS DELETES EVERYTHING IN THE TARGET DATABASE'S PUBLIC CRM TABLES AND REPLACES IT
 * WITH THE BACKUP'S CONTENTS. It refuses to run without --yes-delete-everything.
 *
 * Rows are inserted through the driver's parameter binding, never string interpolation,
 * so text, arrays, jsonb and binary payloads survive exactly as captured.
 *
 * Usage:
 *   DATABASE_URL='postgresql://...' node scripts/restore-database.mjs backups/backup-....json --yes-delete-everything
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import postgres from 'postgres';

const databaseUrl = process.env.DATABASE_URL;
const file = process.argv[2];
const confirmed = process.argv.includes('--yes-delete-everything');

if (!databaseUrl) {
  console.error('DATABASE_URL is required.');
  process.exit(1);
}

if (!file) {
  console.error('Usage: node scripts/restore-database.mjs <backup-file.json> --yes-delete-everything');
  process.exit(1);
}

if (!confirmed) {
  console.error('Refusing to run without --yes-delete-everything.');
  console.error('This replaces the entire contents of the CRM tables in the target database.');
  process.exit(1);
}

// Children first when deleting, parents first when inserting.
const INSERT_ORDER = [
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
  // Parent-first: case_attachments references activity_log(id) and users(email),
  // both already above. It must also be in this list for a second, sharper
  // reason: the truncate below is `... restart identity cascade` and includes
  // activity_log, so CASCADE truncates case_attachments whether it is listed or
  // not. Left out, a restore wiped every attachment row and could put none back,
  // leaving the Drive files as permanently unreferenced orphans.
  'case_attachments',
  'import_customers',
  'import_contacts',
  'schema_migrations'
];

function decodeValue(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(decodeValue);
  if (value.__type === 'bytea') return Buffer.from(value.data, 'base64');
  if (value.__type === 'timestamp') return new Date(value.value);
  return value;
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dump = JSON.parse(await readFile(path.resolve(root, file), 'utf8'));
const sql = postgres(databaseUrl, { prepare: false });

try {
  const present = INSERT_ORDER.filter((table) => Array.isArray(dump.tables?.[table]));

  // The truncate below cascades, so a table the backup does not carry is still
  // emptied - and this restore has nothing to put back into it. Say so loudly:
  // that is exactly how case_attachments would have been lost silently.
  const missing = INSERT_ORDER.filter((table) => !Array.isArray(dump.tables?.[table]));
  if (missing.length > 0) {
    console.warn(`WARNING: this backup carries no rows section for: ${missing.join(', ')}.`);
    console.warn('The truncate cascades, so those tables are emptied and this restore cannot refill them.');
  }

  await sql.begin(async (tx) => {
    // One statement, so ordering and foreign keys resolve together.
    const list = present.map((table) => `public.${table}`).join(', ');
    await tx.unsafe(`truncate table ${list} restart identity cascade`);

    for (const table of present) {
      const rows = dump.tables[table];
      if (!rows.length) {
        console.log(`  - ${table}: empty`);
        continue;
      }

      const decoded = rows.map((row) => {
        const out = {};
        for (const [column, value] of Object.entries(row)) out[column] = decodeValue(value);
        return out;
      });

      // Chunked so a large quotations table cannot blow the parameter limit.
      for (let i = 0; i < decoded.length; i += 500) {
        const chunk = decoded.slice(i, i + 500);
        await tx`insert into ${tx(table)} ${tx(chunk)}`;
      }

      console.log(`  - ${table}: ${rows.length} row(s) restored`);
    }
  });

  console.log('\nRestore complete. Verify row counts:');
  console.log(`  node scripts/verify-backup.mjs ${file}`);
} finally {
  await sql.end();
}
