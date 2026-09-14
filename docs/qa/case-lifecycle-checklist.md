# Case Lifecycle Rollout Checklist

Covers the case-lifecycle feature built on `task4-integration` (merge commit `16ff1ac`):
Quoted cases have no ticket holder, a Revision stage with mandatory reassignment, and
customerless case registration mapped atomically on the first quotation save.

**Status: deployed to production 2026-09-14.** Both migrations applied and verified - see the
Case lifecycle entry in `CONTEXT.md` for the deploy record (backup taken, holder-clearing audit
confirmed, post-condition checks all passed). This checklist remains the reference for what was
done and for any future environment (staging, a fresh scratch DB) that still needs it applied.

## 1. Pre-deploy

- [ ] Take a full database backup of the production Supabase project (`postgres.cympxjsqetzivwxwbhob`)
      before running anything. Use the project's existing backup mechanism (Supabase dashboard
      backup, or `pg_dump` against the session pooler host) - do not rely on Supabase's automatic
      daily backup alone as the only copy at the moment of this change.
- [ ] Confirm the backup is restorable: restore it into a scratch database (a throwaway Supabase
      project or a local Postgres instance) and run `select count(*) from public.cases` and
      `select count(*) from public.activity_log` against it, checking the counts are non-zero and
      roughly match production. A backup nobody has restored is not a verified backup.
- [ ] Confirm `public.schema_migrations` currently ends at `0011` (the last migration listed as
      applied in `CONTEXT.md`) before starting - if it already shows `0012` or `0013`, stop and
      figure out why before proceeding; do not re-run a migration that already applied.

## 2. Migration order: 0012 then 0013

Apply migrations one at a time, in this exact order, with `scripts/apply-migrations.mjs`'s `--through`
flag (it applies every pending migration by default, so `--through` is what makes "one at a time"
actually possible) or the Supabase SQL editor. Do not batch them together and do not apply `0013`
first. With `DATABASE_URL` set, run these two commands in sequence:

```bash
node scripts/apply-migrations.mjs --through 0012
node scripts/apply-migrations.mjs --through 0013
```

(`--dry-run` can be added to either command first to preview what would be applied without changing
anything.)

- [ ] **Apply `0012_case_revision_workflow.sql` first.** It (a) adds `Revision` to the stage CHECK
      constraint, (b) writes one `CASE_QUOTED_HOLDER_CLEARED` activity-log row per existing Quoted
      case that still has an assignee, (c) clears `assignee` on those same rows, then (d) adds the
      `cases_quoted_unassigned_check` constraint. Reason for going first: the constraint in (d) would
      fail outright against any existing Quoted-and-assigned row if the cleanup in (b)/(c) had not
      already run - `0012` does both the cleanup and the constraint together, in the right order,
      inside one migration. (This is also simply the lower-numbered migration, and
      `scripts/apply-migrations.mjs` applies pending files in filename order - see the note on `0013`
      below for why no deeper ordering hazard exists between the two.)
  - After it applies, check: `select count(*) from public.cases where stage = 'Quoted' and assignee is not null;`
    must return `0`. If it does not, the migration did not complete and the constraint add would have
    failed loudly - do not proceed to `0013` until this is `0`.
  - Also check: `select count(*) from public.activity_log where action = 'CASE_QUOTED_HOLDER_CLEARED';`
    should equal the number of Quoted+assigned rows that existed before the migration ran (compare
    against a `select count(*)` taken from the pre-migration backup/scratch restore in step 1).
- [ ] **Apply `0013_customerless_cases.sql` second.** It drops the `NOT NULL` constraint on
      `cases.customer_id` (keeping the existing foreign key) and adds `cases_quoted_customer_check`,
      which requires a non-null `customer_id` whenever a case is `Quoted` or has `outcome = 'Won'`.
      Reason it must come after `0012`: this is sequential migration numbering, nothing more -
      `0012` only touches `stage`/`assignee`, `0013` only touches `customer_id` nullability, and the
      two constraints do not interact. (A customerless-Quoted case cannot exist before `0013` runs at
      all, since `customer_id` is still `NOT NULL` until then, so there is no scenario where running
      `0013` first would let a customerless case reach `Quoted` "before `0012`'s invariant is in
      place" - both invariants are independent.) `scripts/apply-migrations.mjs` simply applies
      pending files in filename order, so `0012` runs first because it is numbered first.
  - After it applies, check: `select count(*) from public.cases where customer_id is null;` should be
    `0` immediately after this migration (it does not touch existing rows - only new customerless
    cases created afterward will have `customer_id is null`), and
    `select count(*) from public.cases where (stage = 'Quoted' or outcome = 'Won') and customer_id is null;`
    must always return `0` from here on, enforced by the new CHECK constraint itself.

## 3. Existing-data cleanup: review the cleared holders

`0012` silently reassigns work away from people mid-migration. Anyone who currently holds the
ticket on a Quoted case loses that ticket the moment this migration runs, with no notification
built into the migration itself.

- [ ] Immediately after `0012` applies, run:
      `select who, entity as case_id, customer_id, created_at from public.activity_log where action = 'CASE_QUOTED_HOLDER_CLEARED' order by created_at;`
      and export the result. This is the full list of affected cases and their prior holder.
- [ ] For every distinct holder in that list, notify them directly (Slack/email, not just "check the
      CRM") that the ticket they held on that specific case was cleared because Quoted cases no
      longer carry a holder by design, and that if the case needs further work it must go through
      Mark Revision (pick "Revision" in the case's Stage dropdown), which will explicitly reassign
      a holder again.
- [ ] Keep the exported list. It is the only record of who held what before the cleanup - once
      cleared, the original `assignee` value is not recoverable from `public.cases` itself (see
      Rollback, below).

## 4. Coordinated deploy note

The `0013` schema change (nullable `cases.customer_id`) and the frontend that renders
`Customer not mapped` must ship in the same deploy - they are two halves of one contract and
neither one is safe alone:

- If `0013` runs (customer_id nullable in the DB) but the **old** frontend deploys first/still runs
  against it: the old client code assumes every case DTO carries a real customer object and reads
  fields off it unconditionally. A customerless case's `customer: null` response would either throw
  in the render path or silently show a broken/empty customer block instead of the intended
  `Customer not mapped` label - this is a live bug window, not a cosmetic one.
- If the **new** frontend deploys first but `0013` has not run yet: the server still enforces
  `customer_id NOT NULL`, so any attempt by the new UI to create a customerless case (an empty
  `customerId` to `createCase`, or `customerLater: true` on quick log) fails with a database
  constraint violation surfaced as a generic save error, confusing users who see a "New case without
  a customer" affordance in the UI that then fails every time they use it.
- Deploy both together (`0013` migration and the app build containing the customerless-case UI) in
  one release window, and treat a partial deploy as an incident to roll forward from quickly, not a
  state to leave running.

## 5. Post-deploy manual verification

Perform these in the live app as a real user at each described role level, in order:

1. **Quoted has no ticket holder.** Open an existing case that has an active ticket holder, move it
   through to Quoted (or open a case already sitting in Quoted). Confirm: no assignee/ticket holder
   is shown, the reassignment/"working on" action is unavailable, and case owners are still listed
   and unchanged from before the stage move.
2. **Mark revision assigns a holder and returns to Quoted when Sent.** From that same Quoted
   case, pick "Revision" in the Stage dropdown and click Update stage. Confirm the dialog requires
   picking an active ticket holder before it can be confirmed, and canceling the dialog leaves the
   case in Quoted with no holder and no
   activity-log entry. Confirm it, and check: the case is now in Revision with the selected person as
   holder. Prepare and save a revised quotation, mark it Sent, and confirm the case returns to Quoted
   with the holder cleared again - matching the original Quoted state.
3. **Register a customerless lead and map it by saving the first quotation.** As an L2+ user, create
   a new Lead or Opportunity without selecting a customer (use the "customer later" option on
   quick-create, or leave the customer field unset if creating manually). Confirm: the case saves,
   the case detail page shows `Customer not mapped` (not a broken link or blank field), and the
   creator is listed as owner. As the same user (or another with access), open the quote builder or
   upload flow on that case, pick a real accessible customer, and save the first quotation. Confirm:
   the save succeeds, the case now shows the selected customer as mapped, and the quotation is
   attached to the case. Then attempt to save a second/different customer's quote against the same
   case (e.g. by trying to change the target customer) and confirm it is rejected as "That case
   belongs to a different customer" rather than remapping.
4. **Existing mapped cases are unaffected.** Open several pre-existing cases that already had a
   customer before this deploy. Confirm their customer, owners, assignee, and quote history render
   exactly as before - no regressions from the nullable-customer schema change on cases that were
   never customerless in the first place.

## 6. Rollback

If a problem appears after deploy:

- **Application code**: redeploy the previous Vercel production deployment (`npx vercel rollback` or
  re-promote the prior deployment from the Vercel dashboard). This is fully reversible and safe at
  any time.
- **`0013` (nullable customer_id)**: reversible in principle if no customerless case has been created
  yet - `alter table public.cases alter column customer_id set not null` would succeed only while
  every row still has a non-null `customer_id`. Once even one customerless case exists and has not
  been mapped, this rollback is blocked until that case is either mapped or deleted. Treat rolling
  `0013` back as unlikely to be clean once the feature has been used in production for any length of
  time.
- **`0012` (Quoted-holder cleanup and constraint)**: the constraint itself
  (`cases_quoted_unassigned_check`) can be dropped at any time
  (`alter table public.cases drop constraint cases_quoted_unassigned_check;`), which is reversible.
  **The cleared holder data is not.** `0012` set `assignee = null` on every affected Quoted case as
  part of applying the migration - there is no column preserving the prior value, so dropping the
  constraint afterward does not restore who held those tickets. The `CASE_QUOTED_HOLDER_CLEARED`
  activity-log rows exported in step 3 above are the only surviving record of the pre-migration
  holder for each affected case. If a rollback is needed after real usage, restoring holders means
  manually re-assigning each case from that exported list, not a database rollback.
- Because of the above, do not treat "we can always roll back" as a reason to skip the pre-deploy
  backup restorability check (step 1) or the affected-holder review (step 3) - those are the actual
  safety net for this feature, not the migration rollback itself.
