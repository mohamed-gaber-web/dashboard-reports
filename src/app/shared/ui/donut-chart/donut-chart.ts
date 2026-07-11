import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { ChartDatum, paletteColor } from '../../models/chart.model';
import { formatInteger } from '../../utils/format.util';

interface DonutSegment {
  label: string;
  color: string;
  dashArray: string;
  dashOffset: number;
  percent: number;
}

/** SVG donut chart with legend — no charting dependency. */
@Component({
  selector: 'app-donut-chart',
  templateUrl: './donut-chart.html',
  styleUrl: './donut-chart.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DonutChartComponent {
  readonly data = input.required<ChartDatum[]>();
  readonly centerLabel = input('Total');

  protected readonly total = computed(() =>
    this.data().reduce((sum, d) => sum + d.value, 0),
  );

  protected readonly totalDisplay = computed(() => formatInteger(this.total()));

  protected readonly segments = computed<DonutSegment[]>(() => {
    const total = this.total();
    if (total <= 0) return [];
    let cumulative = 0;
    return this.data().map((d, i) => {
      const percent = (d.value / total) * 100;
      // Circumference is normalised to 100; start segments at 12 o'clock.
      const segment: DonutSegment = {
        label: d.label,
        color: d.color ?? paletteColor(i),
        dashArray: `${percent} ${100 - percent}`,
        dashOffset: (100 - cumulative + 25) % 100,
        percent: Math.round(percent),
      };
      cumulative += percent;
      return segment;
    });
  });
}
