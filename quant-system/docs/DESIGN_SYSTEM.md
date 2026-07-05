# Quant System Design System

## Direction

This product should feel like a professional B-side financial analysis terminal: restrained, dense, legible, and decision-oriented.

Chosen visual anchor: Swiss.

Reason: the system is data-heavy and risk-sensitive. A Swiss system gives strong grid discipline, clear typography, neutral surfaces, and deliberate use of red/green financial signals without turning the product into a decorative trading screen.

Differentiator: a disciplined "decision rail" pattern. Every major page should surface the current decision state, risk state, and actionable next step before logs, raw data, or diagnostics.

## Product Reference

Futubull is a useful reference for information architecture, not a visual skin to copy.

Reference patterns to adopt:
- Watchlist-first scanning: compact rows with stock name, code, latest price, change, volume/turnover, and state.
- Portfolio-first holdings: total asset, cash, exposure, P/L, positions, and orders grouped in one operational flow.
- News/research stream: market-moving information sits beside watchlist or candidate context instead of being buried as a separate log.
- Multi-pane financial workspace: list on the left, key decision/detail in the center, context such as news, risk, or order actions on the right when screen width allows.
- Dense mobile hierarchy: show watchlist/candidate rows first, then details, then news and diagnostics.

Patterns to avoid:
- Consumer social/community UI.
- Promotional cards.
- Overly colorful retail trading chrome.
- Raw logs presented as primary content.

## Design Principles

1. Business signal first
   - Show decision, candidate, risk, and action before raw logs.
   - Hide diagnostics and technical audit data by default.
   - Do not show stdout, stderr, raw status codes, file paths, or internal script names in primary views.

2. Dense but readable
   - Use compact spacing and clear sections.
   - Prefer tables for financial lists and ranked candidates.
   - Avoid large decorative empty space.
   - Avoid nested cards unless the inner card is a repeated item or an actual tool surface.

3. One visual system
   - Homepage and module pages must use the same shell, tokens, spacing, and table language.
   - No black industrial pages mixed with the light dashboard.
   - No page-specific color systems unless they map to semantic state.

4. Financial semantics over generic UI
   - Red: A-share rise, priority, warning focus, blocked risk.
   - Green: A-share fall or positive system health only when explicitly used as a semantic state.
   - Amber: waiting, caution, pending confirmation.
   - Blue: informational or neutral strategy state.

5. Content discipline
   - Every visible string must be useful product information.
   - Use user-readable labels instead of raw enum values.
   - Standard actions use standard labels: refresh, precheck, intervene, expand, collapse.

## Tokens

### Color

Use CSS custom properties as the source of truth.

```css
--qs-bg: #f7f8fa;
--qs-surface: #ffffff;
--qs-surface-subtle: #f3f5f8;
--qs-border: #dde2ea;
--qs-border-strong: #b9c1ce;
--qs-text: #111827;
--qs-text-muted: #667085;
--qs-text-subtle: #8a94a6;
--qs-red: #e4002b;
--qs-green: #087a45;
--qs-amber: #a16207;
--qs-blue: #1d4ed8;
--qs-danger-bg: #fff1f3;
--qs-success-bg: #eefaf4;
--qs-warning-bg: #fff7e6;
--qs-info-bg: #eef4ff;
```

Rules:
- Primary background must be neutral light.
- Main surface should be white.
- Borders should be 1px hairlines.
- Avoid gradients except subtle structural grid backgrounds.
- Avoid heavy shadows. Use light elevation only for active panels.

### Typography

```css
--qs-font-sans: "Helvetica Neue", Helvetica, Arial, "PingFang SC", "Microsoft YaHei", sans-serif;
--qs-font-mono: "SFMono-Regular", "Roboto Mono", "JetBrains Mono", Consolas, monospace;
```

Rules:
- Use sans font for UI, headings, labels, and body.
- Use mono only for stock codes, timestamps, account ids, and numeric technical identifiers.
- Use `font-variant-numeric: tabular-nums` on financial values and tables.
- Do not use decorative typefaces.

### Type Scale

```css
--qs-text-xs: 11px;
--qs-text-sm: 12px;
--qs-text-md: 13px;
--qs-text-base: 14px;
--qs-text-lg: 18px;
--qs-text-xl: 22px;
--qs-text-2xl: 28px;
```

Usage:
- Page title: 22-28px
- Section title: 14-16px
- Table text: 12-13px
- Metric value: 20-28px
- Captions: 11-12px

### Spacing

```css
--qs-space-1: 4px;
--qs-space-2: 8px;
--qs-space-3: 12px;
--qs-space-4: 16px;
--qs-space-5: 20px;
--qs-space-6: 24px;
--qs-space-8: 32px;
```

Rules:
- Dashboard grid gap: 12-16px.
- Panel padding: 12-16px.
- Table cell padding: 8-12px.
- Navigation item height: 36-44px.

### Radius and Elevation

```css
--qs-radius-sm: 4px;
--qs-radius-md: 6px;
--qs-shadow-panel: 0 10px 30px rgba(16, 24, 40, 0.06);
```

Rules:
- Default panel radius: 4px or 6px.
- Avoid fully square brutalist controls unless a table cell requires it.
- Avoid large rounded marketing cards.
- Avoid strong decorative shadows.

## Core Components

### App Shell

Required regions:
- Left navigation
- Page header
- Main content grid
- Optional diagnostics drawer

Rules:
- Homepage and module pages share the same shell.
- Navigation width should be stable across routes.
- Current module must be visually selected.
- Header should show page title, trade date, data source, and mode.

### Dashboard Panel

Use for first-level page sections.

Required anatomy:
- Header: title + optional tools
- Body: metrics, table, or ranked list
- Optional risk footer

Rules:
- Panels should not contain unrelated logs.
- Panel title should be business-facing.
- Avoid over-wide text blocks.

### KPI Card

Use for numeric summaries.

Required anatomy:
- Label
- Value
- Optional delta/status
- Optional date/source caption

Rules:
- Values use tabular numerics.
- Status color maps to semantic state.
- Do not append full timestamps to every card unless comparing data freshness.

### Status Badge

Allowed states:
- `success`: healthy, passed, available
- `warning`: waiting, partial, needs confirmation
- `danger`: blocked, stale, failed, high risk
- `info`: neutral, paper-only, simulated

Rules:
- Raw values such as `PAPER_ONLY`, `WATCH_ONLY`, `SUCCESS_WITH_WARNINGS` should be translated into readable labels.
- Keep badges compact.

### Risk Banner

Use when a risk state affects trading.

Required anatomy:
- Risk level
- Cause
- Recommended action

Rules:
- Risk must be more visible than diagnostics.
- Blocking risks must appear above candidate tables.
- Warnings should not look like successful signals.

### Financial Table

Required behavior:
- Sticky header when table scrolls.
- Numeric columns right aligned.
- Stock name + code grouped in one cell.
- Risk/action column remains visually distinct.
- Long text truncated or summarized with detail available on demand.

Column guidance:
- Stock: left aligned.
- Price, pct, score, amount, turnover: right aligned.
- Status/risk/action: compact badge.
- Reason: max width with controlled wrapping.

Rules:
- Avoid full-width log tables in primary views.
- Use local horizontal scroll for wide tables, never body overflow.
- Use consistent red/green semantics for A-share display.

### Diagnostics Drawer

Use for data audit, files, refresh steps, and logs.

Rules:
- Default closed.
- Closed state should be compact and low priority.
- Technical logs should be second-level disclosure inside diagnostics.
- Never show raw stdout/stderr in the main dashboard.

## Module IA

### Home Dashboard

Primary purpose: "What should I do now?"

Recommended order:
1. Market state strip
2. Trading gate and current decision
3. Watchlist / upside radar
4. Holdings / exposure snapshot when available
5. News, research, or catalyst stream
6. Recommended candidates table
7. Diagnostics drawer

### Strategy Center

Primary purpose: "Which strategies are valid and runnable?"

Sections:
- Strategy KPI cards
- Execution gate table
- Quality / blockers
- Promotion or next action

### Backtest Center

Primary purpose: "Can this strategy survive historical validation?"

Sections:
- Win rate, average return, drawdown, sample count
- Parameter run table
- Risk gate / pass-fail summary

### Paper Trading

Primary purpose: "What is the simulated account exposure and order state?"

Sections:
- Cash, equity, exposure, risk
- Positions table
- Orders table
- Manual intervention entry

Layout reference:
- Use a Futubull-like portfolio split: account summary first, positions table second, order ticket/context third.
- Keep risk status visible near exposure and order actions.
- Do not bury positions below research or logs.

### Research Center

Primary purpose: "What evidence supports or rejects candidates?"

Sections:
- Research coverage
- Evidence status
- Agent conclusions
- Source health

Layout reference:
- Use a news/research stream beside candidate context.
- Group items by symbol where possible.
- Show freshness, source, and risk implication before raw evidence text.

### Review Center

Primary purpose: "What did the system learn from failures and missed opportunities?"

Sections:
- Cases
- Strategy issues
- Parameter review
- Next actions

### Knowledge Base

Primary purpose: "Is the decision knowledge complete and current?"

Sections:
- Coverage metrics
- Layer table
- Missing knowledge warnings

## Accessibility and Responsiveness

Rules:
- No page-level horizontal overflow.
- Tables may scroll inside their own containers.
- Mobile first viewport should show decision and candidate queue before diagnostics.
- Tap targets should be at least 36px high.
- Color cannot be the only state indicator; include text labels.

## Quality Gates

Before shipping any UI stage:
1. `npm run build` passes.
2. Desktop viewport has no body horizontal overflow.
3. Mobile viewport has no body horizontal overflow.
4. Homepage first viewport shows decision and candidate queue.
5. Diagnostics and logs are closed by default.
6. Homepage and module pages use the same shell direction.
7. No raw logs or raw enum values appear in primary views.
