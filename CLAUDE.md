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
auto-loads it): `AZURE_CLIENT_SECRET` (D365) and `ANTHROPIC_API_KEY` (AI). Without
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
  `border-border-soft`, `text-content`, etc.) so light/dark both work. Brand blue
  `#0B3D91`, accent orange `#F24C1A`. Dark mode = `.dark` class on `<html>`.
  Reusable component classes live in `styles.css` (`.card`, `.btn-primary`,
  `.btn-ghost`, `.field`, `.select`, `.segment`/`.seg`, `.pill-*`, `.tbl`,
  elevation via `--shadow-*`, focus ring via `--ring`).
- **Never redefine a form control in a feature stylesheet.** `.field` / `.select`
  / `.seg` are shared primitives. They were previously redefined independently in
  `settings.css`, `ai-report.css` and `sales-order-list.css` and drifted apart on
  radius, font-size and focus-ring opacity, so no two inputs in the app matched.
  Form controls sit on `--border-strong` (not `--border-soft`) — a card border
  wants to disappear, an input border has to advertise that you can type in it.
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
- **Data**: open backorder lines — `RemainInventPhysical gt 0` and status
  `Backorder`. **Which entity supplies them is per-tenant** — see
  `environment.salesOrder`, the single block every Sales Order screen follows
  (list, report, dashboard KPIs, AI Analyst tab).
  - **Growpath**: the composite `GP_SalesHeaderAndLineData`, company `usmf`.
    Header columns arrive prefixed `SalesTable_*`. One request.
  - **Shatat**: that entity does **not exist** there (it 404s), and no `Sha_`
    equivalent is published. The same report is assembled from two stock BI
    entities — `SalesLineBiEntities` + `SalesTableBiEntities`, joined on
    `(dataAreaId, SalesId)` in `SalesOrderService`. Company is **`003`**, not the
    `001` the `Sha_SerialTrans` screens use — `001` has zero backorder lines.
  - Use the BI entities, not the friendlier `SalesOrderLines`: the latter renames
    every column (`SalesOrderNumber`, `OrderedSalesQuantity`) and omits
    `RemainInventPhysical` outright — the report's central measure.
  - `SalesBackorderRecord` is the report's contract, not any entity's schema. The
    service normalises both shapes into it, so screens never learn which is live.
  - The AI Analyst issues single-entity queries and **cannot join**, so on a split
    source its Sales Order tab is given the line half only, with the
    `SalesTable_*` fields withheld from the schema rather than advertised and
    then 400'd by D365.
- **Config**: `src/environments/environment.ts` (dev) and `environment.prod.ts`
  (prod). **Gotcha:** `d365BaseUrl` and `auth.scope` must target the SAME
  tenant — the token audience must match the resource. The proven sandbox pair is
  `growpath.sandbox.operations.eu.dynamics.com`. Change both together.

### AI Analyst (Anthropic / Claude integration)

- **The Anthropic key is server-side only.** `api/chat.js` (Vercel function in prod;
  `dev-api/server.js` in dev) holds `ANTHROPIC_API_KEY` and streams SSE to the
  browser. The Angular app never sees the key — same principle as `/api/token`.
- **Model.** `claude-opus-5` via the official `@anthropic-ai/sdk`, streaming, with
  adaptive thinking. `ANTHROPIC_MODEL` and `ANTHROPIC_EFFORT` (default `medium` —
  chat latency beats the API's `high` default here) override per-deployment.
- **The system prompt is prompt-cached** (`cache_control: ephemeral`). It carries
  the schema, aggregates and sample rows — identical across turns, so follow-ups
  are far cheaper. It re-caches when the user changes slice, which is correct.
- **Generative pattern: the LLM designs, the app computes.** The model returns a
  **Report Spec** by calling the `emit_report` tool — *not* numbers or HTML. The
  backend reads `tool_use.input` off the stream (never shown to the user) and
  `ReportEngineService` computes it against the real local dataset, so every figure
  is accurate and no model output is executed. The tool is intentionally not
  `strict: true`: ReportSpec has many optional fields, and `SpecCompilerService`
  already validates every clause and surfaces refusals via `omitted`.
- Only **aggregates + schema + sample rows** are sent to the model
  (`DataContextService`), never the full raw dataset. Keep it that way for privacy.
- **Sources are a list, and the picker scales with it.** `AiReportModel.sources`
  holds one `AnalystSource` per module (currently Sales Order, Transaction,
  Purchase Order). The chrome is a **source picker**, not a tab strip — a
  segmented control puts every option on screen, so its width grew with each
  module until the toolbar wrapped. The picker is fixed-width at any list length
  and grows a filter box at six sources (`AiReportComponent.SEARCH_FROM`).
  **Adding a module is one entry in `sources` plus a fields file** — no UI edit.
  Give it a `description`; it is the picker's second line and a bare label like
  "Transaction" says nothing on its own.
- **The report is a composition of cards, not a card.** It renders with no
  wrapper: `.card` carries a border, radius and shadow but **no padding**, so
  wrapping the report put its title flush against that border and drew a second
  border a pixel outside the chart cards and the detail table, which are cards
  themselves. `DynamicReportComponent` owns its own header and hairline instead.
- **The workspace stacks — report on top (scrolls), chat docked below (fixed
  height).** It was two columns, which cost the report ~360px on every screen;
  the charts and the detail table are the widest things on the page and were the
  ones paying for it. Only `.report-scroll` scrolls; `.chat-dock` is `flex: none`
  so a long conversation grows the chat's own scroller, never the dock.
- **Few KPIs are capped, not stretched.** One or two tiles keep a tile-sized
  max-width; three or more fill the row so their edges line up with the cards
  below. A lone KPI spanning the full width is a band of gradient with a
  two-character number in the corner.
- **A source is one entity — the analyst cannot join.** If the data needs a join,
  either narrow the source to the half it can query (as the Sales Order tab does
  on Shatat, withholding the `SalesTable_*` fields) or do the join in a feature
  service and give the analyst its own single-entity view.
- **Confirm `enumType` against the live tenant; never infer it from the property
  name.** They routinely differ — on `PurchaseOrderHeadersV2`,
  `PurchaseOrderStatus` is enum `PurchStatus` and `DocumentApprovalStatus` is
  `VersioningDocumentState`. A wrong name is an opaque 400, not a useful error.
  Same for dates: `ConfirmedDeliveryDate` is the D365 null-date sentinel on every
  row there, so it is kept out of the schema — offering it would let the planner
  build a window that silently matches nothing.
- **A header entity has no measures.** `PurchaseOrderHeadersV2` carries no amount
  or quantity column, so its fields are all dimensions and the engine answers
  with `count`/`distinctCount`. Order value lives on `PurchaseOrderLines`, which
  that source does not join. Do not add a `measure: true` field the entity lacks.
- **The report's LOOK is part of the spec, not a settings screen.** `ReportSpec.design`
  carries `density`, `palette` and `chartLayout` — three closed enums — so "make it
  compact", "one colour", "bigger charts" land somewhere the next `emit_report` can
  honour. The model never emits CSS, sizes or hex; `ReportEngineService.resolveDesign`
  drops anything outside the vocabulary the same way `SpecCompilerService` drops an
  invented field. A single-hue palette paints `ChartDatum.color` with **CSS variables**
  (`var(--color-brand-600)`), not hex, so a re-branded app re-themes an existing report
  — which is why `document-builder` resolves colours through a hidden probe element
  rather than string-matching `var(`.
- **The model is shown the report it built.** The conversation carries prose only, so
  `AiReportModel.lastSpec` rides back with the next question and `api/chat.js`
  (`withCurrentReport`) appends it to the final user turn. Without it "make that a
  donut" has no subject. It goes on the MESSAGES, never the system prompt — the system
  block is prompt-cached, and a value that changes every turn would bust that cache on
  every reply. A report is **replaced, never patched**: the model re-emits the full spec.
- The `emit_report` tool schema in `api/chat.js` must stay in sync with `ReportSpec`
  in `features/ai-analyst/models/report-spec.model.ts`.
- **Three tools, three SSE events.** `emit_report` → `report` (what to compute),
  `write_analysis` → `analysis` (what it means), `export_document` → `export` (a
  download request). Claude may call several in one turn. An export is deferred to
  the end of the turn, so a report emitted in the same reply is rendered first.
- **The written analysis** (`Analysis` in `models/analysis.model.ts`) is prose only
  — by construction it has no field that could carry a figure the app did not
  compute. It renders in `AnalysisPanelComponent` above the report and opens any
  exported document.
- **Exports.** Excel/CSV via `xlsx` + paged fetch (`ExportService`). The *document*
  exports — PDF and HTML — both come from `document-builder.ts`, one self-contained
  HTML string: inlined CSS, charts as literal SVG, palette resolved to hex (a
  `var()` would not exist in a detached file). PDF is that same document sent to
  `window.print()`, so there is no PDF dependency and the two formats cannot drift.
  Reachable from the toolbar, from per-message buttons, and from chat.
- **Chat replies are Markdown**, rendered by `shared/utils/markdown.util.ts`. It
  **escapes before emitting any markup** — that ordering is the whole security
  model, so never insert raw input after markup generation. Bound with
  `[innerHTML]` so Angular's sanitiser runs as a second layer. Both are tested;
  `markdown.util.spec.ts` is what catches a regression here.

### Gotchas (do not re-break)

- **`/api/token` and `/api/chat` require `npm run dev:api`** *unless* the route is
  pointed at the deployed functions. `proxy.conf.js` decides each independently:
  `/api/token` follows `REMOTE_API_URL` when set (the Azure secret is marked
  Sensitive in Vercel and can never be pulled back); `/api/chat` stays local
  whenever `ANTHROPIC_API_KEY` is set, so local edits to the AI backend actually
  run. If a route targets `:3001` and dev-api isn't running, it returns **500**. The
  dev-api calls Azure server-to-server (no browser `Origin`), which also sidesteps the
  old `AADSTS9002326` cross-origin rejection — no Origin-stripping needed on those routes.
- **Proxy config loads once at startup** — always restart `npm start` after editing
  `proxy.conf.js`; it is not hot-reloaded.
- **Module `route` values contain a slash** (`reports/sales-orders`). Bind them as a
  string — `[routerLink]="'/' + module.route"` — never `['/', module.route]`, which
  encodes the slash to `%2F` and matches no route (dead nav link).
- **Styles for `[innerHTML]` content MUST live in `src/styles.css`, never in a
  component stylesheet.** Angular's emulated encapsulation rewrites every selector
  to require the component's `_ngcontent` attribute, and elements inserted via
  `[innerHTML]` never receive it. `.prose-chat` (the assistant's rendered Markdown)
  lived in `chat-panel.css`, where `.prose-chat p` compiled to
  `.prose-chat[_ngcontent-x] p[_ngcontent-x]` and matched nothing — headings,
  lists, code, tables and links all silently fell back to browser defaults. The
  build stays green either way; only the rendering changes, so this fails quietly.
- **The default brand colour lives in three places that must agree**: the
  `--color-brand-*` ramp in `styles.css`, `DEFAULT_BRANDING.primary` in
  `branding.service.ts`, and the presets in `settings.model.ts`. The CSS ramp must
  equal `buildScale(primary)` or the pre-bootstrap paint differs from the themed
  one. Changing the default also needs a migration in `BrandingService.load()` —
  every existing user has the old value in `localStorage`, and it wins on boot.
