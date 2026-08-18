import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { methodBody } from '../db/cases-columns.test-helpers';

const source = fs.readFileSync(path.join(__dirname, 'repository.ts'), 'utf8');

/**
 * The columns listCasesByCustomer selects off public.cases, aliased `c`.
 *
 * This is the fifth statement in the codebase reading public.cases, and the only
 * one outside src/server/cases/repository.ts - so the parity guards over there do
 * not see it. The customer detail page's Cases card is fed from here.
 *
 * listCasesByCustomer deliberately selects only a subset of public.cases columns
 * (it feeds a summary table, not a full row fetch), so this is a "contains" guard,
 * not the "every column" guard used for the full-row statements in cases/repository.ts
 * and quotes/repository.ts. The query also aliases the table as `c` and mixes in
 * columns from other aliases (lq, so), so it needs its own small parser rather than
 * the shared unaliased `selectColumns` helper.
 */
function customerCaseSelectColumns(): string[] {
  const body = methodBody(source, 'listCasesByCustomer');
  return [...body.matchAll(/c\.([a-z_][a-z0-9_]*)/gi)].map((m) => m[1].toLowerCase());
}

describe('customers repository listCasesByCustomer', () => {
  it('parses a plausible column list, so a failed regex cannot pass vacuously', () => {
    const selected = customerCaseSelectColumns();
    expect(selected.length).toBeGreaterThan(5);
    expect(selected).toContain('case_id');
  });

  it('selects the case priority', () => {
    expect(
      customerCaseSelectColumns(),
      'the customer detail Cases card renders a priority badge; this query must supply it'
    ).toContain('priority');
  });
});
