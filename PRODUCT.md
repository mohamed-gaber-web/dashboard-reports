# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary users are staff at a Dynamics 365 Finance & Operations customer, working
across three overlapping jobs on the same underlying D365 data:

- **Operations / supply-chain analysts** — chasing open sales-order backorders,
  checking which lines have remaining physical inventory to fulfil, and exporting
  detailed lists for follow-up. This is the day-to-day, task-oriented use.
- **Finance / accounting** — reading the financial side: purchase-order value,
  trial balance and P&L (module wired but not yet confirmed live), and totals
  that are expected to be exact.
- **Managers / executives** — reading grounded summaries and AI-authored briefs
  (including a designed Arabic RTL financial brief) to make decisions without
  doing the operational work themselves.

The same modules serve all three; the report's shape (detailed grid vs. KPI
dashboard vs. executive brief) is what differs per audience.

## Product Purpose

Reports Dashboard renders operational and financial reports per Dynamics 365
module, reading live from a customer's D365 F&O tenant. It exists to turn D365
data that is otherwise trapped behind OData queries and the ERP UI into
scannable reports, AI-assisted analysis, and shareable documents — without the
user writing a query or trusting a hallucinated number. Success is a user
getting an accurate, exportable answer about their own D365 data faster than the
ERP itself would allow.

## Positioning

A neighbouring reporting tool could copy the dashboards; what it could not
truthfully copy is the **grounding discipline across three distinct generative
patterns**:

- **AI Analyst** — the model designs a report *spec*; the app computes every
  figure against the real local dataset, so nothing can be hallucinated.
- **Chat Reports** — the model emits a finished, *grounded* payload (figures
  included, from real D365 aggregates, never recomputed) rendered in one chat
  bubble, and every report carries a provenance line saying so.
- **AI Report Builder** — the model designs a report *definition*, insights
  explicitly tagged OBSERVATION vs. INTERPRETATION so a reading can never borrow
  the authority of a fact.

Every figure is either computed by the app or explicitly marked as
model-grounded-but-not-recomputed. That honesty contract — including writing an
uncomputable figure as `غير متاح` rather than estimating it — is the product's
defensible position, not the chart styling.

## Operating Context

- Delivered as a **re-brandable product** to multiple D365 customers. Runtime
  theming and per-tenant configuration exist so each client sees their own brand
  and their own D365 environment. Two tenants are proven today: **Growpath**
  (sandbox, company `usmf`, composite `GP_SalesHeaderAndLineData`) and **Shatat**
  (UAT, company `003`, assembled from stock BI entities).
- Runs against a live D365 F&O OData API via Azure AD OAuth2 client-credentials;
  the client secret is injected server-side and never reaches the browser.
- Users work module-by-module: pick a D365 module, get its report, optionally ask
  the AI screens questions or generate a designed document, then export to
  Excel / CSV / PDF / HTML to forward to someone who never saw the screen.
- The AI screens are pointed at one module at a time; switching modules changes
  the schema and figures under the conversation.

## Capabilities and Constraints

- **Extensible by module registry** — adding a report screen is a registry entry
  plus a lazy route; the nav and dashboard pick it up automatically.
- **Which D365 entity supplies a module's data is per-tenant.** The same Sales
  Order report is assembled from different entities on Growpath vs. Shatat and
  normalised into one contract, so screens never learn which is live.
- **The AI Analyst cannot join** — a source is one entity. Joins are either done
  in a feature service (and given the analyst a single-entity view) or the source
  is narrowed to the half it can query.
- **No GROUP BY over OData** — trends, period comparisons and account totals come
  from an in-app day-level fold, gated by row count so an 11M-row module stays
  safe (count → gate → fold, with a counts-only fallback over the limit).
- **Charts are dependency-free** hand-built SVG/CSS; there is no charting library.
- **LLM output is never executed and the renderable set is closed at compile
  time** — an invented section/component type selects nothing.
- Both AI screens run on either **Claude** (the provider the contracts were
  designed against) or **Gemini** (the switch), chosen from the UI; keys stay
  server-side.
- **Trial Balance module** is wired but `enabled: false` — entity/column names
  are not portable between F&O tenants and must be probed against the live tenant
  before it ships. Whether a real P&L is possible depends on the tenant exposing
  an account-type column.

## Brand Commitments

- Ships under the neutral default name **"Reports"**, brand blue `#0B3D91` and
  accent orange `#F24C1A` — all **re-themeable at runtime** from Settings (app
  name, logo, primary/accent colours), because the product is delivered to
  clients who apply their own brand. Therefore: style with brand/accent tokens,
  never hardcoded hex, so re-theming holds.
- **No fixed logo asset ships** — a built-in mark is used until a client uploads
  their own (stored as a data URL). Do not fabricate a logo as a product fact.
- English UI chrome. The **Executive report style is authored in Arabic RTL** for
  Middle East financial stakeholders; RTL and Arabic are a real, supported output
  path, not a placeholder.
- Grounding/provenance language is a brand commitment, not decoration: exported
  documents repeat the "figures are AI-authored / or computed from D365" caveat
  in the masthead and footer per the screen that produced them. Do not quietly
  remove a provenance line.

## Evidence on Hand

- Real, working D365 sandbox/UAT tenants (Growpath sandbox; Shatat UAT) with live
  backorder data — the reports run against actual ERP data, not fixtures.
- No marketing copy, testimonials, customer logos, pricing, or case studies exist
  in the repo. Future work must not fabricate these.
- No image/illustration assets ship (`src/assets` is empty); charts and the mark
  are generated in-app.

## Product Principles

1. **Never show a number the app can't stand behind.** Compute it, or mark it as
   model-grounded, or write it unavailable — never estimate silently.
2. **The look is the client's, not ours.** Every surface must survive runtime
   re-theming; brand identity lives in tokens and precise details, not fixed hex.
3. **Serve three audiences from one dataset.** Operational grids, KPI dashboards,
   and executive briefs are different views of the same grounded figures — match
   the report's density and framing to who is reading.
4. **Extending beats special-casing.** A new module or section kind is a bounded,
   registry-driven addition, not a rewrite; the closed renderable set is a safety
   boundary, not a limitation.
5. **The wait and the provenance are part of the product.** Loading phases, the
   counts-only escape hatch, and the "how this figure was produced" line are
   first-class, not afterthoughts.

## Accessibility & Inclusion

- Light and dark themes are first-class; style with semantic tokens so both work.
- Arabic RTL is a supported output direction for executive documents; text
  direction and layout must not assume LTR on that path.
