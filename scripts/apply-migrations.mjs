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

    const migrationSql = await readFile(path.join(migrationsDir, file), 'utf8');
    await sql.begin(async (tx) => {
      await tx.unsafe(migrationSql);
      await tx`
        insert into public.schema_migrations(name)
        values (${file})
      `;
    });

    console.log(`Applied ${file}`);
  }
} finally {
  await sql.end();
}
