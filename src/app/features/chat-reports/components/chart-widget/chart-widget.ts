import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { ChartCardComponent } from '../../../../shared/ui/chart-card/chart-card';
import { ColumnChartComponent } from '../../../../shared/ui/column-chart/column-chart';
import { LineChartComponent } from '../../../../shared/ui/line-chart/line-chart';
import { DonutChartComponent } from '../../../../shared/ui/donut-chart/donut-chart';
import { ChartDatum } from '../../../../shared/models/chart.model';
import { ChartSeries } from '../../../../shared/models/series.model';
import { formatCompact, formatQuantity } from '../../../../shared/utils/format.util';
import { ChartComponentSpec } from '../../models/report-payload.model';

/**
 * Renders one `chart` node from the payload.
 *
 * The four `chart_type` values map onto three hand-built SVG/CSS primitives —
 * no charting dependency, and every colour is a CSS variable so `BrandingService`
 * re-themes the whole thing live:
 *
 * | `chart_type` | primitive | why |
 * |---|---|---|
 * | `bar`      | `app-column-chart`  | vertical, grouped, reads left-to-right |
 * | `line`     | `app-line-chart`    | change over an ordered axis |
 * | `pie`      | `app-donut-chart` (`variant="pie"`)      | parts of one whole |
 * | `doughnut` | `app-donut-chart` (`variant="donut"`)    | parts of one whole, total in the hole |
 *
 * `pie` and `doughnut` plot the first series only — a ring encodes parts of ONE
 * whole, and a second series has nowhere to go. Both the backend and the parser
 * trim to one before it reaches here, and the backend names the trim in
 * `dropped[]` so the user is told rather than quietly given less.
 */
@Component({
  selector: 'app-chart-widget',
  imports: [ChartCardComponent, ColumnChartComponent, LineChartComponent, DonutChartComponent],
  templateUrl: './chart-widget.html',
  styleUrl: './chart-widget.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChartWidgetComponent {
  readonly spec = input.required<ChartComponentSpec>();

  /** `plain` inside a chat bubble that already has a surface; `card` standalone. */
  readonly variant = input<'card' | 'plain'>('plain');

  protected readonly chartType = computed(() => this.spec().chart_type);

  /** Column and line charts plot every series. */
  protected readonly series = computed<ChartSeries[]>(() =>
    this.spec().datasets.map((set) => ({ label: set.label, values: set.data })),
  );

  /** Ring charts plot the first series across the labels as slices. */
  protected readonly slices = computed<ChartDatum[]>(() => {
    const spec = this.spec();
    const values = spec.datasets[0]?.data ?? [];
    return spec.labels.map((label, i) => ({ label, value: values[i] ?? 0 }));
  });

  /** The series name, which a single-series chart has no legend to carry. */
  protected readonly subtitle = computed(() => {
    const datasets = this.spec().datasets;
    return datasets.length === 1 ? datasets[0].label : '';
  });

  /**
   * Values here are model-authored and may be currency, counts or decimals, so
   * the axis stays neutral: grouped, up to two decimals, no assumed unit.
   * Guessing a currency symbol from a bare number is how a chart states a fact
   * the data never carried.
   */
  protected readonly format = formatQuantity;

  /** Ring legends carry a value per slice, so they get the compact form. */
  protected readonly compactFormat = formatCompact;
}
