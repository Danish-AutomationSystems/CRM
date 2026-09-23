# Location Rules Implementation Plan (Track B: P5–P7)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A customer holds exactly one location, the `*` wildcard no longer exists, and a location cannot be removed from a user while they still handle customers in it.

**Architecture:** Both rules are enforced in the database as well as in the service layer, because data integrity that lives only in TypeScript is one bad migration away from being false. The conflict flow resolves reassignments and the user update in a single transaction.

**Tech Stack:** TypeScript, Next.js 15.5, postgres.js, Supabase, Vitest.

Spec: `docs/superpowers/specs/2026-09-23-ownership-and-location-rules-design.md`

**Depends on Track A** (`2026-09-23-ownership-rules.md`) being complete: Task 3 below reassigns handlers, and Track A defines what happens when ownership would otherwise reach zero.

## Global Constraints

- **TDD is mandatory.** Write the test, run it, watch it fail for the right reason, then implement. Never weaken a test to make it green.
- The full existing suite must stay green. A pre-existing failure means behaviour changed — fix the code, not the test.
- Verified starting data: **no customer holds more than one tag**, and `'*'` appears on exactly two accounts — `testing@` (L2) and `danish@` (L4).
- `accessLevel()` returns `FULL` for L4+ **before** tags are read, so tags are functionally irrelevant above L3. Do not "fix" L4+ access by giving them tags.
- Inside any transaction use the `trx` handle, never the outer `repo` — the outer one checks out a second pooled connection while the first is held, the deadlock documented in `src/server/settings/no-live-settings-in-transaction.test.ts`.
- Run `npx tsc --noEmit -p tsconfig.json` before every commit. Do not push.

---

### Task 1: A customer holds exactly one location

**Files:**
- Modify: `src/server/customers/service.ts`
- Modify: `src/server/customers/service.test.ts`
- Create: `supabase/migrations/0016_customer_single_location.sql`

- [ ] **Step 1: Write the failing tests**

```typescript
describe('a customer holds exactly one location', () => {
  it('rejects a customer created with two locations', async () => {
    const { service, l2 } = makeService();

    await expect(
      service.createCustomer(l2, { name: 'Two Tags', tags: ['Punjab', 'NCR'] })
    ).rejects.toThrow(/one location/i);
  });

  it('rejects a customer created with no location', async () => {
    const { service, l2 } = makeService();

    await expect(service.createCustomer(l2, { name: 'No Tags', tags: [] })).rejects.toThrow(
      /location/i
    );
  });

  it('accepts exactly one location', async () => {
    const { service, l2 } = makeService();

    const created = await service.createCustomer(l2, { name: 'One Tag', tags: ['Punjab'] });

    expect(created).toBeTruthy();
  });

  it('rejects an edit that would set two locations', async () => {
    const { service, l2 } = makeService();
    const created = await service.createCustomer(l2, { name: 'Editable', tags: ['Punjab'] });

    await expect(
      service.updateCustomer(l2, created.id, { tags: ['Punjab', 'NCR'] })
    ).rejects.toThrow(/one location/i);
  });
});
```

Read the existing test file first and reuse its helpers rather than inventing `makeService`/`l2`.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run src/server/customers/service.test.ts`
Expected: the two-location tests FAIL (multiple tags are currently accepted). The "no location" test may already pass, since location is mandatory at creation — that is fine and expected; say so in your report.

- [ ] **Step 3: Enforce it in the service**

Find where customer tags are validated on create and on update (search for `requiredTags`). Enforce exactly one entry on **both** paths, with a message naming the rule, e.g. `A customer can have only one location.` Keep the existing "location is mandatory" behaviour.

- [ ] **Step 4: Run them and watch them pass**

Run: `npx vitest run src/server/customers/service.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the database constraint**

`public.customers` has no tag-cardinality constraint today. Read `supabase/migrations/0014_*.sql` first and follow the house pattern (`set local lock_timeout`, post-condition `do $$ ... raise exception` block).

```sql
alter table public.customers
  add constraint customers_single_location_check
  check (cardinality(tags) = 1);
```

No data migration is needed — zero customers currently violate this. The post-condition must assert the constraint exists. DO NOT run the migration against any database; writing the file is the task.

- [ ] **Step 6: Full suite, type check, commit**

```bash
npx vitest run
npx tsc --noEmit -p tsconfig.json
git add -A src/server/customers supabase/migrations
git commit -m "feat: a customer holds exactly one location"
```

---

### Task 2: Remove the `*` wildcard

**Files:**
- Modify: `src/server/auth/access.ts`
- Modify: `src/server/auth/access.test.ts`
- Modify: `src/server/admin/service.ts`
- Create: `supabase/migrations/0017_remove_allowed_tags_wildcard.sql`

**This is access-control code. It decides who can see which customers. Treat every assertion as load-bearing.**

- [ ] **Step 1: Write the failing tests**

```typescript
describe('the * wildcard no longer grants access', () => {
  const customer = { id: 'CUST-1', tags: ['Punjab'], status: 'Active' };

  it('grants an L2 holding "*" nothing, because * is just an unmatched string now', () => {
    const l2 = { email: 'l2@automationsystems.org', role: 'L2', allowedTags: ['*'] };

    expect(accessLevel(l2, customer, { handlerEmailsByCustomerId: {} })).toBe('NONE');
  });

  it('grants an L2 the customers in their listed locations', () => {
    const l2 = { email: 'l2@automationsystems.org', role: 'L2', allowedTags: ['Punjab'] };

    expect(accessLevel(l2, customer, { handlerEmailsByCustomerId: {} })).toBe('NAME');
  });

  it('grants an L2 nothing outside their listed locations', () => {
    const l2 = { email: 'l2@automationsystems.org', role: 'L2', allowedTags: ['NCR'] };

    expect(accessLevel(l2, customer, { handlerEmailsByCustomerId: {} })).toBe('NONE');
  });

  it('still grants L4 full access with no tags at all', () => {
    const l4 = { email: 'l4@automationsystems.org', role: 'L4', allowedTags: [] };

    expect(accessLevel(l4, customer, { handlerEmailsByCustomerId: {} })).toBe('FULL');
  });
});
```

- [ ] **Step 2: Run and watch the first test fail**

Run: `npx vitest run src/server/auth/access.test.ts`
Expected: the first test FAILS with `expected 'NAME' to be 'NONE'` — the wildcard still grants access.

- [ ] **Step 3: Delete the wildcard branch**

In `tagMatches` (`src/server/auth/access.ts`), remove `if (user.allowedTags.includes('*')) return true;`. In `normalizeAllowedTags` (`src/server/admin/service.ts:296-299`), remove the `tags.includes('*') ? ['*'] : tags` collapse and reject `'*'` as an allowed tag value with a clear error. Check `reservedConfigValue` (same file, ~line 373) — its comment explains `'*'` is reserved; update that comment so it no longer describes a wildcard that exists, and keep `TAG_TO_BE_FILLED` reserved.

- [ ] **Step 4: Run and watch them pass**

Run: `npx vitest run src/server/auth/access.test.ts`
Expected: PASS. Existing tests asserting wildcard behaviour encoded the feature being removed — update only those, and list each one with justification in your report.

- [ ] **Step 5: Migrate the two accounts and replace the constraint**

Exactly two accounts hold `'*'`: `testing@automationsystems.org` (L2) and `danish@automationsystems.org` (L4).

- `danish@` (L4) becomes `'{}'` — provably no functional change, because L4+ short-circuits to `FULL` before tags are read.
- `testing@` (L2) becomes the explicit list of every location currently in `settings.TAGS` **excluding** the `TO BE FILLED` placeholder, preserving exactly today's reach. A refactor must not silently change who can see what.

The existing `users_star_tag_check` only stops `'*'` coexisting with other tags. Replace it with one forbidding `'*'` outright:

```sql
alter table public.users drop constraint users_star_tag_check;
alter table public.users
  add constraint users_no_wildcard_tag_check
  check (not ('*' = any(allowed_tags)));
```

Migrate the data BEFORE adding the constraint or it will fail. Post-condition: assert no user row still holds `'*'`. DO NOT run it against any database.

- [ ] **Step 6: Full suite, type check, commit**

```bash
npx vitest run
npx tsc --noEmit -p tsconfig.json
git add -A src/server supabase/migrations
git commit -m "feat: remove the allowed_tags wildcard"
```

---

### Task 3: Removing a location is blocked by customers that user still handles

**Files:**
- Modify: `src/server/admin/service.ts`
- Modify: `src/server/admin/service.test.ts`
- Modify: `src/server/admin/rpc.ts`

**Interfaces:**
- Produces: `userLocationConflicts(user, { email, removing })` returning `{ conflicts: Array<{ customerId, customerName, location }>, eligibleHandlers: Array<{ email, name, role }> }`.
- `saveUser` gains an optional `reassign` input: `Record<customerId, newHandlerEmail>`.

- [ ] **Step 1: Write the failing tests**

```typescript
describe('removing a location a user still handles customers in', () => {
  it('lists the blocking customers', async () => {
    const { service, repo, admin } = makeService();
    repo.setCustomer('CUST-1', { name: 'Acme', tags: ['Punjab'] });
    repo.setHandlers('CUST-1', ['l2@automationsystems.org']);

    const result = await service.userLocationConflicts(admin, {
      email: 'l2@automationsystems.org',
      removing: ['Punjab']
    });

    expect(result.conflicts.map((c) => c.customerId)).toEqual(['CUST-1']);
  });

  it('refuses the removal while a conflict is unresolved', async () => {
    const { service, repo, admin } = makeService();
    repo.setCustomer('CUST-1', { name: 'Acme', tags: ['Punjab'] });
    repo.setHandlers('CUST-1', ['l2@automationsystems.org']);

    await expect(
      service.saveUser(admin, {
        email: 'l2@automationsystems.org',
        name: 'L2',
        role: 'L2',
        active: true,
        allowedTags: []
      })
    ).rejects.toThrow(/reassign/i);
  });

  it('allows the removal once every conflict is reassigned, and moves the handler', async () => {
    const { service, repo, admin } = makeService();
    repo.setCustomer('CUST-1', { name: 'Acme', tags: ['Punjab'] });
    repo.setHandlers('CUST-1', ['l2@automationsystems.org']);

    await service.saveUser(admin, {
      email: 'l2@automationsystems.org',
      name: 'L2',
      role: 'L2',
      active: true,
      allowedTags: [],
      reassign: { 'CUST-1': 'other@automationsystems.org' }
    });

    expect(repo.handlersFor('CUST-1')).toEqual(['other@automationsystems.org']);
  });

  it('accepts Direct as a replacement handler', async () => {
    const { service, repo, admin } = makeService();
    repo.setCustomer('CUST-1', { name: 'Acme', tags: ['Punjab'] });
    repo.setHandlers('CUST-1', ['l2@automationsystems.org']);

    await service.saveUser(admin, {
      email: 'l2@automationsystems.org',
      name: 'L2',
      role: 'L2',
      active: true,
      allowedTags: [],
      reassign: { 'CUST-1': 'direct' }
    });

    expect(repo.handlersFor('CUST-1')).toEqual(['direct']);
  });

  it('rejects an L6 as a replacement handler', async () => {
    const { service, repo, admin } = makeService();
    repo.setCustomer('CUST-1', { name: 'Acme', tags: ['Punjab'] });
    repo.setHandlers('CUST-1', ['l2@automationsystems.org']);

    await expect(
      service.saveUser(admin, {
        email: 'l2@automationsystems.org',
        name: 'L2',
        role: 'L2',
        active: true,
        allowedTags: [],
        reassign: { 'CUST-1': 'l6@automationsystems.org' }
      })
    ).rejects.toThrow(/L2|L4|eligible/i);
  });

  it('does not block on a location the user is keeping', async () => {
    const { service, repo, admin } = makeService();
    repo.setCustomer('CUST-1', { name: 'Acme', tags: ['Punjab'] });
    repo.setHandlers('CUST-1', ['l2@automationsystems.org']);

    await service.saveUser(admin, {
      email: 'l2@automationsystems.org',
      name: 'L2',
      role: 'L2',
      active: true,
      allowedTags: ['Punjab', 'NCR']
    });

    expect(repo.handlersFor('CUST-1')).toEqual(['l2@automationsystems.org']);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run src/server/admin/service.test.ts`
Expected: FAIL — `userLocationConflicts` does not exist and `saveUser` ignores conflicts.

- [ ] **Step 3: Implement the conflict query**

Add `userLocationConflicts(user, input)` to the admin service. It requires L3+ (match the permission level `saveUser` already requires — read it and follow it). It returns the customers the named user currently handles whose single location is among `removing`, plus the eligible replacement handlers: active users of role L2–L4, plus Direct.

**Fetch the customers in ONE batched query.** Do not loop a query per customer — that per-row fan-out is exactly the defect that caused the 2026-09-22 production outage.

- [ ] **Step 4: Enforce it in `saveUser`, atomically**

In `saveUser`, compute `removing` as the tags the user holds today but not in the incoming `allowedTags`. Recompute the conflicts **server-side** — the client's list is a convenience and must never be the authority. Then:

- every conflicting customer must have an entry in `reassign`, or throw an error naming the customers and telling the admin to reassign them first;
- each replacement must be an active L2–L4 user, or `direct`, validated server-side — reject anything else;
- apply every reassignment **and** the user update inside the existing `repo.withTransaction`, using `trx`. A partial apply must be impossible: half-reassigned customers would leave ownership wrong with no error shown.

Reassignment means the named user stops handling that customer and the replacement starts. Reuse the existing add/remove handler repository methods rather than writing new SQL, and keep activity logging consistent with `HANDLER_REMOVE`/handler-add elsewhere.

- [ ] **Step 5: Run and watch them pass**

Run: `npx vitest run src/server/admin/service.test.ts`
Expected: PASS.

- [ ] **Step 6: Register the RPC**

In `src/server/admin/rpc.ts`, register `api_admin_userLocationConflicts` as a read RPC, following the existing registration style in that file.

- [ ] **Step 7: Full suite, type check, commit**

```bash
npx vitest run
npx tsc --noEmit -p tsconfig.json
git add -A src/server/admin
git commit -m "feat: block removing a location while that user still handles customers in it"
```

**Note — client UI is deliberately out of scope for this plan.** The conflict card (the list of customers with a dropdown each) is a separate piece of work against the legacy client, and the server contract above is what it will call. Ship and verify the server rules first.
