# Reports Dashboard

A modern Angular 21 dashboard that renders operational reports per Dynamics 365
module. Ships with a **Sales Orders** report (open backorders with remaining
physical inventory) and is built to add more modules with minimal change.

## Highlights

- **Clean architecture + SOLID + MVVM** — Services own data/HTTP, Models own state &
  derived values, Views only bind.
- **Extensible by design** — register a module + add a lazy route; the nav and
  overview update automatically.
- **Modern UI/UX** — calm, typography-led design system, light/dark themes,
  responsive, dependency-free SVG/CSS charts.
- **Angular 21** — standalone, signals, zoneless, OnPush throughout.

## Run

```bash
npm install      # first time
npm start        # http://localhost:4200
npm run build    # production build -> dist/
```

The dev server proxies Azure AD (`/api/token`) and D365 (`/data`) via
`proxy.conf.js`, so no CORS or secret exposure in the browser.

## Structure

```
core/      singletons: ApiService, AuthService + interceptor, ReportRegistry, Theme
shared/    reusable UI kit + models + utils
layout/    shell, sidebar, topbar
features/  dashboard (overview) + sales-order (report)
```

See [CLAUDE.md](./CLAUDE.md) for architecture details and how to add a new report
module.

## Configuration

Environment config lives in `src/environments/`. `d365BaseUrl` and `auth.scope`
must point at the same D365 tenant (the token audience must match the resource).
In production the client secret is injected server-side by a `/api/token` function —
it is never bundled into the browser.
