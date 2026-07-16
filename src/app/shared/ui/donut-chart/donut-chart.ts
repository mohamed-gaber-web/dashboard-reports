import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { ChartDatum, paletteColor } from '../../models/chart.model';
import { formatCompact, formatInteger } from '../../utils/format.util';

interface DonutSegment {
  index: number;
  label: string;
  color: string;
  dashArray: string;
  dashOffset: number;
  /** Rounded for display; `<1%` below the rounding floor. */
  percentLabel: string;
  valueLabel: string;
}

/**
 * The gap, in circumference units (the circle's circumference is normalised to
 * 100), that separates touching arcs. White does the separating — the arcs carry
 * no stroke of their own.
 */
const GAP = 0.7;

/** Arc length below which a slice would disappear entirely. */
const MIN_ARC = 0.5;

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
  /** How to render each slice's raw value in the legend. */
  readonly format = input<(value: number) => string>(formatInteger);

  /** Legend/arc hover pairing — hovering either dims every other slice. */
  protected readonly active = signal<number | null>(null);

  protected readonly total = computed(() => this.data().reduce((sum, d) => sum + d.value, 0));

  protected readonly totalDisplay = computed(() => formatCompact(this.total()));

  protected readonly segments = computed<DonutSegment[]>(() => {
    const total = this.total();
    if (total <= 0) return [];
    const fmt = this.format();
    let cumulative = 0;
    return this.data().map((d, i) => {
      const percent = (d.value / total) * 100;
      // A slice this thin still gets a visible arc — dropping it silently would
      // make the ring lie about the categories it contains.
      const arc = Math.max(percent - GAP, MIN_ARC);
      const rounded = Math.round(percent);
      const segment: DonutSegment = {
        index: i,
        label: d.label,
        color: d.color ?? paletteColor(i),
        dashArray: `${arc} ${100 - arc}`,
        // Circumference is normalised to 100; start segments at 12 o'clock.
        dashOffset: (100 - cumulative - GAP / 2 + 25 + 100) % 100,
        percentLabel: rounded === 0 && percent > 0 ? '<1%' : `${rounded}%`,
        valueLabel: fmt(d.value),
      };
      cumulative += percent;
      return segment;
    });
  });

  protected opacity(index: number): number {
    const active = this.active();
    return active === null || active === index ? 1 : 0.25;
  }
}
