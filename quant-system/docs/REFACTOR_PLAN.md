# UI Refactor Plan

## Goal

Move the current UI from a patched technical dashboard to a professional B-side financial analysis backend.

Constraints:
- Do not change business logic.
- Do not change APIs.
- Do not change data structures.
- Do not rewrite the project.
- Reuse Next.js, React, TypeScript, CSS, and lucide-react.
- Make small staged changes.
- Verify after every stage.

Design reference:
- Use Futubull-style information architecture for watchlists, holdings, and news/research context.
- Use the local design system in `quant-system/docs/DESIGN_SYSTEM.md` as the implementation rulebook.

## Current UI Risks

1. Mixed visual systems
   - Homepage uses a light financial dashboard style.
   - Module pages use an older black industrial shell.
   - Navigation width changes across routes.

2. Overloaded global CSS
   - `app/globals.css` contains multiple historical design layers.
   - Later overrides depend on ordering, which makes changes risky.

3. Homepage still reads as technical
   - Diagnostics have been reduced but the page still has technical language and wide tables.
   - Watchlist, holdings, and news context are not yet first-class sections.

4. Tables are not yet financial-grade
   - Numeric alignment is inconsistent.
   - Status and risk display are not fully unified.
   - Long reasons can dominate rows.

5. Module pages are thin
   - Strategy, backtest, paper trading, research, review, and knowledge pages mostly render metric cards plus tables.
   - They need clearer module-specific layouts while staying inside the same shell.

## Stage 0: Documentation Baseline

Status: in progress.

Files:
- `quant-system/docs/DESIGN_SYSTEM.md`
- `quant-system/docs/REFACTOR_PLAN.md`

Scope:
- Define the design direction.
- Define component rules.
- Define refactor phases and verification gates.

Verification:
- Docs exist.
- `npm run build` still passes.

## Stage 1: Token and Shell Unification

Purpose:
Unify the visual foundation without changing page behavior.

Files:
- `quant-system/frontend/app/globals.css`
- `quant-system/frontend/app/product-shell.tsx`
- `quant-system/frontend/app/page.tsx` only if shell class names need alignment

Scope:
- Introduce `--qs-*` tokens from the design system.
- Map old `--q-*` variables to `--qs-*` tokens.
- Remove or neutralize black industrial defaults from ProductShell pages.
- Make navigation width and page background consistent across homepage and module pages.

Non-goals:
- Do not redesign tables yet.
- Do not reorder dashboard data yet.
- Do not touch backend or data-loading code.

Verification:
- `npm run build`
- Desktop: `/`, `/strategies`, `/backtests`, `/paper`, `/research` share the same light shell.
- Mobile: no body horizontal overflow.

## Stage 2: Shared UI Primitives

Purpose:
Create reusable UI classes/components before replacing module screens.

Files:
- `quant-system/frontend/app/product-shell.tsx`
- `quant-system/frontend/app/globals.css`
- Optional: `quant-system/frontend/app/ui-primitives.tsx`

Scope:
- Add or formalize:
  - `StatusBadge`
  - `RiskBadge`
  - `KpiCard`
  - `SectionPanel`
  - `FinancialTable`
  - `ModuleHeader`
- Keep APIs simple and local.
- Use existing data props and React nodes.

Non-goals:
- Do not introduce a component library.
- Do not introduce Tailwind.
- Do not rewrite all pages in one pass.

Verification:
- `npm run build`
- Existing pages render with no missing styles.
- No primary view shows raw logs by default.

## Stage 3: Homepage Dashboard IA

Purpose:
Make the homepage behave like a financial operations dashboard.

Files:
- `quant-system/frontend/app/page.tsx`
- `quant-system/frontend/app/globals.css`

Target structure:
1. Market state strip
2. Trading gate / decision
3. Watchlist and upside radar
4. Exposure / paper holdings snapshot when available
5. Catalyst / news / research stream when available
6. Recommended candidates financial table
7. Compact diagnostics drawer

Scope:
- Reorder and relabel existing data only.
- Convert candidate display closer to Futubull-style watchlist rows.
- Keep diagnostics closed.
- Keep decision and risk above candidate table.

Non-goals:
- Do not change scoring.
- Do not change stock selection logic.
- Do not change report data shape.

Verification:
- `npm run build`
- Desktop first viewport shows decision plus watchlist/upside candidates.
- Mobile first viewport shows decision then watchlist/upside candidates.
- Diagnostics drawer remains closed by default.

## Stage 4: Financial Tables

Purpose:
Upgrade all key tables to financial-analysis quality.

Files:
- `quant-system/frontend/app/page.tsx`
- `quant-system/frontend/app/product-shell.tsx`
- `quant-system/frontend/app/*/page.tsx`
- `quant-system/frontend/app/globals.css`

Scope:
- Right-align numeric columns.
- Use tabular numerics.
- Use consistent stock cells.
- Use compact risk/action badges.
- Constrain long reason text.
- Keep local horizontal scroll inside table containers.

Priority:
1. Homepage recommendation table
2. Paper positions and orders
3. Strategy gate table
4. Backtest parameter table
5. Research and review tables

Verification:
- `npm run build`
- No page-level horizontal overflow on desktop or mobile.
- Candidate/position/order rows remain readable at 1440px and 390px widths.

## Stage 5: Paper Trading Layout

Purpose:
Make holdings and orders feel like a professional portfolio workspace.

Files:
- `quant-system/frontend/app/paper/page.tsx`
- `quant-system/frontend/app/trading-desk.tsx`
- `quant-system/frontend/app/globals.css`

Target layout:
- Account summary
- Exposure and risk status
- Positions table
- Orders table
- Order ticket / intervention area

Reference:
- Futubull-style holdings first, orders second, actions adjacent to context.

Verification:
- `npm run build`
- Positions and orders are visible without scrolling past unrelated content.
- Risk state is visible near exposure and order actions.

## Stage 6: Research and News Context

Purpose:
Turn research into a useful market context stream instead of a log-like table page.

Files:
- `quant-system/frontend/app/research/page.tsx`
- `quant-system/frontend/app/research/*.tsx`
- `quant-system/frontend/app/globals.css`

Scope:
- Add a research/news stream layout.
- Group by symbol or evidence type where data allows.
- Surface freshness, source, and risk implication.
- Keep raw evidence paths out of primary view.

Verification:
- `npm run build`
- Research page communicates what changed, what matters, and which symbols are affected.

## Stage 7: Strategy, Backtest, Review, Knowledge Polish

Purpose:
Bring secondary modules to the same level of consistency.

Files:
- `quant-system/frontend/app/strategies/page.tsx`
- `quant-system/frontend/app/backtests/page.tsx`
- `quant-system/frontend/app/reviews/page.tsx`
- `quant-system/frontend/app/knowledge/page.tsx`
- `quant-system/frontend/app/globals.css`

Scope:
- Keep shared shell.
- Add module-specific top summaries.
- Upgrade tables.
- Make blockers and next actions visually obvious.

Verification:
- `npm run build`
- Each module has a clear primary question and answer:
  - Strategy: what can run?
  - Backtest: what passed?
  - Review: what failed or needs action?
  - Knowledge: what coverage is missing?

## Stage 8: CSS Cleanup

Purpose:
Reduce long-term style risk after visible behavior is stable.

Files:
- `quant-system/frontend/app/globals.css`

Scope:
- Remove unused legacy selectors.
- Group styles by tokens, shell, components, modules, responsive rules.
- Remove contradictory black industrial tokens if no longer used.

Verification:
- `npm run build`
- Browser check for main routes.
- No major visual regression.

## Verification Checklist Per Stage

Run:

```bash
npm run build
```

Check:
- `/`
- `/strategies`
- `/backtests`
- `/paper`
- `/research`
- `/reviews`
- `/knowledge`

Viewport checks:
- Desktop 1440px
- Mobile 390px

Must pass:
- No body horizontal overflow.
- Main actions and risk states visible.
- Logs hidden by default.
- Raw enum values translated where visible.
- Tables remain readable.
- Navigation and shell are consistent.

## Change Discipline

Each stage should produce:
- Files changed.
- Visible UI change.
- Verification command.
- Browser routes checked.
- Known remaining issues.

If a stage needs to touch business logic, stop and split the work. UI refactor stages should not change selection, scoring, trading, backtest, or data-loading behavior.
