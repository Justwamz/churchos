# Staff app style guide

Calm, modern, warm. White cards on a soft off-white page, deep navy for the one main action, plenty of air. The member app is the reference for mood.
All visual rules live in `../shell.css` (tokens at the top). Components here only add class names; never hard-code colours in a page.

## Convert a page in five steps

1. Replace the page's `PageHead` (from `../bits`) with `PageHeader`: title, one-line subtitle, the primary action in `actions`, status filters as `tabs`.
2. Put content in `Section` (titled block) containing `Card`s. A table that should touch the card edges: `<Card pad={false}>`.
3. Summary numbers: `StatTiles` with `Stat` children (2 to 6). Click-through numbers get `onClick`.
4. Filters/search above a list: `Toolbar`. Loading: `Skeleton` (not the spinner). Nothing to show: `EmptyState` with an icon and, if useful, an action.
5. Details of one row: `SidePanel` instead of a full modal. States: `StatusChip` with the right tone. Words for gatherings: `useWords()`.

Keep all data loading, permissions and API calls exactly as they are. Only the layout changes.

## Components (import from `'./ui'`)

| Component | Use it for |
|---|---|
| `PageHeader {title, subtitle?, actions?, tabs?, tab?, onTab?}` | Top of every page. One per page. Actions stack on a phone. |
| `Tabs {tabs, tab, onTab}` | Switching views inside a page (underline tabs, scroll sideways on a phone). `badge` shows a count. |
| `Section {title, hint?, action?}` | A titled block on the page background. Spacing between sections is built in. |
| `Card {pad?, onClick?}` | One white surface. Never nest a Card in a Card. |
| `StatTiles` + `Stat {label, value, hint?, tone?, onClick?}` | Summary numbers. tone: good, wait, bad, info. |
| `Toolbar {end?}` | Search, selects and chips above a list. Buttons that act on the list go in `end`. |
| `EmptyState {icon?, title, text?, action?}` | Friendly nothing-here block. |
| `Skeleton {lines?, height?, rows?}` / `PageSkeleton` | Loading placeholders (shimmer). |
| `StatusChip {tone}` | wait (amber, waiting), done (green), bad (red, problem), info (blue), off (grey, inactive). One meaning per colour. |
| `SidePanel {title, subtitle?, onClose, footer?, width?}` | Right-hand drawer (bottom sheet on a phone). Esc closes. Render only when something is selected. |

Icons: `import { Icon } from '../icons'` then `<Icon name="plus" size={20} />` (24px grid, 1.75 stroke, currentColor). See `icons.tsx` for the names.
Words: `import { useWords } from '../words'` then `const w = useWords()`: `w.one` ("Mass"), `w.many` ("Masses"), `w.oneLower`, `w.manyLower`. Use these in every label, title and sentence that says service(s) or gathering(s).
Opening another page: `useSession().go('members')`. To open Members with a name in its search: `setPrefill('members', 'Mary')` (from `../prefill`) then `go('members')`; a page receives such a value with `usePrefill('members', setQ)`.

## Tokens (CSS variables)

- Page background `--paper` #f6f5f1; card `--surface` white; hairlines `--line`, `--line-soft`.
- Text `--ink` (main), `--ink-2` (secondary), `--ink-3` (labels, hints).
- Accent (main buttons, active nav, links, selected chips) `--accent` #123456, hover `--accent-2`, soft background `--accent-tint`, text on it `--on-accent`.
- Teal `--brand` stays for brand and success touches; gold `--gold` sparingly. States: `--good/--warn/--bad/--info` and their `-tint`; neutral `--off`, `--off-tint`.
- Radius: cards 16px (`--r-card`), controls 12px (`--r-ctl`). Shadow `--shadow`; popovers `--shadow-pop`. Focus ring `--ring` (3px).
- Dark mode: the same tokens are redefined in `shell.css`. Use tokens and it just works.

## Type and spacing

Manrope everywhere. Page title 27px/700 (`h1`), section title 17-18px/700 (`h2`/`h3`), body 15px, small 13px (`.tiny`), field labels 12.5px/600 muted.
Spacing on an 8px grid: 8, 16, 24, 32. Between sections 28px, inside cards 20px, between tiles 14px.

## Controls (restyled globally, no changes needed)

Buttons 44px high, 12px radius: `Button` primary (solid navy), `kind="ghost"` (white, soft border), `kind="danger"` (soft red); `small` is 36px (34px pills inside tables).
Inputs 44px, 12px radius, 3px focus ring. Filters are `.chip` pills (`.on` = navy). Tables: no vertical lines, 52px rows, sticky header, hover tint.
Old modals (`.modal-scrim` / `.modal`) are a centred 560px sheet, a bottom sheet on a phone, with a sticky head and close x. Prefer `SidePanel` for new work.

## Do and do not

- Do one primary action per screen; make everything else ghost.
- Do write short calm sentences. Say what to do next ("Add your first member"), not "No data".
- Do keep touch targets at 44px on phones, and check every page at 390px wide.
- Do not use a table of 9 columns on a phone: stack as cards (see `attendance.css` `.at-table` for the pattern).
- Do not add new colours, fonts, or shadows. Do not use emoji as icons.
