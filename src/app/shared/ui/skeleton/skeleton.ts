import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * A content-shaped loading placeholder.
 *
 * Replaces the centred spinner for anything with a known shape. A spinner
 * occupies nothing like the space a table needs, so the layout jumps when data
 * lands; a skeleton reserves it. It also communicates *what* is loading, not
 * merely that something is.
 *
 * `variant` picks the silhouette: a data grid, a row of KPI cards, or a chart.
 */
@Component({
  selector: 'app-skeleton',
  templateUrl: './skeleton.html',
  styleUrl: './skeleton.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SkeletonComponent {
  readonly variant = input<'table' | 'kpis' | 'chart' | 'report'>('table');
  /** Rows to draw for the table variant. */
  readonly rows = input(8);

  protected readonly range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);
}
