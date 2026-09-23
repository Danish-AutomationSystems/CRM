import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The regression guard for the pooled-connection stall bug (dashboard edition).
 *
 * This CRM used to fail at 10 concurrent users. One dashboard request fanned
 * out to ~20 database queries, ~12 of them exact duplicates (`listUsers` 4x,
 * `listHandlers` 3x) because `dashboard/rpc.ts`, `cases/rpc.ts` and
 * `customers/rpc.ts` each built their service tree ONCE at module scope, and
 * each service held its own unmemoized repository. Every request replayed
 * every duplicate read against a pool of 10 connections; ten concurrent
 * requests needing ~5 connections each hung for minutes.
 *
 * The fix has three parts, and all three live entirely in how these files are
 * WIRED, not in any function's logic:
 *   1. `memoizeRepository(repo, READ_METHODS)` wraps each repository so each
 *      distinct read (method + args) resolves once per request.
 *   2. The service tree is built inside a per-request factory function
 *      (`function service() { ... }`, called fresh on every RPC dispatch),
 *      never as a `const` at module scope - a module-scope instance would be
 *      built once at server start and its memoization cache would then either
 *      leak across every request forever (stale data) or never be reset.
 *   3. Where one RPC module composes several services (dashboard composes
 *      case and customer services), all of them must be handed the SAME
 *      memoized repository instance so their reads are deduplicated against
 *      each other, not just against themselves - and each service must
 *      receive the repository shaped for it (cases repo has `listCases`,
 *      customers repo has `listCustomers`; they are not interchangeable).
 *
 * WHY a source-level guard, not a behavioural test:
 * A behavioural test exercises a service through an in-memory fake repository
 * and asserts on call counts or returned data. That can catch a *service*
 * that forgets to memoize internally, but it cannot catch this bug, because
 * this bug is not in any service - it is in whether the RPC module chose to
 * build the service fresh per request with a memoized repository, or once at
 * import time with a bare one. Both wirings produce identical results in a
 * single-request test; the difference only shows up as connection-pool
 * exhaustion under concurrent load; which is expensive to simulate and easy
 * to flake. Reading the source text and asserting the wiring shape directly
 * is what actually catches "moved the `const service = ...` back above the
 * registerRpc calls" or "dropped one `memoizeRepository(` call" - the exact
 * two-line edits that reintroduced this outage's shape.
 *
 * WHAT THIS GUARD CANNOT CATCH:
 * - A repository method's SQL query itself being expensive or duplicative
 *   within a single call (this only guards *cross-call* deduplication).
 * - `memoizeRepository` being called with a read-methods list that is missing
 *   an entry that should be there (covered separately by
 *   db/repository-reads.test.ts, which is a fixture/logic test, not a wiring
 *   test).
 * - A NEW RPC module added later that reintroduces this exact bug by never
 *   being added to `WIRED_MODULES` below - this guard only watches the three
 *   files it is told to watch.
 * - Runtime behaviour: this test never imports or executes any of these
 *   modules, so it cannot verify the memoized proxy is actually threaded
 *   through correctly at runtime; it only verifies the source text says it
 *   is. Combined with `db/memoize-repository.ts`'s own unit coverage of the
 *   Proxy's caching behaviour, that is a deliberate division of labour: unit
 *   tests prove the primitive works, this test proves the primitive is used,
 *   correctly wired, in the three call sites that matter.
 *
 * If you are reading this because this test just failed: you are about to
 * reintroduce the connection-pool stall that broke this app at 10 concurrent
 * users. Do not weaken this test to make it pass - fix the wiring instead.
 */

const WIRED_MODULES = ['dashboard/rpc.ts', 'cases/rpc.ts', 'customers/rpc.ts'];

function sourceOf(relative: string): string {
  return fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
}

describe('per-request service wiring (dashboard / cases / customers rpc)', () => {
  it.each(WIRED_MODULES)('%s memoizes its repository/repositories', (relative) => {
    const source = sourceOf(relative);
    const memoizeCalls = source.match(/memoizeRepository\(/g) ?? [];
    expect(
      memoizeCalls.length,
      `${relative} does not call memoizeRepository(...) - every read repository handed to a service must be ` +
        'wrapped so duplicate reads (listUsers, listHandlers, ...) within one request collapse to a single query. ' +
        'Without this, concurrent requests exhaust the connection pool exactly as they did before this fix.'
    ).toBeGreaterThan(0);
  });

  it.each(WIRED_MODULES)('%s does not build a service instance at module scope', (relative) => {
    const source = sourceOf(relative);
    // Matches `const <name> = create<Something>Service(` at the START of a line
    // (module scope), which is how a service instance built once at import
    // time - and therefore shared, uncleared, across every subsequent request
    // - would appear. A per-request factory function assigned to a `const`
    // (e.g. `const service = () => { ... createXService(...) ... }`) is fine
    // and is NOT matched: the parenthesis must immediately follow
    // `create...Service`, not an arrow/function keyword.
    const moduleScopeServiceInstance = /^const\s+\w+\s*=\s*create\w*Service\(/m;
    const match = source.match(moduleScopeServiceInstance);
    expect(
      match,
      `${relative} builds a service instance at module scope (\`${match?.[0]}\`). This is the exact regression ` +
        'that caused the original outage: a module-scope service is constructed once when the server starts and ' +
        'reused for every request after that, so its memoized repository cache either goes stale forever or is ' +
        'never cleared between requests. Services must be built inside a per-request factory function, called ' +
        'fresh on every RPC dispatch (see the `function service() { ... }` pattern in this file\'s siblings).'
    ).toBeNull();
  });

  it('dashboard/rpc.ts pairs each service with the repository shaped for it', () => {
    const source = sourceOf('dashboard/rpc.ts');

    // Find what identifier the cases repo and the customers repo are memoized into.
    const casesVar = source.match(/const\s+(\w+)\s*=\s*memoizeRepository\(\s*caseRepository\s*,\s*CASE_READ_METHODS\s*\)/);
    const customersVar = source.match(
      /const\s+(\w+)\s*=\s*memoizeRepository\(\s*customerRepository\s*,\s*CUSTOMER_READ_METHODS\s*\)/
    );

    expect(
      casesVar,
      'dashboard/rpc.ts does not memoize caseRepository with CASE_READ_METHODS as a clearly-named local - ' +
        'cannot verify which repository createDashboardService/createCaseService receive.'
    ).not.toBeNull();
    expect(
      customersVar,
      'dashboard/rpc.ts does not memoize customerRepository with CUSTOMER_READ_METHODS as a clearly-named local - ' +
        'cannot verify which repository createCustomerService receives.'
    ).not.toBeNull();

    const cases = casesVar![1];
    const customers = customersVar![1];

    // createCustomerService must receive the CUSTOMERS repo, not the cases repo.
    // Swapping these compiles and passes any behavioural test with a fake repo
    // shaped like "any object" - it only breaks at runtime when customerService
    // calls a cases-only method like listCases instead of listCustomers, or vice
    // versa, on the real Postgres-backed repository.
    const customerServiceCall = source.match(/createCustomerService\(\s*(\w+)\s*\)/);
    expect(
      customerServiceCall,
      'dashboard/rpc.ts does not call createCustomerService(<repo>) with a single simple identifier argument - ' +
        'cannot verify it receives the customers repository.'
    ).not.toBeNull();
    expect(
      customerServiceCall![1],
      `createCustomerService received "${customerServiceCall?.[1]}" instead of the memoized customers repository ` +
        `("${customers}"). The customer service calls methods like listCustomers that only exist on the ` +
        'customers repository; handing it the cases repository fails at runtime with "not a function", not at ' +
        'compile time or in a fake-repository unit test.'
    ).toBe(customers);

    // createDashboardService and createCaseService must both receive the CASES repo.
    for (const factory of ['createDashboardService', 'createCaseService']) {
      const call = source.match(new RegExp(`${factory}\\(\\s*(\\w+)`));
      expect(
        call,
        `dashboard/rpc.ts does not call ${factory}(<repo>, ...) with a simple identifier as its first argument - ` +
          'cannot verify it receives the cases repository.'
      ).not.toBeNull();
      expect(
        call![1],
        `${factory} received "${call?.[1]}" as its repository instead of the memoized cases repository ` +
          `("${cases}"). Handing it the customers repository breaks its case-shaped reads (listCases, ` +
          'listHandlers, ...) at runtime.'
      ).toBe(cases);
    }
  });

  it('cases repositories are memoized with CASE_READ_METHODS, and customers repositories with CUSTOMER_READ_METHODS', () => {
    for (const relative of WIRED_MODULES) {
      const source = sourceOf(relative);

      const caseMemoizeCalls = [...source.matchAll(/memoizeRepository\(\s*caseRepository\s*,\s*(\w+)\s*\)/g)];
      for (const call of caseMemoizeCalls) {
        expect(
          call[1],
          `${relative} memoizes caseRepository with "${call[1]}" instead of CASE_READ_METHODS. Using the wrong ` +
            "allow-list either fails to cache reads that should be cached (the original outage's cause) or " +
            'caches a write/locking method (e.g. lockCase) that must always hit the database fresh.'
        ).toBe('CASE_READ_METHODS');
      }

      const customerMemoizeCalls = [...source.matchAll(/memoizeRepository\(\s*customerRepository\s*,\s*(\w+)\s*\)/g)];
      for (const call of customerMemoizeCalls) {
        expect(
          call[1],
          `${relative} memoizes customerRepository with "${call[1]}" instead of CUSTOMER_READ_METHODS. Using the ` +
            'wrong allow-list either fails to cache reads that should be cached, or caches a write/locking method ' +
            '(e.g. lockCustomerName) that must always hit the database fresh.'
        ).toBe('CUSTOMER_READ_METHODS');
      }

      // At least one of the two patterns above must have matched something,
      // per the "each file calls memoizeRepository" requirement already
      // asserted elsewhere - this loop would otherwise pass vacuously if the
      // regexes above stopped matching due to a rename.
      const relevantRepoName = relative.startsWith('customers/') ? 'customerRepository' : 'caseRepository';
      const anyMemoizeCallForThisRepo = new RegExp(`memoizeRepository\\(\\s*${relevantRepoName}\\s*,`).test(source);
      expect(
        anyMemoizeCallForThisRepo,
        `${relative} never calls memoizeRepository(${relevantRepoName}, ...) - the read-methods pairing check ` +
          'above may be passing vacuously because the extractor regex no longer matches this file\'s source.'
      ).toBe(true);
    }
  });
});
