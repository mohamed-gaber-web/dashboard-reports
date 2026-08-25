import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { BarChartComponent } from '../../../../../shared/ui/bar-chart/bar-chart';
import { ChartCardComponent } from '../../../../../shared/ui/chart-card/chart-card';
import { ColumnChartComponent } from '../../../../../shared/ui/column-chart/column-chart';
import { DonutChartComponent } from '../../../../../shared/ui/donut-chart/donut-chart';
import { LineChartComponent } from '../../../../../shared/ui/line-chart/line-chart';
import { formatInteger } from '../../../../../shared/utils/format.util';
import { ChartResult } from '../../../models/report-spec.model';

/**
 * One chart, drawn with whichever mark the model chose.
 *
 * | `chartType` | component            | when it is the right answer                  |
 * | ----------- | -------------------- | -------------------------------------------- |
 * | `bar`       | `app-bar-chart`      | top-N nominal categories; long labels fit     |
 * | `column`    | `app-column-chart`   | a category axis read left to right            |
 * | `line`      | `app-line-chart`     | change along an ordered (time) axis           |
 * | `area`      | `app-line-chart`     | the same, where the magnitude is the point    |
 * | `donut`     | `app-donut-chart`    | parts of one whole, few enough to compare     |
 *
 * The mapping is a `@switch`, so the renderable set is CLOSED at compile time.
 * `chartType` originates in model output, and an open registry would mean an
 * invented string could select a component — the same rule Chat Reports follows.
 *
 * Which mark is APPROPRIATE is decided upstream in `report-plan.ts`: a line over
 * nominal categories is rewritten to a bar there, with the swap declared. This
 * component draws what it is given.
 */
@Component({
  selector: 'app-report-chart',
  imports: [
    ChartCardComponent,
    BarChartComponent,
    ColumnChartComponent,
    DonutChartComponent,
    LineChartComponent,
  ],
  templateUrl: './report-chart.html',
  styleUrl: './report-chart.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReportChartComponent {
  readonly chart = input.required<ChartResult>();

  /** Resolved by the engine from the measure's own metadata; integers otherwise. */
  protected readonly format = computed(() => this.chart().format ?? formatInteger);

  protected readonly labels = computed(() => this.chart().labels ?? []);
  protected readonly series = computed(() => this.chart().series ?? []);

  /**
   * The line under the chart's title.
   *
   * Says what the reader cannot see: that a tail was folded into "Other", or
   * that a long series was cut to its recent end. Both are honest framing of a
   * chart that would otherwise imply it shows everything.
   */
  protected readonly subtitle = computed(() => {
    const chart = this.chart();
    const parts = [chart.note];

    const folded = chart.data.some((d) => d.label === 'Other');
    if (folded) {
      const noun = chart.type === 'donut' ? 'slices' : 'bars';
      parts.push(`Top ${chart.data.length - 1} ${noun} · the rest totalled as “Other”`);
    }

    return parts.filter(Boolean).join(' · ');
  });
}
