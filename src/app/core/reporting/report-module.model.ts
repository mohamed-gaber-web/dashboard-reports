/**
 * Metadata that describes one report module (e.g. "Sales Orders").
 *
 * Modules are pure metadata — no component imports — so the shell can render
 * navigation and the overview page without depending on any feature. The
 * actual report screen is reached by lazy route (`route`), keeping the shell
 * decoupled and the app Open/Closed: add a module by adding a definition plus
 * a lazy route, never by editing the shell.
 */
export interface ReportModuleDefinition {
  /** Stable identifier, also used as the dashboard card key. */
  id: string;
  /** Human label shown in nav and headings. */
  title: string;
  /** One-line summary of what the report covers. */
  description: string;
  /** Router path (without leading slash), e.g. `sales-orders/reports`. */
  route: string;
  /** Inline SVG path data (24×24 viewBox) for the module icon. */
  icon: string;
  /** Categorical accent colour used by the module's card/charts. */
  accent: string;
}

/**
 * A top-level navigation group (e.g. "Sales Order") that contains one or more
 * report modules. Groups render as collapsible sections in the sidebar.
 */
export interface ReportGroup {
  /** Stable identifier. */
  id: string;
  /** Group label shown as the collapsible header. */
  title: string;
  /** Inline SVG path data for the group icon. */
  icon: string;
  /** The report screens nested under this group. */
  children: ReportModuleDefinition[];
}
