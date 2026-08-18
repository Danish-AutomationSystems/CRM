# Form Placeholder Removal — Design Spec (2026-08-18)

## Context

The project owner's manager wants example and placeholder text out of the CRM's form
fields. There are **21** `placeholder=` attributes in `docs/source-appscript/Index.html`.

The owner was shown the trade-off — that some placeholders are functional hints and two are
paste-format guides without which bulk import is guesswork — and chose **every placeholder,
no exceptions**.

## Decision

Remove all 21 `placeholder=` attributes.

**One thing does not simply disappear.** The two bulk-import paste boxes carry the expected
column order:

```
ABC Industries\tPunjab\tOEM\tHigh\tLudhiana
Rajesh Kumar\tPurchase Manager\t98140xxxxx\trajesh@abc.com
```

Delete that with nothing in its place and a user pasting an Excel range has no way to know
which column is which — the import silently maps every column wrong and writes bad data to
every row it touches. That is a data-integrity regression dressed as a cosmetic change.

So the column order moves **out of the placeholder attribute and into a visible hint line
above the textarea**, using the existing `.hint` class already used throughout the file. The
requirement is satisfied literally — no `placeholder` attribute remains anywhere — and the
guidance is more visible than before, not less.

## Scope

| Category | Count | Action |
|---|---|---|
| `e.g. …` examples | 8 | Delete outright |
| Search-box hints | 4 | Delete outright |
| Field labels used as placeholders (`Customer name`, `username`, `filter`, `enter manually`) | 4 | Delete outright |
| Handover-note prompt | 1 | Delete outright |
| Outcome-note conditional (`e.g. lost to competitor on price` / `e.g. on hold pending budget`) | 1 | Delete outright, including the now-dead conditional expression |
| Bulk-import format guides | 2 | Delete the attribute; add the same text as a `.hint` line above the field |
| Remaining | 1 | Delete outright |

The outcome-note case is a ternary embedded in a template string. Removing the placeholder
makes the branch dead; delete the whole expression rather than leaving `''+(cond?'':'')+''`.

## Where the work happens

All edits go in `docs/source-appscript/Index.html`, then
`node scripts/port-legacy-index.mjs` regenerates `src/app/crm/legacy-full.generated.ts`.
**The generated file is never hand-edited.**

## Non-goals

- No change to any label, `.hint` line, or help text that is not a `placeholder` attribute.
- No layout, styling, or field-order changes.
- No server change. No migration.

## Testing

- A source-level guard asserting `docs/source-appscript/Index.html` contains **zero**
  `placeholder=` attributes. This is what stops one creeping back in, and it is the only
  test that can state the requirement directly.
- A guard asserting the bulk-import hint text is present in the source, so the compensating
  hint cannot be dropped later by someone tidying up.
- The existing generator guard (`new Function(legacyAppScript)` does not throw) must still
  pass — the outcome-note edit removes a ternary from inside a template string, which is
  exactly the shape that has broken generation before.
- Existing Playwright tests must pass unchanged. Any test locating a field **by its
  placeholder** will break; such a test must be re-anchored to a label, id, or role — not
  fixed by keeping the placeholder.

## Risks

1. **A Playwright or unit test selects an element by placeholder.** Must be re-anchored, not
   accommodated. Checked during implementation.
2. **Accessibility.** Removing a placeholder is only a problem where it was the field's sole
   description. Every field here has a `<label>`, so no field is left unlabelled. Verified
   per field during implementation; any field found without a label gets one rather than
   keeping its placeholder.
