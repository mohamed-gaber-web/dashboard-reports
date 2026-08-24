import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { KpiItem } from '../../models/report-payload.model';

/**
 * A row of metric tiles with delta badges.
 *
 * ## Why this is not `app-kpi-card`
 *
 * The shared `app-kpi-card` is a hero tile: a full-bleed gradient fill and a
 * 2.15rem figure, built to lead a dashboard page. Two things rule it out here.
 * It has no delta channel, which is half of this contract. And a chat
 * transcript stacks many reports vertically — a column of gradient heroes turns
 * every reply into a billboard and leaves nothing quieter to contrast against.
 * "Exactly one hero figure per view" is the rule this would break on turn two.
 *
 * So this is the compact sibling: same tokens, same radius language, a tenth of
 * the visual weight, plus the delta the contract needs.
 */
@Component({
  selector: 'app-kpi-grid',
  templateUrl: './kpi-grid.html',
  styleUrl: './kpi-grid.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class KpiGridComponent {
  readonly items = input.required<KpiItem[]>();

  /**
   * Column count, chosen from the tile count so a lone tile does not stretch
   * across the bubble and four do not squeeze into a column each.
   *
   * `@`-prefixed breakpoints measure the CONTAINER, not the viewport — the
   * chat column is much narrower than the window, so viewport breakpoints would
   * read "desktop" and pack four tiles into a 30rem bubble.
   */
  protected readonly columns = computed(() => {
    const count = this.items().length;
    if (count <= 1) return 'grid-cols-1';
    if (count === 2) return 'grid-cols-2';
    if (count === 3) return 'grid-cols-2 @lg:grid-cols-3';
    return 'grid-cols-2 @lg:grid-cols-4';
  });
}
