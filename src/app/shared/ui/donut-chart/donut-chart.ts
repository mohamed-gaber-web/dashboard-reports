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

/**
 * Ring geometry per variant, in the 36×36 viewBox.
 *
 * A pie is a donut whose ring is thick enough to close the hole: the stroke is
 * centred on `r`, so a stroke of `2r` reaches from the centre to `2r`. Both
 * variants therefore share every line of arc maths below.
 *
 * The arcs carry `pathLength="100"` in the template, which normalises dash
 * units to 0–100 regardless of the real circumference. Without it, changing `r`
 * for the pie would silently break every `stroke-dasharray` percentage.
 */
const GEOMETRY = {
  donut: { r: 15.915, strokeWidth: 3.4 },
  pie: { r: 8.8, strokeWidth: 17.6 },
} as const;

/** SVG donut/pie chart with legend — no charting dependency. */
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

  /**
   * `donut` keeps the hole, and the total sits in it. `pie` fills the centre —
   * which means there is nowhere to put the total, so it moves to the legend
   * header rather than being dropped.
   */
  readonly variant = input<'donut' | 'pie'>('donut');

  protected readonly geometry = computed(() => GEOMETRY[this.variant()]);

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
