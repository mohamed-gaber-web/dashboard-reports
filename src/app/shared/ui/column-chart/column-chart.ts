import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { ChartSeries } from '../../models/series.model';
import { paletteColor } from '../../models/chart.model';
import { formatInteger, formatCompact } from '../../utils/format.util';
import { ValueScale, percentOfScale, valueScale } from '../../utils/scale.util';

/** One column within a group. */
interface Column {
  seriesIndex: number;
  label: string;
  color: string;
  /** Height as a percentage of the plot area. */
  heightPct: number;
  value: number;
  display: string;
}

/** One category slot on the x-axis. */
interface ColumnGroup {
  label: string;
  columns: Column[];
}

interface Tick {
  label: string;
  /** Distance from the bottom of the plot, as a percentage. */
  bottomPct: number;
}

/**
 * Vertical column chart — grouped, multi-series, built from CSS. No charting
 * dependency, and every colour is a CSS variable, so `BrandingService` re-themes
 * it live.
 *
 * ## Why this exists alongside `app-bar-chart`
 *
 * They are different marks, not duplicates. `app-bar-chart` is HORIZONTAL and
 * single-series: the right form for "top N categories by one measure", where
 * long category names need the horizontal room. This is VERTICAL and
 * multi-series: the right form for a category axis you read left-to-right —
 * months, quarters, stages — and the only one of the two that can group.
 *
 * ## Accessibility
 *
 * The app's categorical palette has one adjacent pair (chart-2 orange /
 * chart-3 green) that sits in the CVD floor band, which is legal only with
 * secondary encoding. Three are present here and are not optional decoration:
 * a legend whenever there are two or more series, a 2px surface gap between
 * touching columns, and a `<title>` on every column naming its series and value.
 */
@Component({
  selector: 'app-column-chart',
  templateUrl: './column-chart.html',
  styleUrl: './column-chart.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ColumnChartComponent {
  readonly labels = input.required<string[]>();
  readonly series = input.required<ChartSeries[]>();
  /** How to render each value. */
  readonly format = input<(value: number) => string>(formatInteger);

  /** Legend/column hover pairing — hovering either dims the other series. */
  protected readonly active = signal<number | null>(null);

  /** Two or more series need a legend; one is already named by the card title. */
  protected readonly showLegend = computed(() => this.series().length > 1);

  /**
   * Legend entries with their colour already resolved. The template must not
   * fall back to `paletteColor` itself — doing it in two places is how a legend
   * swatch ends up a different colour from the column it names.
   */
  protected readonly legend = computed(() =>
    this.series().map((s, i) => ({ label: s.label, color: s.color ?? paletteColor(i) })),
  );

  protected readonly scale = computed<ValueScale>(() =>
    valueScale(this.series().flatMap((s) => s.values)),
  );

  protected readonly ticks = computed<Tick[]>(() => {
    const scale = this.scale();
    return scale.ticks
      .map((value) => ({
        label: formatCompact(value),
        bottomPct: percentOfScale(value, scale),
      }))
      // Top to bottom, so the DOM order matches the visual order for a
      // screen reader walking the axis.
      .reverse();
  });

  protected readonly groups = computed<ColumnGroup[]>(() => {
    const labels = this.labels();
    const series = this.series();
    const scale = this.scale();
    const fmt = this.format();
    const zeroPct = percentOfScale(0, scale);

    return labels.map((label, i) => ({
      label,
      columns: series.map((s, seriesIndex) => {
        const value = s.values[i] ?? 0;
        return {
          seriesIndex,
          label: s.label,
          color: s.color ?? paletteColor(seriesIndex),
          // Measured from the zero line, so a negative value draws downward
          // instead of vanishing.
          heightPct: Math.abs(percentOfScale(value, scale) - zeroPct),
          value,
          display: fmt(value),
        };
      }),
    }));
  });

  /**
   * Whether a value label sits on every column cap.
   *
   * Direct labels work *because* they are sparing — a number on every column of
   * a dense chart is noise that goes unread, and at this width they would
   * collide outright. Past a dozen columns the gridlines and the hover title
   * carry the values instead.
   */
  protected readonly showValueLabels = computed(
    () => this.groups().reduce((n, g) => n + g.columns.length, 0) <= 12,
  );

  /** Columns sit above the zero line; only a negative one hangs below it. */
  protected readonly zeroPct = computed(() => percentOfScale(0, this.scale()));

  protected opacity(seriesIndex: number): number {
    const active = this.active();
    return active === null || active === seriesIndex ? 1 : 0.25;
  }
}
