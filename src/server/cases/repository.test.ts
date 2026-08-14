import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.join(__dirname, 'repository.ts'), 'utf8');

function methodBody(name: string): string {
  const start = source.indexOf(`async ${name}(`);
  if (start === -1) throw new Error(`method ${name} not found in repository.ts`);
  const next = source.indexOf('\n  async ', start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

function insertColumns(): string[] {
  const body = methodBody('logActivity');
  const match = body.match(/insert into public\.activity_log \(([^)]*)\)/);
  if (!match) throw new Error('logActivity insert column list not found');
  return match[1].split(',').map((c) => c.trim()).filter(Boolean);
}

function insertValueCount(): number {
  const body = methodBody('logActivity');
  const match = body.match(/values \(([\s\S]*?)\)\s*`/);
  if (!match) throw new Error('logActivity values list not found');
  let depth = 0;
  let count = 1;
  for (const ch of match[1]) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (ch === ',' && depth === 0) count += 1;
  }
  return count;
}

describe('cases repository activity_log statements', () => {
  it('parses a plausible column list, so a failed regex cannot pass vacuously', () => {
    expect(insertColumns().length).toBeGreaterThan(3);
  });

  it('logActivity writes the note column', () => {
    expect(insertColumns()).toContain('note');
  });

  it('logActivity supplies exactly one value per inserted column', () => {
    expect(insertValueCount()).toBe(insertColumns().length);
  });

  it('listActivityByEntity reads the note column', () => {
    expect(methodBody('listActivityByEntity')).toMatch(/\bnote\b/);
  });
});
