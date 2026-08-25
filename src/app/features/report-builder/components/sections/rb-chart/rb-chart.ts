import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { BarChartComponent } from '../../../../../shared/ui/bar-chart/bar-chart';
import { ChartCardComponent } from '../../../../../shared/ui/chart-card/chart-card';
import { ColumnChartComponent } from '../../../../../shared/ui/column-chart/column-chart';
import { DonutChartComponent } from '../../../../../shared/ui/donut-chart/donut-chart';
import { LineChartComponent } from '../../../../../shared/ui/line-chart/line-chart';
import { formatInteger } from '../../../../../shared/utils/format.util';
import { ComputedChart } from '../../../models/report-definition.model';

/**
 * One chart, drawn with whichever mark the model chose.
 *
 * | `kind`   | component            | when it is the right answer                |
 * | -------- | -------------------- | ------------------------------------------ |
 * | `line`   | `app-line-chart`     | change along an ordered (time) axis         |
 * | `area`   | `app-line-chart`     | the same, where magnitude is the point      |
 * | `bar`    | `app-bar-chart`      | top-N nominal categories; long labels fit   |
 * | `column` | `app-column-chart`   | a short category axis read left to right    |
 * | `pie`    | `app-donut-chart`    | parts of one whole, few enough to compare   |
 * | `donut`  | `app-donut-chart`    | the same, with room for the total in-centre |
 *
 * The mapping is a `@switch`, so the renderable set is CLOSED at compile time.
 * `kind` originates in model output, and an open registry would mean an invented
 * string could select a component.
 *
 * Whether a mark is APPROPRIATE was decided upstream in
 * `report-definition.validator.ts` — a line over nominal categories is rewritten
 * to a bar there, with the swap declared in `issues`. This component draws what
 * it is given and asserts nothing about it.
 */
@Component({
  selector: 'app-rb-chart',
  imports: [
    ChartCardComponent,
    BarChartComponent,
    ColumnChartComponent,
    DonutChartComponent,
    LineChartComponent,
  ],
  templateUrl: './rb-chart.html',
  styleUrl: './rb-chart.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RbChartComponent {
  readonly chart = input.required<ComputedChart>();
  readonly title = input.required<string>();
  readonly note = input<string>();

  /** Resolved by the composer from the measure's own metadata; integers otherwise. */
  protected readonly format = computed(() => this.chart().format ?? formatInteger);

  protected readonly labels = computed(() => this.chart().labels ?? []);
  protected readonly series = computed(() => this.chart().series ?? []);

  /** `pie` and `donut` are one component; the ring width is the difference. */
  protected readonly ringVariant = computed<'donut' | 'pie'>(() =>
    this.chart().kind === 'pie' ? 'pie' : 'donut',
  );

  protected readonly isEmpty = computed(() => this.chart().data.length === 0);

  /**
   * The line under the chart's title.
   *
   * It says what the reader cannot see: that a tail was folded into "Other", or
   * that a long series was cut to its recent end. Both are honest framing of a
   * chart that would otherwise imply it shows everything there is.
   */
  protected readonly subtitle = computed(() => {
    const chart = this.chart();
    const parts = [this.note(), chart.note];

    if (chart.data.some((d) => d.label === 'Other')) {
      const noun = chart.kind === 'pie' || chart.kind === 'donut' ? 'slices' : 'bars';
      parts.push(`Top ${chart.data.length - 1} ${noun} · the rest totalled as “Other”`);
    }

    return parts.filter(Boolean).join(' · ');
  });
}
