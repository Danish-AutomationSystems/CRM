# Ticket Handover Notes — Design Spec (2026-08-14)

## Context

A "ticket" in this CRM is the `cases.assignee` field — who is currently working a
case, which is deliberately separate from who owns it. Any CRM user can hold a
ticket; ownership is unchanged by reassignment.

Today, reassigning a ticket is information-free. `assignTicket`
(`src/server/cases/service.ts:565`) sets `cases.assignee` and logs a single
`activity_log` row whose details read `Working on -> <Name>`. The person picking
the ticket up learns who had it, and nothing about what was done or why it moved.

The project owner wants the person giving up a ticket to be able to attach an
optional note explaining the handover, and for that note to appear in the case
history alongside the reassignment it belongs to.

### Existing precedent

`setCaseStage` (`src/server/cases/service.ts:434`) already accepts an optional
`note` and folds it into the activity details:

```ts
details: `${row.stage || '-'} -> ${stage}${asText(note) ? ` - ${asText(note)}` : ''}`
```

This spec deliberately does **not** copy that pattern — see "Storage" below for
why — but it establishes that "action plus optional note" is an accepted shape in
this codebase.

## Decisions

Taken during brainstorming with the project owner:

| # | Decision | Rationale |
|---|---|---|
| 1 | The note is an **internal handover note** written by the person reassigning. | Owner's choice, from three candidate meanings. Not customer-facing, not a general comment thread. |
| 2 | Stored in **its own column on `activity_log`**, not appended to the details string. | Owner's choice. Keeps the note separately readable and renderable, and a note containing a dash cannot be misread as part of the reassignment text. |
| 3 | Shown in case history **and** as the latest note near the top of the case page. | Owner's choice. Whoever receives the ticket may never open history; the note only has value if it is read. |
| 4 | Notes are **immutable**. | Controller decision. `activity_log` is an audit trail and nothing else in it is editable; making one row type editable would be a new and unjustified capability. |
| 5 | Cap of **2000 characters**, multiline. | Controller decision. Long enough for a real handover, short enough that `activity_log` — already the fastest-growing table in the system — cannot be used as a document store. |
| 6 | The note is **optional**. Reassigning without one behaves exactly as today. | Owner's explicit requirement. |
| 7 | No new access rules. Anyone who can already see the case sees the note. | Follows the existing history, which is already gated by `loadVisibleCase`. |

## Architecture

### Storage

New migration `supabase/migrations/0009_activity_log_note.sql`:

```sql
alter table public.activity_log
  add column if not exists note text not null default '';
```

Additive only. There are **four separate `logActivity` implementations** in this
codebase, each with its own INSERT statement:

- `src/server/cases/repository.ts:428`
- `src/server/customers/repository.ts:531`
- `src/server/quotes/repository.ts:507`
- `src/server/admin/service.ts:1045`

Because the column carries a default, the three that are not changing remain
valid without modification. Only the cases implementation writes the new column.

### Why a dedicated query for the case-page note

`listActivityByEntity` (`src/server/cases/repository.ts:371`) is capped at
`limit 40`. On a busy case, the last reassignment can fall outside that window,
so deriving the latest note from the history already in memory would make it
**silently disappear** on exactly the cases that see the most activity.

A dedicated lookup is always correct:

```sql
select note
from public.activity_log
where entity = $1 and action = 'CASE_ASSIGN' and note <> ''
order by created_at desc
limit 1
```

It is served by the existing `activity_log_entity_idx` and needs no new index.

**It costs no additional wall-clock.** `getCase` already issues three queries
inside one `Promise.all` (`src/server/cases/service.ts:583-587`); this joins that
batch and resolves in parallel. That matters here specifically because compute is
in Mumbai and the database is in Tokyo, so every serial round trip costs roughly
90 ms.

### Code touch points

| File | Change |
|---|---|
| `supabase/migrations/0009_activity_log_note.sql` | New. The column. |
| `src/server/cases/repository.ts` | `CaseActivityLogEntry` gains `note`; `logActivity` writes it; `listActivityByEntity` selects it; new `latestHandoverNote(caseId)`. |
| `src/server/cases/service.ts` | `assignTicket` accepts and validates the note; `getCase` returns the latest note and includes it per history row. |
| `src/server/cases/rpc.ts` | `api_assignTicket` passes a third argument through. |
| `docs/source-appscript/Index.html` | Textarea in the reassign modal; `doAssign` sends it; history renders the note; case page shows the latest note. |

Untouched: `customers/`, `quotes/`, `admin/`, the dashboard, ownership logic, and
the three other `logActivity` implementations.

### Client

`mAssignCase`'s modal (`Index.html:1500-1512`) gains a labelled optional
textarea. `doAssign` (`:1528`) sends its value as the third RPC argument.

History rendering (`:1472`) currently emits one line of details per entry. When
`note` is non-empty it gains a second, visually distinct line beneath.

The case page header (`renderCase`, `:1403`) gains a "Latest handover note" block
below the existing Owners / Assigned-to line, rendered only when a note exists.

All client changes go through `docs/source-appscript/Index.html` and are
regenerated with `node scripts/port-legacy-index.mjs`.
`src/app/crm/legacy-full.generated.ts` is never hand-edited.

## Testing

- `assignTicket` with a note stores it on the activity row.
- `assignTicket` with no note behaves **byte-identically** to today — same
  details string, empty note, no behavioural change.
- A note over 2000 characters is rejected before any write.
- A note is still returned by `getCase` when more than 40 later activity entries
  exist on the case. This is the regression test for the `limit 40` window
  problem the dedicated query exists to solve.
- Reassigning a closed case is still refused, note or not.
- Whitespace-only notes are treated as no note.
- Client: the reassign modal sends the note; history renders it; the case page
  shows the latest one; a case with no notes renders exactly as before.

### Column-parity guard

A parity test for `activity_log`, mirroring the one added to
`src/server/quotes/repository.test.ts`, asserting the `logActivity` INSERT's
column list covers what the read queries select.

This is deliberate and specific. The defect that nearly shipped in the previous
piece of work was an INSERT that silently omitted columns declared
`not null default ''` — it succeeded, wrote empty strings, raised no error, and
was invisible to a test suite that substituted an in-memory fake for the
repository. **This migration creates that exact same shape**, so the same trap is
present and must be guarded rather than re-learned.

## Known risks

1. **`activity_log` is the fastest-growing table in the system** — roughly 80% of
   all structured growth per `docs/scalability-report-2026-08.md`. Handover notes
   add to that. The 2000-character cap bounds the worst case, and notes are
   optional and expected to be occasional, so the effect should be small — but
   this table remains the right first candidate for a retention policy, which is
   already a recorded follow-up.
2. **Four `logActivity` implementations is itself a smell.** This spec does not
   consolidate them, because doing so would touch the customers, quotes and admin
   paths for no benefit to this feature. Recorded as a possible future cleanup.
3. **The note is only as useful as it is read.** Decision 3 puts it on the case
   page for that reason, but nothing notifies the receiving user. Notification is
   explicitly out of scope.

## Explicitly out of scope

- Editing or deleting a note after it is written.
- Notes on any action other than reassignment.
- Customer-visible notes.
- Notifying the user who receives the ticket.
- Consolidating the four `logActivity` implementations.
- Backfilling notes onto historical reassignments.
