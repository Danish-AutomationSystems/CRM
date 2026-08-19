import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The regression guard for the pooled-connection stall bug.
 *
 * `db/client.ts` builds the pool with `postgres(url, { prepare: false })` -
 * default `max: 10`. `repo.withTransaction(async (tx) => { const trx = tx ?? repo; ... })`
 * checks out one connection from that pool and holds it for the callback's
 * lifetime. Calling `loadSettings(repo)` *inside* that callback - instead of
 * `loadSettings(trx)` - checks out a SECOND connection from the same pool
 * while the first is still held. Ten concurrent callers doing that (e.g. ten
 * "Mark as Won" saves) hold all ten connections and each blocks on an
 * eleventh: a hard stall until the connect timeout, not merely a slow query.
 *
 * The in-memory fake repository used by every service test cannot catch this:
 * its withTransaction passes the exact same object as both `tx` and the outer
 * `repo`, so `loadSettings(repo)` and `loadSettings(trx)` are indistinguishable
 * in a test double. Only a source-level guard, not a behavioural test, can see
 * the difference - see cases/service.ts:803's fix (loadSettings(trx)) and the
 * commit that introduced this guard alongside it.
 */

/** Modules that call repo.withTransaction and must never read settings through `repo` inside it. */
const GUARDED = ['cases/service.ts', 'customers/service.ts'];

function sourceOf(relative: string): string {
  return fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
}

/**
 * Every `repo.withTransaction(async (tx) => { ... })` callback body in `source`,
 * extracted by brace-depth counting from the opening `{` after the arrow to its
 * matching close - not by searching for a named method, because these callbacks
 * are anonymous and there is no next-method boundary to bound a slice by. Depth
 * counting instead of a name search is also why this does not repeat the
 * "next-method" mistake documented in settings/config-targets.test.ts: there is
 * no name to accidentally match earlier in the file.
 */
function transactionBodies(source: string): string[] {
  const bodies: string[] = [];
  const opener = /withTransaction\(async \([^)]*\)\s*=>\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = opener.exec(source))) {
    const braceStart = match.index + match[0].length - 1;
    let depth = 0;
    let i = braceStart;
    for (; i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) throw new Error(`unbalanced braces scanning a withTransaction body from index ${match.index}`);
    bodies.push(source.slice(braceStart, i + 1));
  }
  return bodies;
}

describe('no loadSettings(repo) inside a withTransaction callback', () => {
  it.each(GUARDED)('%s never reads live settings through `repo` while a transaction is open', (relative) => {
    const source = sourceOf(relative);
    const bodies = transactionBodies(source);
    // A file with zero transaction callbacks would make the assertion below pass
    // vacuously - both guarded files are known to call withTransaction, so this
    // catches the extractor breaking (e.g. on a rename or reformat) silently.
    expect(bodies.length, `found no withTransaction callbacks in ${relative} - the extractor may be broken`).toBeGreaterThan(0);

    const offendingBodies = bodies.filter((body) => /loadSettings\(\s*repo\s*\)/.test(body));
    expect(
      offendingBodies.length,
      `${relative} has a withTransaction callback that calls loadSettings(repo) - this checks out a second ` +
        'pooled connection while the transaction holds the first. Use loadSettings(trx) (the `tx ?? repo` ' +
        'binding) instead.'
    ).toBe(0);
  });

  it('the extractor actually finds bodies and reports their loadSettings calls correctly', () => {
    // Self-test against a small fixture, independent of the real source files,
    // so a change to the two real files can never make this suite's own logic
    // untested.
    const clean = `
      async function ok(repo) {
        const live = await loadSettings(repo);
        return repo.withTransaction(async (tx) => {
          const trx = tx ?? repo;
          const categories = await loadSettings(trx);
          return categories;
        });
      }
    `;
    const dirty = `
      async function bad(repo) {
        return repo.withTransaction(async (tx) => {
          const trx = tx ?? repo;
          const categories = await loadSettings(repo);
          return categories;
        });
      }
    `;
    const cleanBodies = transactionBodies(clean);
    expect(cleanBodies.length).toBe(1);
    expect(cleanBodies.some((body) => /loadSettings\(\s*repo\s*\)/.test(body))).toBe(false);

    const dirtyBodies = transactionBodies(dirty);
    expect(dirtyBodies.length).toBe(1);
    expect(dirtyBodies.some((body) => /loadSettings\(\s*repo\s*\)/.test(body))).toBe(true);
  });
});
