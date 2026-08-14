import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * A table that is missing from the backup/restore lists is lost in silence:
 * backup-database.mjs never dumps it, verify-backup.mjs only iterates what the
 * dump contains, and restore-database.mjs truncates with CASCADE - so the table
 * is emptied by a parent's truncate whether or not it is listed. case_attachments
 * was missed exactly this way. This test compares the lists against the tables
 * the migrations actually create, so the next new table cannot be forgotten.
 *
 * Everything here is static file reading. No database is contacted.
 */
const root = path.resolve(__dirname, '..', '..', '..');

function listFrom(file: string, constName: string): string[] {
  const source = readFileSync(path.join(root, 'scripts', file), 'utf8');
  const block = new RegExp(`const ${constName} = \\[([\\s\\S]*?)\\];`).exec(source);
  if (!block) throw new Error(`${constName} not found in scripts/${file}`);
  return [...block[1].matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
}

function migrationTables(): string[] {
  const dir = path.join(root, 'supabase', 'migrations');
  const names = new Set<string>();
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.sql'))) {
    const sql = readFileSync(path.join(dir, file), 'utf8');
    for (const match of sql.matchAll(/create table if not exists public\.([a-z_]+)/g)) {
      names.add(match[1]);
    }
  }
  return [...names];
}

describe('backup and restore table coverage', () => {
  const backupTables = listFrom('backup-database.mjs', 'TABLES');
  const insertOrder = listFrom('restore-database.mjs', 'INSERT_ORDER');

  it('backs up every table the migrations create', () => {
    for (const table of migrationTables()) {
      expect(backupTables, `${table} is not in backup-database.mjs TABLES`).toContain(table);
    }
  });

  it('restores every table it backs up, in the same order', () => {
    // schema_migrations is created by apply-migrations.mjs rather than a
    // migration file, so it is only ever checked through these two lists.
    expect(insertOrder).toEqual(backupTables);
  });

  it('includes case_attachments after both of its foreign-key parents', () => {
    for (const list of [backupTables, insertOrder]) {
      const attachments = list.indexOf('case_attachments');
      expect(attachments).toBeGreaterThan(-1);
      // activity_id -> activity_log(id), uploaded_by -> users(email).
      expect(attachments).toBeGreaterThan(list.indexOf('activity_log'));
      expect(attachments).toBeGreaterThan(list.indexOf('users'));
    }
  });

  it('orders every table after the tables it references', () => {
    // Parsed from the migrations rather than restated, so a new foreign key is
    // covered without touching this test.
    const dir = path.join(root, 'supabase', 'migrations');
    const references: Array<{ child: string; parent: string }> = [];
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.sql'))) {
      const sql = readFileSync(path.join(dir, file), 'utf8');
      for (const table of sql.split(/create table if not exists public\./).slice(1)) {
        const child = /^([a-z_]+)/.exec(table)?.[1];
        const body = table.slice(0, table.indexOf('\n);'));
        if (!child) continue;
        for (const match of body.matchAll(/references public\.([a-z_]+)/g)) {
          if (match[1] !== child) references.push({ child, parent: match[1] });
        }
      }
    }

    expect(references.length).toBeGreaterThan(0);
    for (const { child, parent } of references) {
      expect(insertOrder.indexOf(child), `${child} must be inserted after ${parent}`).toBeGreaterThan(
        insertOrder.indexOf(parent)
      );
    }
  });
});
