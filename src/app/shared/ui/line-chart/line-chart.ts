import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { ChartSeries } from '../../models/series.model';
import { paletteColor } from '../../models/chart.model';
import { formatCompact, formatInteger } from '../../utils/format.util';
import { ValueScale, percentOfScale, valueScale } from '../../utils/scale.util';

/** A plotted point, positioned as percentages of the plot box. */
interface Point {
  leftPct: number;
  bottomPct: number;
  value: number;
  display: string;
  label: string;
}

interface PlottedSeries {
  index: number;
  label: string;
  color: string;
  points: Point[];
  /** `points` attribute for the SVG polyline, in the 0–100 viewBox. */
  polyline: string;
  /** Closed path for the area wash beneath the line. */
  area: string;
  /** The last point, which carries the direct end-label. */
  end: Point | null;
}

interface Tick {
  label: string;
  bottomPct: number;
}

/**
 * Multi-series line chart — SVG geometry, CSS-positioned markers. No charting
 * dependency, and every colour is a CSS variable, so `BrandingService` re-themes
 * it live.
 *
 * ## Why the lines are SVG but the dots are not
 *
 * The plot uses a `0 0 100 100` viewBox with `preserveAspectRatio="none"` so the
 * geometry stretches to whatever width the card gives it. That non-uniform scale
 * would turn a `<circle>` into an ellipse and squash the stroke, so the lines
 * carry `vector-effect="non-scaling-stroke"` to hold 2px, and the markers and
 * labels are HTML positioned in percentages instead — round at any width, and
 * crisp text at any size.
 *
 * ## Accessibility
 *
 * The app's categorical palette has one adjacent pair (chart-2 orange /
 * chart-3 green) in the CVD floor band, which is legal only with secondary
 * encoding. Present here: a legend for two or more series, a direct end-label
 * on each line, a surface ring on every marker so overlapping points stay
 * distinct, and a visually-hidden data table carrying the same figures as text.
 */
@Component({
  selector: 'app-line-chart',
  templateUrl: './line-chart.html',
  styleUrl: './line-chart.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LineChartComponent {
  readonly labels = input.required<string[]>();
  readonly series = input.required<ChartSeries[]>();
  readonly format = input<(value: number) => string>(formatInteger);
  /**
   * Anchor the value axis at zero.
   *
   * On by default because a truncated axis exaggerates change — the single most
   * common way a line chart misleads. Turn it off only when the reader is meant
   * to compare small movements in a narrow band and the caption says so.
   */
  readonly zeroAnchored = input(true);

  /**
   * Fill beneath each line.
   *
   * This is the whole difference between a line chart and an area chart: a line
   * says "how it moved", a filled area says "how much there was". Defaulted ON
   * so every existing caller keeps the wash it was drawn with; the AI report
   * turns it off for `line` and on for `area`, which is what makes the model's
   * choice between them mean something on screen.
   */
  readonly area = input(true);

  protected readonly active = signal<number | null>(null);

  protected readonly showLegend = computed(() => this.series().length > 1);

  protected readonly legend = computed(() =>
    this.series().map((s, i) => ({ label: s.label, color: s.color ?? paletteColor(i) })),
  );

  protected readonly scale = computed<ValueScale>(() =>
    valueScale(
      this.series().flatMap((s) => s.values),
      4,
      this.zeroAnchored(),
    ),
  );

  protected readonly ticks = computed<Tick[]>(() => {
    const scale = this.scale();
    return scale.ticks
      .map((value) => ({ label: formatCompact(value), bottomPct: percentOfScale(value, scale) }))
      .reverse();
  });

  protected readonly plotted = computed<PlottedSeries[]>(() => {
    const labels = this.labels();
    const scale = this.scale();
    const fmt = this.format();
    const count = labels.length;

    return this.series().map((s, index) => {
      const points: Point[] = labels.map((label, i) => {
        const value = s.values[i] ?? 0;
        return {
          // A single point sits in the middle rather than hard against the left
          // edge, where half the marker would be clipped.
          leftPct: count > 1 ? (i / (count - 1)) * 100 : 50,
          bottomPct: percentOfScale(value, scale),
          value,
          display: fmt(value),
          label,
        };
      });

      // SVG y grows downward; the model above measures up from the floor.
      const coords = points.map((p) => `${p.leftPct},${100 - p.bottomPct}`);
      const floor = 100 - percentOfScale(scale.min, scale);

      return {
        index,
        label: s.label,
        color: s.color ?? paletteColor(index),
        points,
        polyline: coords.join(' '),
        area: points.length
          ? `M ${points[0].leftPct},${floor} L ${coords.join(' L ')} L ${points[points.length - 1].leftPct},${floor} Z`
          : '',
        end: points.length ? points[points.length - 1] : null,
      };
    });
  });

  /**
   * Whether each line gets a direct end-label.
   *
   * Suppressed when the lines converge at the right edge: nudging labels apart
   * there detaches them from their lines and reads as noise, so the legend and
   * the hover titles carry identity instead.
   */
  protected readonly showEndLabels = computed(() => {
    const ends = this.plotted()
      .map((s) => s.end?.bottomPct)
      .filter((v): v is number => v !== undefined)
      .sort((a, b) => a - b);
    if (ends.length < 2) return ends.length === 1;
    return ends.every((v, i) => i === 0 || v - ends[i - 1] >= 12);
  });

  /** Markers are for reading individual points; past this they become a smear. */
  protected readonly showMarkers = computed(() => this.labels().length <= 24);

  protected opacity(index: number): number {
    const active = this.active();
    return active === null || active === index ? 1 : 0.2;
  }
}
