import { ReportGroup } from './report-module.model';

/** Reusable 24×24 icon paths (Lucide-style). */
export const ICONS = {
  dashboard: 'M3 3h8v8H3V3zm10 0h8v5h-8V3zM3 13h8v8H3v-8zm10 3h8v5h-8v-5z',
  salesOrder: 'M8 2h8l2 4v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V6l2-4zM6 6h12M9 11h6M9 15h4',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  chart: 'M3 3v18h18M7 15l3-4 3 3 4-6',
  box: 'M21 8l-9-5-9 5v8l9 5 9-5V8zM3 8l9 5 9-5M12 13v8',
  chevron: 'm6 9 6 6 6-6',
} as const;

/**
 * The registered navigation groups. This is the ONLY list to touch when adding
 * a new report — pair each child's `route` with a lazy route in `app.routes.ts`.
 */
export const REPORT_GROUPS: ReportGroup[] = [
  {
    id: 'sales-order',
    title: 'Sales Order',
    icon: ICONS.salesOrder,
    children: [
      {
        id: 'sales-order-list',
        title: 'Sales Order List',
        description: 'Detailed grid of every open backorder line with dates and amounts.',
        route: 'sales-orders/list',
        icon: ICONS.list,
        accent: 'var(--color-chart-1)',
      },
      {
        id: 'sales-order-reports',
        title: 'Sales Order Reports',
        description: 'KPIs and charts across open backorders with inventory to fulfil.',
        route: 'sales-orders/reports',
        icon: ICONS.chart,
        accent: 'var(--color-chart-2)',
      },
    ],
  },
];
