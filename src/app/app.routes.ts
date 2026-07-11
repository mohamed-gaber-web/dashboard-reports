import { Routes } from '@angular/router';
import { ShellComponent } from './layout/shell/shell';

/**
 * The shell wraps every screen; report modules are lazy-loaded children.
 * Add a new module by registering it in `report-modules.ts` and appending a
 * lazy route here — no other file changes.
 */
export const routes: Routes = [
  {
    path: '',
    component: ShellComponent,
    children: [
      { path: '', redirectTo: 'dashboard', pathMatch: 'full' },
      {
        path: 'dashboard',
        title: 'Overview · Reports',
        loadComponent: () =>
          import('./features/dashboard/dashboard').then((m) => m.DashboardComponent),
      },
      {
        path: 'sales-orders',
        redirectTo: 'sales-orders/list',
        pathMatch: 'full',
      },
      {
        path: 'sales-orders/list',
        title: 'Sales Order List · Reports',
        loadComponent: () =>
          import('./features/sales-order/pages/sales-order-list/sales-order-list').then(
            (m) => m.SalesOrderListComponent,
          ),
      },
      {
        path: 'sales-orders/reports',
        title: 'Sales Order Reports',
        loadComponent: () =>
          import('./features/sales-order/pages/sales-order-report/sales-order-report').then(
            (m) => m.SalesOrderReportComponent,
          ),
      },
      {
        path: 'ai/analyst',
        title: 'AI Analyst',
        loadComponent: () =>
          import('./features/ai-analyst/pages/ai-report/ai-report').then(
            (m) => m.AiReportComponent,
          ),
      },
      {
        path: 'settings',
        title: 'Settings',
        loadComponent: () =>
          import('./features/settings/settings').then((m) => m.SettingsComponent),
      },
      { path: '**', redirectTo: 'dashboard' },
    ],
  },
];
