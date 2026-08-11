/**
 * Verify a backup produced by scripts/backup-database.mjs.
 *
 * An unverified backup is not a backup. This checks the file parses, that every
 * tagged value actually decodes, and - if DATABASE_URL is set - that the row counts
 * still match the live database.
 *
 * Usage:
 *   node scripts/verify-backup.mjs backups/backup-....json
 *   DATABASE_URL='postgresql://...' node scripts/verify-backup.mjs backups/backup-....json
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = process.argv[2];

if (!file) {
  console.error('Usage: node scripts/verify-backup.mjs <backup-file.json>');
  process.exit(1);
}

const target = path.resolve(root, file);
let dump;

try {
  dump = JSON.parse(await readFile(target, 'utf8'));
} catch (error) {
  console.error(`Backup is unreadable: ${error.message}`);
  process.exit(1);
}

if (!dump.tables || typeof dump.tables !== 'object') {
  console.error('Backup has no tables section - it is not a valid dump.');
  process.exit(1);
}

let problems = 0;
let decodedBytea = 0;
let decodedTimestamps = 0;

function checkValue(value, where) {
  if (value === null || typeof value !== 'object') return;

  if (Array.isArray(value)) {
    value.forEach((item, index) => checkValue(item, `${where}[${index}]`));
    return;
  }

  if (value.__type === 'bytea') {
    try {
      Buffer.from(value.data, 'base64');
      decodedBytea++;
    } catch {
      console.error(`  ! ${where}: bytea payload does not decode`);
      problems++;
    }
    return;
  }

  if (value.__type === 'timestamp') {
    if (Number.isNaN(new Date(value.value).getTime())) {
      console.error(`  ! ${where}: timestamp does not parse`);
      problems++;
    } else {
      decodedTimestamps++;
    }
    return;
  }

  for (const [key, nested] of Object.entries(value)) checkValue(nested, `${where}.${key}`);
}

console.log(`Backup taken at: ${dump.takenAt ?? 'unknown'}\n`);

for (const [table, rows] of Object.entries(dump.tables)) {
  if (!Array.isArray(rows)) {
    console.error(`  ! ${table}: rows is not an array`);
    problems++;
    continue;
  }
  rows.forEach((row, index) => {
    for (const [column, value] of Object.entries(row)) checkValue(value, `${table}[${index}].${column}`);
  });
  console.log(`  - ${table}: ${rows.length} row(s)`);
}

console.log(`\nDecoded ${decodedBytea} binary value(s) and ${decodedTimestamps} timestamp(s).`);

if (process.env.DATABASE_URL) {
  const { default: postgres } = await import('postgres');
  const sql = postgres(process.env.DATABASE_URL, { prepare: false });
  console.log('\nComparing against the live database:');
  try {
    for (const [table, rows] of Object.entries(dump.tables)) {
      const [{ count }] = await sql`select count(*)::int as count from ${sql(table)}`;
      const backedUp = rows.length;
      if (count !== backedUp) {
        console.error(`  ! ${table}: live has ${count}, backup has ${backedUp}`);
        problems++;
      } else {
        console.log(`  - ${table}: ${count} row(s), matches`);
      }
    }
  } finally {
    await sql.end();
  }
} else {
  console.log('\nDATABASE_URL not set, so live row counts were not compared.');
  console.log('Re-run with it set for a stronger check before applying migrations.');
}

if (problems > 0) {
  console.error(`\nFAILED: ${problems} problem(s). Do not rely on this backup.`);
  process.exit(1);
}

console.log('\nBackup verified.');
