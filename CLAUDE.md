# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

**Reports Dashboard** — an Angular 21 web app that renders operational reports per
D365 module. The first module is **Sales Orders** (open backorders with remaining
physical inventory). It is built to be extended: adding a new report module is a
two-line change (see "Adding a report module").

## Commands

```bash
npm run dev:api  # Local API on :3001 — REQUIRED (D365 auth + AI Analyst)
npm start        # Dev server at http://localhost:4200 (uses proxy.conf.js)
npm run build    # Production build to dist/
npm test         # Vitest unit tests
```

**Run `npm run dev:api` alongside `npm start`.** It holds the secrets and serves
`/api/token` (D365 auth) and `/api/chat` (AI Analyst); the Vite proxy forwards both
to it. Put secrets in a git-ignored `.env` (see `.env.example`; the dev server
auto-loads it): `AZURE_CLIENT_SECRET` (D365) and `OPENROUTER_API_KEY` (AI). Without
`dev:api` running, login/data and the AI page return 500.

## Tech stack

- Angular 21, **standalone components**, **signals**, **zoneless** change detection
- Tailwind CSS v4 (via `@tailwindcss/postcss`) — design tokens in `src/styles.css`
- TypeScript strict mode
- No charting dependency — charts are hand-built SVG/CSS components

## Architecture (clean layering + MVVM)

```
src/app/
  core/            Singletons — cross-cutting, providedIn:'root'
    http/          ApiService  — the ONLY place HttpClient is used for D365
    auth/          AuthService (Azure AD token) + authInterceptor (bearer + 401 retry)
    reporting/     ReportRegistryService + REPORT_GROUPS (nav metadata)
    theme/         ThemeService (light/dark)
    branding/      BrandingService (app name, logo, colours — runtime re-theming)
    models/        ODataResponse<T>, ODataQuery
  shared/          Reusable, presentational — no feature knowledge
    ui/            icon, kpi-card, chart-card, bar-chart, donut-chart, data-table,
                   status-badge, spinner, empty-state, page-header
    models/        chart, table-column, badge types
    utils/         format + group-by/aggregate helpers
  layout/          shell (frame), sidebar (module nav), topbar (theme + status)
  features/
    dashboard/     Overview page (aggregates module headline numbers)
    sales-order/   services/ models/ pages/{sales-order-list, sales-order-report}
    settings/      Branding & appearance (name, logo, colours, presets, theme)
    ai-analyst/    Chat → generative dashboard reports (Claude) + Excel/PDF export
```

**MVVM mapping — follow this for every screen:**

| Role | Where | Owns |
|---|---|---|
| **Service** (`providedIn:'root'`) | `core/**`, `features/**/services` | HTTP + shared logic. Never presentation. |
| **Model** (component `providers[]`) | `*.model.ts` next to a page | State signals + computed KPIs/charts/table. Injects services. |
| **View** (component) | `*.ts` + `*.html` | Binds to its Model only. Zero logic. |

Example: `SalesOrderReportComponent` (View) → `SalesOrderReportModel` (Model,
provided in the component) → `SalesOrderService` (Service) → `ApiService` → HTTP.

## Conventions

- **Every component**: standalone, `ChangeDetectionStrategy.OnPush`, `inject()`,
  three files (`.ts` / `.html` / `.css`) — no inline templates/styles.
- **Inputs/outputs**: signal-based `input()` / `output()`.
- **State**: signals only (no RxJS subjects for UI state). RxJS is used at the HTTP
  boundary; subscriptions in Models use `takeUntilDestroyed(this.destroyRef)`.
- **No `HttpClient`** outside `ApiService`. Feature services depend on `ApiService`.
- **Styling**: Tailwind utilities + semantic tokens (`bg-surface`, `text-muted`,
  `border-border-soft`, `text-content`, etc.) so light/dark both work. Brand navy
  `#002559`, accent orange `#F24C1A`. Dark mode = `.dark` class on `<html>`.
  Reusable component classes live in `styles.css` (`.card`, `.btn-primary`,
  `.btn-ghost`, elevation via `--shadow-*`).
- **Runtime theming**: `BrandingService` overrides the Tailwind CSS variables
  (`--color-brand-*`, `--color-accent-*`, `--color-chart-1/2`) on `<html>` from a
  single primary/accent hex (`buildScale` derives the 50–900 ramp). Any component
  using `bg-brand-600` / `text-accent-500` re-themes instantly. Applied at bootstrap
  via an app initializer so custom themes show without a flash. **Therefore:** style
  with brand/accent tokens, never hardcoded hex, so Settings can re-theme it.
- **Storage keys** are constants prefixed `rd.` (see AuthService, ThemeService).

## Navigation model

The sidebar is grouped: `REPORT_GROUPS` in `core/reporting/report-modules.ts` is a
list of `ReportGroup`s (a parent like **Sales Order**), each with `children`
(`ReportModuleDefinition[]`) — e.g. **Sales Order List** and **Sales Order Reports**.
Groups render as collapsible sections. The dashboard reads the flattened
`registry.modules` (all children) as cards.

## Adding a report screen (Open/Closed)

1. Add a `ReportModuleDefinition` to the relevant group's `children` in
   `REPORT_GROUPS` (or add a new group). Each child needs id, title, description,
   `route`, icon, accent.
2. Add a lazy child route in `app.routes.ts` matching that `route`.
3. Build the screen under `features/<module>/pages/<screen>/` with a View + Model,
   reusing the feature Service and the shared UI kit.

The sidebar and dashboard read the registry, so they pick up the new screen with
no edits. **Bind routes as strings** — `[routerLink]="'/' + child.route"` — because
`route` contains a slash.

## External integration — D365 / Azure AD

- **Auth**: Azure AD OAuth2 **client_credentials**. The browser calls same-origin
  `/api/token` → `api/token.js`, which injects `client_secret` from
  `AZURE_CLIENT_SECRET` server-side (dev: `dev-api/server.js`; prod: serverless).
  `authInterceptor` attaches the bearer to every `/data` request and retries once on 401.
- **The client secret is NEVER in source or the browser.** `environment.ts` has
  `clientSecret: ''`; the real value lives in a git-ignored `.env` (`AZURE_CLIENT_SECRET`).
  Do not put it back in `environment.ts` — GitHub push protection will (correctly) block it.
- **Data**: D365 OData entity `GP_SalesHeaderAndLineData`, filtered to
  `dataAreaId='usmf'`, `RemainInventPhysical gt 0`, and sales/line status `Backorder`.
- **Config**: `src/environments/environment.ts` (dev) and `environment.prod.ts`
  (prod). **Gotcha:** `d365BaseUrl` and `auth.scope` must target the SAME
  tenant — the token audience must match the resource. The proven sandbox pair is
  `growpath.sandbox.operations.eu.dynamics.com`. Change both together.

### AI Analyst (OpenRouter / free-LLM integration)

- **The OpenRouter key is server-side only.** `api/chat.js` (Vercel function in prod;
  `dev-api/server.js` in dev) holds `OPENROUTER_API_KEY` and streams SSE to the
  browser. The Angular app never sees the key — same principle as `/api/token`.
- **Free-model resilience.** `api/chat.js` discovers currently-**free** models from
  OpenRouter (`/api/v1/models`, `pricing == 0`), tries them in order, and skips a
  model on any non-fatal error (404 unavailable, 429 rate-limit, 5xx). Only 401/402/403
  (auth/billing) abort. Override the first pick with `OPENROUTER_MODEL`.
- **Generative pattern: the LLM designs, the app computes.** The model returns a
  **Report Spec** inside a `<report>{…JSON…}</report>` block — *not* numbers or HTML.
  A tag block (not tool/function calling) is used deliberately: free models vary in
  tool support, but all can emit text. The backend extracts the block from the stream
  (hidden from the user) and `ReportEngineService` computes it against the real local
  dataset, so every figure is accurate and no model output is executed.
- Only **aggregates + schema + sample rows** are sent to the model
  (`DataContextService`), never the full raw dataset. Keep it that way for privacy.
- The `<report>` JSON shape described in `api/chat.js`'s system prompt must stay in
  sync with `ReportSpec` in `features/ai-analyst/models/report-spec.model.ts`.
- Export: Excel via `xlsx` (SheetJS, lazy-loaded with the page); PDF via a printable
  window (`window.print()`), no extra dependency.

### Gotchas (do not re-break)

- **`/api/token` and `/api/chat` require `npm run dev:api`.** The Vite proxy forwards
  both to the dev-api server (`:3001`). If it isn't running, they return **500**. The
  dev-api calls Azure server-to-server (no browser `Origin`), which also sidesteps the
  old `AADSTS9002326` cross-origin rejection — no Origin-stripping needed on those routes.
- **Proxy config loads once at startup** — always restart `npm start` after editing
  `proxy.conf.js`; it is not hot-reloaded.
- **Module `route` values contain a slash** (`reports/sales-orders`). Bind them as a
  string — `[routerLink]="'/' + module.route"` — never `['/', module.route]`, which
  encodes the slash to `%2F` and matches no route (dead nav link).
