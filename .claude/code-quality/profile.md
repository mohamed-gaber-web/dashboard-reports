# Code Quality — Resolved Profile
scope:               fullstack
## Frontend
framework:           Angular 21 · standalone · signals · zoneless · OnPush
selector_prefix:     app-
styling:             Tailwind CSS v4 (@tailwindcss/postcss) + semantic tokens in src/styles.css
design_system:       src/styles.css (@theme tokens + @layer components: .card/.btn-*/.field/.prose-chat)
                     shared kit: src/app/shared/ui/{icon,kpi-card,chart-card,bar-chart,donut-chart,
                     data-table,status-badge,spinner,empty-state,page-header,skeleton}
i18n:                none (en-US/en-GB formatting only)
state:               Signals only. RxJS at the HTTP boundary; takeUntilDestroyed in Models.
## Backend
language:            JavaScript (CommonJS)
framework:           none — raw Node req/res handlers in api/*.js
runtime:             Vercel serverless (prod) · dev-api/server.js on :3001 (dev, via Vite proxy)
datastore:           D365 F&O OData (read-only, remote). No local DB.
data_access:         core/http/api.service.ts is the ONLY HttpClient user; feature services wrap it
auth_strategy:       Azure AD OAuth2 client_credentials via /api/token (secret injected server-side)
tenancy_model:       single-tenant (dataAreaId is a D365 company filter, not an app tenant boundary)
input_validation:    hand-rolled guards (no Zod/Joi in tree) — normalize+bound at the trust boundary
webhook_providers:   none
secrets_source:      env vars via scripts/load-env.js (.env is git-ignored)
## Rule sets in force
cited:               frontend-angular.md + backend.md
advisory:            tailwind.md, typescript.md
## Notes
- CLAUDE.md is authoritative and outranks [ARCH]/[D]. Key project invariants:
  * No charting dependency — charts are hand-built SVG/CSS.
  * Style with brand/accent/chart tokens, never hardcoded hex (BrandingService re-themes at runtime).
  * Component = 3 files (.ts/.html/.css). No inline templates/styles. No SCSS in tree.
  * Module `route` values contain a slash — bind as a string, never ['/', route].
- Presentational shared/ui components use `computed()` for pure render-shaping. This is the
  established repo convention for the whole UI kit and is view-derivation, not business logic;
  NG-ARCH-03 is read as barring business logic, and NG-ARCH-05 (no STATE signals) still holds.
