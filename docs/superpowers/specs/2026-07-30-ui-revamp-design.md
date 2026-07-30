# AS CRM — Frontend UI Revamp Design

**Date:** 2026-07-30
**Scope:** CSS overhaul + minimal generator tweaks. Frontend-only — no changes to server code, RPC handlers, database schema, or business logic.
**Goal:** Make the CRM responsive, visually modern, and premium-feeling across all screen sizes while preserving 100% feature parity.

---

## Constraints

1. **No backend changes.** The RPC layer (`/api/rpc`), server modules (`src/server/*`), database schema, and middleware are untouched.
2. **No business logic changes.** The `legacy-full.generated.ts` behavior (navigation, data flow, caching, optimistic editing, access model) must remain identical.
3. **Generator-auditable.** Any HTML structure changes go through `scripts/port-legacy-index.mjs` so the generated file stays reproducible from `docs/source-appscript/Index.html`.
4. **Incremental & safe.** The existing `legacy-full-ui.css` stays as a fallback; the new CSS layers on top using specificity or replaces it in a controlled swap.
5. **Other agents.** This workspace has concurrent agents — `CONTEXT.md` must be updated after every meaningful change.

---

## Strategy

**Approach: CSS Overhaul + Generator Tweaks**

- Create a new `crm-modern.css` with modern responsive styles targeting the existing class names (`.hwrap`, `.card`, `.stat`, `.btn`, etc.)
- Modify `legacy-full-ui.css` in-place (or replace it) with the modernized stylesheet
- Make surgical tweaks to `scripts/port-legacy-index.mjs` to add:
  - Responsive wrapper `<div>` elements where needed
  - ARIA landmark attributes for accessibility
  - Viewport-friendly attributes
- Update the login page React component directly (already proper React/TSX)
- Update `globals.css` and `layout.tsx` for proper font loading and base styles

---

## Design System

### Typography

```
Font stack (unchanged):
  --body: 'Inter', sans-serif
  --disp: 'Space Grotesk', sans-serif  
  --mono: 'IBM Plex Mono', ui-monospace, monospace

Type scale (new):
  --fs-xs:   11px
  --fs-sm:   12.5px
  --fs-base: 14px
  --fs-md:   15px
  --fs-lg:   17px
  --fs-xl:   22px
  --fs-2xl:  28px
  --fs-3xl:  36px
```

### Spacing

4px grid system:
```
--sp-1: 4px    --sp-2: 8px    --sp-3: 12px   --sp-4: 16px
--sp-5: 20px   --sp-6: 24px   --sp-7: 28px   --sp-8: 32px
--sp-10: 40px  --sp-12: 48px  --sp-16: 64px
```

### Colors

Refine the existing green brand palette with HSL-tuned variants:
```
--deep:      #0F231B       (header background — unchanged)
--paper:     #F5F7F6       (page background — slightly warmer)
--card:      #FFFFFF       (card background — unchanged)
--brand:     #1E8A52       (primary green — unchanged)
--brand-dk:  #15703F       (primary dark — unchanged)
--brand-lt:  #E7F5ED       (primary light tint — new)
--brand-glow: rgba(30, 138, 82, 0.12)  (focus rings — new)
--tint:      #E7EFE9       (tag background — unchanged)
--ink:       #17251E       (text — unchanged)
--muted:     #5C6E64       (secondary text — unchanged)
--line:      #DEE5E0       (borders — unchanged)

Status colors (unchanged):
--amber, --amber-bg, --red, --red-bg, --blue, --blue-bg
```

### Radius

```
--r-sm: 6px     (inputs, small buttons)
--r-md: 10px    (cards, panels)
--r-lg: 14px    (modals)
--r-pill: 100px (badges, pills)
```

### Shadows

```
--shadow-sm: 0 1px 3px rgba(15, 35, 27, 0.06)
--shadow-md: 0 4px 12px rgba(15, 35, 27, 0.08)
--shadow-lg: 0 8px 28px rgba(15, 35, 27, 0.12)
--shadow-xl: 0 18px 50px rgba(15, 35, 27, 0.18)
```

### Transitions

```
--ease-out: cubic-bezier(0.16, 1, 0.3, 1)
--duration-fast: 150ms
--duration-normal: 250ms
--duration-slow: 400ms
```

---

## Section 1: Header & Navigation

### Current Issues
- Navigation wraps awkwardly on mid-size screens
- No hamburger menu on mobile
- User chip layout breaks on small screens

### Changes
- **Sticky header** with `position: sticky; top: 0` (already nearly there)
- **Backdrop blur** on header: `backdrop-filter: blur(12px)` with slightly transparent background
- **Navigation buttons:** smoother hover/active transitions, larger touch targets (min 44px height on mobile)
- **Mobile (≤720px):**
  - Generator adds a hamburger toggle `<button>` in the header
  - Nav slides down as a full-width stack with `max-height` transition
  - User chip moves below brand, smaller footprint
- **Brand mark:** slightly larger (34px → 36px), cleaner border radius
- **Role badge:** pill shape, better font sizing

### Generator Changes (header)
- Add a hamburger button element before `<nav>` (hidden on desktop via CSS)
- Add `onclick` to toggle a CSS class on nav for mobile expand/collapse
- Add `aria-label` to nav element

---

## Section 2: Dashboard

### Current Issues
- Stat cards lack visual weight
- Timeline is minimal
- No visual differentiation between value types

### Changes
- **Stat cards:** 
  - Subtle left-border accent (4px solid with color per card type)
  - Hover: lift with shadow transition
  - Number: larger font (28px → 32px), green tint for positive values
  - Mobile: 2-column grid → 1-column below 480px
- **Opportunity tickets section:**
  - Each ticket row: subtle left-border based on stage color
  - Better spacing between customer name and stage chip
  - Reassign button: ghost style with hover transition
- **Recent activity timeline:**
  - Timeline dots: smooth pulse animation on newest entry
  - Better typography hierarchy (who/when vs. details)
  - Alternating subtle background on items
- **"Whose dashboard" selector:** styled as a proper select with custom arrow

---

## Section 3: Customer Grid (The Big One)

### Current Issues
- Table is not usable on phones — forces horizontal scroll with no indication
- Filter row takes too much vertical space
- Zero-contacts highlight is too subtle
- Inline editing has no visual feedback until save completes

### Changes
- **Desktop (>720px):**
  - Zebra-striped rows with subtle alternating background
  - Sticky header row (already has `position: sticky` via `.fr th`)
  - Horizontal scroll container with gradient fade on edges to indicate more content
  - Filter row: compact styling, smaller font
  - Inline edit cells: on focus, subtle green border glow; on save, brief green flash; on error, red flash
  - Zero-contacts: more prominent red pill with icon indicator
- **Mobile (≤720px):**
  - Each table row becomes a **stacked card** via CSS:
    ```css
    @media (max-width: 720px) {
      table.grid thead { display: none; }
      table.grid tr { display: block; border: 1px solid var(--line); border-radius: 10px; padding: 12px; margin-bottom: 10px; }
      table.grid td { display: flex; justify-content: space-between; padding: 4px 0; border: none; }
      table.grid td::before { content: attr(data-label); font-weight: 600; color: var(--muted); }
    }
    ```
  - Generator adds `data-label` attributes to `<td>` elements so the mobile card layout shows field names

### Generator Changes (customer grid)
- Add `data-label="Name"`, `data-label="Tag"`, etc. attributes to each `<td>` in the customer grid rendering functions
- Wrap the table in a `<div class="table-scroll">` for horizontal scroll indicators on desktop

---

## Section 4: Cases List

### Current Issues
- Similar table responsiveness problems as customer grid
- Filter bar is functional but not polished

### Changes
- Same mobile card-stack treatment as customer grid (with `data-label`)
- Filter bar: flex layout with better wrapping, search input with icon
- Case rows: stage chip and outcome chip more prominent
- Value column: styled with monospace font and green for won values

---

## Section 5: Customer Detail Page

### Current Issues
- Dense layout with too many sections visible at once
- Key-value grid doesn't breathe

### Changes
- **Key-value grid (`.kv`):** wider label column on desktop (160px), better row spacing
- **Contacts section:** each contact as a card with hover effect
- **Cases section:** each case row as a mini-card with stage indicator
- **Handlers section:** user avatars (initials in circles) + name
- **Breadcrumbs:** cleaner styling with chevron separators

---

## Section 6: Modals

### Current Issues
- No transition animation
- On mobile, modal can be too narrow or content overflows
- Close button is small

### Changes
- **Desktop:** centered with smooth `opacity + transform: scale(0.95→1)` transition
- **Mobile (≤720px):** modal goes full-screen (inset: 0, border-radius: 0 for top)
- **Backdrop:** smooth fade-in
- **Close button:** larger (36px), top-right position, cleaner icon
- **Footer buttons:** more spacing, primary button more prominent
- **Form fields inside modals:** better spacing with the spacing system

### Generator Changes (modal)
- Add CSS class for transition states
- No structural HTML changes needed — existing `#mwrap.on` toggle is sufficient

---

## Section 7: Form Controls

### Changes
- **Inputs/selects/textareas:** 
  - Consistent height (40px for inputs/selects)
  - Focus: green ring with `box-shadow: 0 0 0 3px var(--brand-glow)`
  - Placeholder text: lighter color
- **Buttons (`.btn`):**
  - Slightly larger padding (10px 18px)
  - Smooth hover transition (background color + transform: translateY(-1px))
  - Ghost variant: more distinctive border
  - Disabled: 50% opacity with `cursor: not-allowed`
- **Tag picker:** pill-style buttons with smooth color transition on toggle
- **Required fields:** cleaner asterisk with better color

---

## Section 8: Toast Notifications

### Changes
- Position: bottom-center (keep current) but with slide-up animation
- Larger font size (14px)
- Success: green left-border (keep)
- Error: red left-border + red background tint
- Smoother enter/exit transition

---

## Section 9: Login Page

### Changes (direct React/CSS edits)
- **Background:** subtle gradient or pattern (light green → white diagonal)
- **Card:** larger padding (48px), centered, subtle shadow
- **Brand mark:** larger, centered above title
- **Title:** larger, Space Grotesk display font
- **Button:** full-width, taller (48px), green with hover darkening, loading spinner animation
- **Error state:** proper alert box with red styling
- **Mobile:** full-width card with smaller padding

---

## Section 10: Responsive Breakpoints

```
Desktop:  > 1024px  — full layout
Tablet:   721-1024px — compact layout, 2-col stats
Mobile:   ≤ 720px   — stacked layout, hamburger nav, card-style tables
Small:    ≤ 480px   — 1-col stats, minimal spacing
```

---

## Section 11: Accessibility Improvements

- All interactive elements: visible focus outlines (not just box-shadow)
- Color contrast: ensure all text meets WCAG AA (4.5:1 for body text)
- ARIA landmarks on header, nav, main, modal
- `aria-expanded` on hamburger toggle
- `aria-modal="true"` on modal overlay
- Skip-to-main link (hidden, visible on focus)

---

## Files Changed

### New Files
- None planned — all changes in existing files

### Modified Files
- `src/app/crm/legacy-full-ui.css` — comprehensive modernization
- `src/app/login/page.tsx` — login page restyle
- `src/app/globals.css` — design system tokens
- `src/app/layout.tsx` — font preload link
- `scripts/port-legacy-index.mjs` — generator tweaks (data-label, hamburger, ARIA)
- `src/app/crm/legacy-full.generated.ts` — regenerated from updated generator

### Untouched Files
- All `src/server/*` files
- `src/app/api/*` route handlers
- `src/middleware.ts`
- `src/app/crm/LegacyFullCrmApp.tsx` (mount logic)
- `src/app/crm/CrmApp.tsx` (re-export)
- `src/app/crm/legacy-app.ts` (types/helpers)
- All test files (existing tests must still pass)

---

## Verification Plan

### Automated
```bash
npm run typecheck   # TypeScript compilation
npm run test        # Vitest unit tests  
npm run build       # Next.js production build
npm run test:e2e    # Playwright smoke tests
```

### Manual
- Visual inspection on desktop (1920px), tablet (768px), and phone (375px) viewports
- Verify all CRM features still work: navigation, customer search, customer grid editing, case creation, modal open/close, toast notifications
- Verify login page renders correctly
- Check that `legacy-full.generated.ts` can be regenerated by running `port-legacy-index.mjs`

---

## Risk Assessment

| Risk | Mitigation |
|------|-----------|
| CSS specificity conflicts | Layer new styles with higher specificity or use the cascade order |
| Generator changes break HTML structure | Changes are minimal (add attributes/wrappers only); regenerate and diff |
| Mobile card layout misaligns with inline editing | Keep editing as-is on mobile; the cell inputs still work in stacked layout |
| Other agents modify files concurrently | Check CONTEXT.md before and after each file edit |
| Performance regression from CSS complexity | Modern CSS is paint-only; no JS changes means no runtime cost |
