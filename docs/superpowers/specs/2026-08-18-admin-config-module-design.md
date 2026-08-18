# Admin Config Module — Design Spec (2026-08-18)

## Context

The Admin panel offers editable lists for Customer Locations, Customer Types, Priorities,
Won Order Categories and Case Sources. **Editing them changes nothing.** The owner reported
that added values never appear in any dropdown and are absent when creating a case.

This is not a new bug. It is recorded in `CONTEXT.md` under *"Known Issue: `public.settings`
is write-only from the app's perspective"*, dated 2026-08-11, and never fixed.

## Root cause

`api_admin_saveSettings` (`src/server/admin/service.ts:521`) writes `TAGS`, `TYPES`,
`PRIORITIES`, `CATEGORIES`, `SOURCES`, `TAX_PCT`, `CURRENCY` and `COMPANY` into
`public.settings`. The write succeeds and round-trips through the admin service's own read
path, which is used only by the CSV bulk-import flows.

Every other consumer imports the hardcoded `DEFAULT_SETTINGS` constant from
`src/server/settings/defaults.ts` and never reads the table:

- `dashboard/service.ts:261-273` — `bootstrap()`, which builds the `settings` block the
  entire client uses to render **every dropdown**.
- `customers/service.ts` — `validTags` (`:239`), `validOne` for type and priority (`:384`).
- `cases/service.ts` — `validTags` (`:231`), `validCategories` (`:237`), `validOne` for
  priority and stage.

So an admin's edit is saved and then ignored, by design of the read path. One exception
already exists: `SEI_NAMES` is read live via `repo.getSetting(SEI_NAMES_SETTING_KEY)`
(`customers/service.ts:246`), added during the P8 work specifically to avoid reproducing
this bug. **That exception is the pattern this spec generalises.**

## Decisions

Taken with the project owner:

| # | Decision | Notes |
|---|---|---|
| 1 | Config lists become **live** — read from `public.settings`, not from the constant. | The actual bug fix. |
| 2 | Each card becomes **item-level**: rows with edit and delete, plus an add field. | Owner's requirement. |
| 3 | **Renaming propagates.** Punjab → PUN rewrites every record holding "Punjab". | Owner's requirement. |
| 4 | **Deleting does not propagate.** Existing records keep the value; it stops being offered. | Owner's requirement. |
| 5 | Delete takes effect **without a confirmation prompt**. | Owner's choice, against the recommendation to show usage counts and confirm. No undo exists. |
| 6 | The **Case Sources** card is removed. | Owner's requirement; independently verified dead — see below. |
| 7 | A **SEI Names** card is added. | Owner's requirement. The setting already exists and is already read live; only the UI is missing. |

## Case Sources is genuinely dead

`srcOptions()` (`Index.html:1297`) builds a source dropdown and has **zero callers**. The
only other references to `sources` in the client are the admin card that edits the list.
`cases.source` is still written as `''` by `quickLog` and accepted by `createCase`, but no
UI ever supplies it.

So: remove the card, remove `sources` from the `bootstrap()` payload, delete `srcOptions()`.
**The `cases.source` column and its service plumbing stay** — dropping a column is a
separate, irreversible decision, and old rows may hold values. This spec removes the
configuration surface, not the data.

## Architecture

### Live settings

A single reader in `src/server/settings/live.ts`:

```ts
export type LiveSettings = { …the list and scalar keys… };
export async function loadSettings(repo: SettingsReader): Promise<LiveSettings>;
```

- Reads all setting rows in **one** query, not one per key.
- Falls back to `DEFAULT_SETTINGS` **per key** when a row is missing or blank, so a partially
  seeded database still boots. `SEI_NAMES` is exempt from the fallback: it may legitimately
  be empty, and defaulting it would resurrect names an admin deleted.
- Cached **per request**, not process-wide. A process-wide cache on serverless means one warm
  Vercel instance serves stale config while another serves fresh, which is worse than no
  cache because it is intermittent. Request scope makes a save visible on the very next
  request with no invalidation protocol.

`DEFAULT_SETTINGS` becomes **seed-only**: what `defaultSettingRows()` writes into a fresh
database, and the per-key fallback above. No request-path code reads it directly. Enforced
by a test, since a new `DEFAULT_SETTINGS.X` import is exactly how this bug returns.

`STAGES`, `OUTCOMES`, `QUOTE_STATUSES` and `ROLES` stay hardcoded and stay out of the admin
panel. `cases.stage` carries a database CHECK constraint
(`stage in ('Lead','Opportunity','Quoted')`, `0001_initial_schema.sql:70`), so renaming a
stage would fail the constraint outright. Making those admin-editable requires a migration
and is out of scope.

### Storage stays as it is

Values remain pipe-joined strings in `public.settings`. A `config_items` table is the
textbook answer and is **rejected**: the lists hold roughly twenty items, the bulk-import
flows already read the settings row, and a second representation would have to be kept in
sync with the first. Item-level editing is a UI affordance; it does not require item-level
storage.

### Rename propagation

The client sends an explicit `{ key, oldValue, newValue }`. **The server does not diff two
lists** — a diff cannot distinguish a rename from a delete plus an add, and guessing wrong
either corrupts data or silently fails to propagate.

One transaction per rename, updating the settings row and every column holding the value:

| Config key | Columns rewritten |
|---|---|
| `TAGS` | `customers.tags[]`, `users.allowed_tags[]`, `recycle_bin.tags[]` |
| `TYPES` | `customers.type`, `recycle_bin.type` |
| `PRIORITIES` | `customers.priority`, `cases.priority`, `recycle_bin.priority` |
| `CATEGORIES` | `cases.won_categories` (pipe-joined text) |
| `SEI_NAMES` | `customers.sei[]`, `recycle_bin.sei[]` |

Three of these deserve individual attention:

**`users.allowed_tags` is access control.** Locations gate who can see which customers. Rename
Punjab to PUN without rewriting `allowed_tags` and every user granted Punjab silently loses
access to those customers. This column is the reason rename propagation cannot be
best-effort. The `'*'` wildcard entry must be left untouched, and
`users_star_tag_check` (`0001:15`) forbids `'*'` alongside any other tag — a rewrite must not
be able to violate it.

**`cases.won_categories` is a pipe-joined string, not an array.** Rewriting it means split on
`|`, replace exact matches, rejoin. A naive `replace()` on the whole string would corrupt any
category that is a substring of another — the live list contains both `Panels` and
`Switchgear`, and `Others` contains `Other`.

**`recycle_bin` holds soft-deleted customers** that `restoreCustomer()` copies back onto
`public.customers`. Skipping it means a restore silently reintroduces a stale value.

Renames are **exact-match and case-sensitive**. Renaming to a value that already exists in
the same list is rejected — merging two config values is a different operation with different
data consequences and is out of scope.

### Deletes

Remove from the settings row. Touch nothing else.

For this to be true in practice, validation must change. Today `validOne` and `validTags`
strip any value not in the current list, so after deleting Punjab, saving an unrelated field
on a Punjab customer blanks its location — and location is mandatory (`requiredTags`,
`customers/service.ts:251`), so the save then fails or the data is lost.

**New rule: a value is acceptable if it is in the current list, or if it is unchanged from
what is already stored on that record.** Retired values survive edits; they are never
offered on any other record. This is what makes decision 4 true through an edit, not just at
rest.

`TO BE FILLED` remains system-owned: never listed in the admin UI, never editable, never
deletable, never offered as a choice. It is the location-backfill placeholder from migration
0007, and `validTags` must keep recognising it or every backfilled customer re-empties on its
next save.

### Client

The admin panel keeps its card layout. Each list card renders one row per item with an inline
edit control and a delete control, plus an add field. Three RPCs replace the current
save-the-whole-textarea call:

- `api_admin_addConfigItem(key, value)`
- `api_admin_renameConfigItem(key, oldValue, newValue)`
- `api_admin_deleteConfigItem(key, value)`

All admin-only (`ensureAdmin`), all `{ read: false }`. The existing
`api_admin_saveSettings` stays for the scalar fields (GST, currency, company).

Because renames rewrite business data, each of the three is a distinct operation with a
distinct audit entry in `activity_log`, rather than one opaque "settings changed".

After a successful mutation the client re-fetches bootstrap and busts its settings cache, so
the editing admin sees the change immediately. **Other users' browsers hold their
bootstrap payload until they next navigate** — a known, accepted staleness window, not a
correctness problem, since the server validates against live settings on every write.

All client changes go through `docs/source-appscript/Index.html` and are regenerated with
`node scripts/port-legacy-index.mjs`. The generated file is never hand-edited.

## Testing

- `loadSettings` returns stored values, falls back per key when a row is missing, and does not
  fall back for `SEI_NAMES`.
- A guard test asserting no request-path module imports `DEFAULT_SETTINGS` for a config list.
  This is the regression guard for the original bug.
- An added value appears in the `bootstrap()` payload; a deleted one does not.
- Rename rewrites every column in the table above. One test per column, including
  `users.allowed_tags`, and one asserting `'*'` is left untouched.
- `won_categories` rename does not corrupt a neighbouring category (`Other` / `Others`, and
  `Panels` / `Switchgear` as substring cases).
- Rename is transactional: an induced failure part-way leaves **no** column rewritten and the
  settings row unchanged.
- Rename to an existing value is rejected.
- Delete removes from the list and changes no record.
- **After a delete, editing an unrelated field on a record still holding the retired value
  preserves it.** This is the test that makes decision 4 real.
- `TO BE FILLED` is absent from the admin list and cannot be deleted or renamed.
- Non-admins are refused by all three RPCs, and the refusal does not reveal the current list.

## Known risks

1. **Rename rewrites business data across up to three tables.** It is transactional and
   tested per column, but it is the first operation in this CRM where an admin action mutates
   customer and case rows in bulk. There is no undo beyond a database restore.
2. **`users.allowed_tags` participates.** A defect here is an access-control defect, not a
   cosmetic one.
3. **No usage counts and no confirmation on delete**, per decision 5. An admin cannot see
   what a value is holding up before retiring it.
4. **Cross-user staleness** until the next navigation, as described above.
5. **Deleting every value from a list** is prevented only for `TAGS` today
   (`admin/service.ts:527`). Emptying `TYPES` or `CATEGORIES` would leave a dropdown with no
   options. The add/delete RPCs must keep the existing at-least-one rule for `TAGS`; whether
   to extend it to other lists is called out rather than assumed — this spec keeps parity
   with today and does not add new restrictions.

## Explicitly out of scope

- Dropping the `cases.source` column or its service plumbing.
- Making stages, outcomes, quote statuses or roles admin-editable.
- Merging two config values into one.
- Usage counts, confirmation prompts, or undo for deletes.
- Reordering items within a list.
- A `config_items` table.
- Fixing cross-user staleness with push invalidation.
