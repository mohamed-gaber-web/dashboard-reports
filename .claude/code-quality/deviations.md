
## 2026-08-24 · SPEC-DEVIATION (NestJS) · [D]
scope:     api/chat-report.js — requested "Node.js/NestJS" backend
reason:    Repo has no NestJS. Backend is raw Node req/res handlers in api/*.js that run
           unchanged as Vercel serverless functions and under dev-api/server.js.
           BE-ARCH-01 [ARCH] requires matching the repo's existing structure first;
           introducing a Nest runtime for one endpoint would fork the backend.
risk:      None to the deliverable — the JSON contract and system prompt are identical.
           If the backend later moves to NestJS, api/_lib/* ports as-is (pure functions).
expires:   If/when the project adopts NestJS project-wide.

## 2026-08-24 · SPEC-DEVIATION (SCSS) · [D]
scope:     all chat-reports component styles — requested SCSS
reason:    CLAUDE.md mandates Tailwind v4 + three files (.ts/.html/.css) per component.
           No sass dep, no SCSS in tree, angular.json has no SCSS wiring. CLAUDE.md
           outranks [D] under STEP 0 precedence.
risk:      None. Tailwind v4 + native CSS nesting covers every construct used here;
           design tokens already live in src/styles.css.
expires:   If the project adopts SCSS project-wide.

## 2026-08-24 · SPEC-DEVIATION (ng2-charts) · [ARCH]
scope:     chat-reports/components/chart-widget — requested ng2-charts/Chart.js
reason:    CLAUDE.md: "No charting dependency — charts are hand-built SVG/CSS."
           Chart.js paints to canvas and cannot read var(--color-chart-N), which breaks
           the runtime re-theming invariant (BrandingService rewrites those vars live).
           User explicitly chose hand-built SVG when presented with both options.
           (For the record: ng2-charts@10 does peer-support Angular >=21, and would
           additionally have pulled in @angular/cdk, which is not currently installed.)
risk:      None. All four chart_type values are covered by SVG primitives that re-theme.
expires:   n/a — decision confirmed by the user.

## 2026-08-24 · DESIGN-RISK (model-authored figures) · note
scope:     api/_lib/report-contract.js — contract has the LLM emit final values
reason:    Requested contract returns figures ("$54,200") rather than a spec the app
           computes. This inverts the existing AI Analyst invariant ("the model designs,
           the app computes") which exists so no figure can be hallucinated.
risk:      Figures rendered by chat-reports are MODEL-AUTHORED, not app-computed. They
           are grounded (real D365 aggregates injected into the system prompt + a hard
           instruction to use only those) but they are NOT verified against the dataset
           the way ReportEngineService verifies AI Analyst output.
           Mitigation shipped: every chat-reports report renders a visible provenance
           footer naming the grounded row count and stating figures are AI-stated.
expires:   User accepted this tradeoff explicitly (chose "Exactly as specced, but grounded").
