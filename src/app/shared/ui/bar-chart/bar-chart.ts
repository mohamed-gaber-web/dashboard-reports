import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { ChartDatum } from '../../models/chart.model';
import { formatInteger, percentOf } from '../../utils/format.util';

interface BarRow {
  label: string;
  display: string;
  share: string;
  widthPct: number;
  color: string;
}

/**
 * Horizontal bar chart built from CSS — no charting dependency.
 *
 * The bars are one hue, not eight: a bar chart of one measure across nominal
 * categories is a single series, and the bar's length already carries the value.
 * Spending a colour per bar would double-encode it and leave no channel free to
 * mean anything. Pass an explicit `color` on a datum to highlight one bar.
 */
@Component({
  selector: 'app-bar-chart',
  templateUrl: './bar-chart.html',
  styleUrl: './bar-chart.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BarChartComponent {
  readonly data = input.required<ChartDatum[]>();
  /** How to render each value label. */
  readonly format = input<(value: number) => string>(formatInteger);
  /** The series colour. Every bar wears it unless the datum overrides it. */
  readonly color = input('var(--color-chart-1)');
  /** Show each bar's share of the total beside its value. */
  readonly showShare = input(true);

  protected readonly rows = computed<BarRow[]>(() => {
    const data = this.data();
    const max = Math.max(1, ...data.map((d) => d.value));
    const total = data.reduce((sum, d) => sum + d.value, 0);
    const fmt = this.format();
    const series = this.color();
    return data.map((d) => ({
      label: d.label,
      display: fmt(d.value),
      share: `${percentOf(d.value, total)}%`,
      widthPct: Math.max(1.5, (d.value / max) * 100),
      color: d.color ?? series,
    }));
  });
}
