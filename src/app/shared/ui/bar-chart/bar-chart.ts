import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { ChartDatum, paletteColor } from '../../models/chart.model';
import { formatInteger } from '../../utils/format.util';

interface BarRow {
  label: string;
  display: string;
  widthPct: number;
  color: string;
}

/** Horizontal bar chart built from CSS — no charting dependency. */
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

  protected readonly rows = computed<BarRow[]>(() => {
    const data = this.data();
    const max = Math.max(1, ...data.map((d) => d.value));
    const fmt = this.format();
    return data.map((d, i) => ({
      label: d.label,
      display: fmt(d.value),
      widthPct: Math.max(2, (d.value / max) * 100),
      color: d.color ?? paletteColor(i),
    }));
  });
}
