import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import postgres from 'postgres';

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error('DATABASE_URL is required to apply migrations.');
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = path.join(root, 'supabase', 'migrations');

/**
 * `--through <prefix>` stops after the migration whose filename starts with <prefix>.
 *
 * This exists because a migration and the code that depends on it do not always ship
 * together. 0008 converts customers.sei from text to text[], which the currently
 * deployed code cannot write to - so it has to be applied in the same window as the
 * deploy, while 0005-0007 are safe to apply beforehand against the running system.
 * Without this flag the runner applies everything pending in one go, which would force
 * a longer outage than necessary.
 *
 * `--dry-run` lists what would be applied and changes nothing.
 */
const throughIndex = process.argv.indexOf('--through');
const through = throughIndex > -1 ? process.argv[throughIndex + 1] : null;
const dryRun = process.argv.includes('--dry-run');

if (throughIndex > -1 && !through) {
  console.error('--through needs a migration name or prefix, e.g. --through 0007');
  process.exit(1);
}

const sql = postgres(databaseUrl, { prepare: false });

try {
  await sql`
    create table if not exists public.schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )
  `;

  const migrationFiles = (await readdir(migrationsDir))
    .filter((file) => file.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b));

  for (const file of migrationFiles) {
    const [{ exists }] = await sql`
      select exists(
        select 1 from public.schema_migrations where name = ${file}
      ) as exists
    `;

    if (exists) {
      console.log(`Skipping ${file}`);
      continue;
    }

    if (dryRun) {
      console.log(`Would apply ${file}`);
      if (through && file.startsWith(through)) {
        console.log(`Would stop after ${file} (--through ${through}).`);
        break;
      }
      continue;
    }

    const migrationSql = await readFile(path.join(migrationsDir, file), 'utf8');
    await sql.begin(async (tx) => {
      await tx.unsafe(migrationSql);
      await tx`
        insert into public.schema_migrations(name)
        values (${file})
      `;
    });

    console.log(`Applied ${file}`);

    if (through && file.startsWith(through)) {
      console.log(`Stopping after ${file} as requested (--through ${through}).`);
      break;
    }
  }
} finally {
  await sql.end();
}
