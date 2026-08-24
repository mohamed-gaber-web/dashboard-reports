import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { StatusBadgeComponent } from '../status-badge/status-badge';
import { TableColumn } from '../../models/table-column.model';
import { BadgeTone } from '../../models/badge.model';
import { compareValues } from '../../utils/compare.util';

/** Which column is sorted, and which way. */
interface SortState {
  key: string;
  direction: 'asc' | 'desc';
}

/** Generic, declarative data table driven by {@link TableColumn} definitions. */
@Component({
  selector: 'app-data-table',
  imports: [StatusBadgeComponent],
  templateUrl: './data-table.html',
  styleUrl: './data-table.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DataTableComponent<T> {
  readonly columns = input.required<TableColumn<T>[]>();
  readonly rows = input.required<readonly T[]>();
  readonly emptyMessage = input('No records match the current filters.');
  /**
   * Cap the table's height (any CSS length) and scroll the rows inside it. The
   * header sticks, so a long page of rows never scrolls its own column names
   * away. Unset = the table grows with its content.
   */
  readonly maxHeight = input<string>();
  /** Alternate row tinting — earns its keep on wide or repetitive rows. */
  readonly zebra = input(false);

  /**
   * Drop the card chrome. For a table that is already inside a padded sheet,
   * where its own border would be the second one drawn in the same place.
   */
  readonly bare = input(false);

  /**
   * Enable click-to-sort on columns marked `sortable`.
   *
   * Off by default, so every table that existed before this input keeps its
   * behaviour exactly. Both switches must be on for a column to sort — the
   * table opts into the feature, each column opts into being sorted by.
   */
  readonly sortable = input(false);

  /**
   * Which column is sorted. UI-only state: nothing outside this component reads
   * it, and it resets with the component, which is what NG-ARCH-05 permits a
   * View to own.
   */
  private readonly sort = signal<SortState | null>(null);

  /**
   * Whether the scroll container has left the top. Drives the shadow under the
   * sticky header, so the header separates itself only while rows are actually
   * passing beneath it — a permanent shadow just looks like a stray border.
   */
  protected readonly scrolled = signal(false);

  /**
   * Rows in display order.
   *
   * Returns the input array untouched when nothing is sorted, so an unsorted
   * table costs no copy. When sorting, it sorts a COPY — mutating an `input()`
   * array would reorder the caller's own data behind its back.
   */
  protected readonly displayRows = computed<readonly T[]>(() => {
    const rows = this.rows();
    const sort = this.sort();
    if (!sort || !this.sortable()) return rows;

    const column = this.columns().find((c) => c.key === sort.key);
    if (!column?.sortable) return rows;

    const factor = sort.direction === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const left = column.sortValue ? column.sortValue(this.raw(a, column), a) : this.raw(a, column);
      const right = column.sortValue ? column.sortValue(this.raw(b, column), b) : this.raw(b, column);
      return compareValues(left, right) * factor;
    });
  });

  protected canSort(col: TableColumn<T>): boolean {
    return this.sortable() && col.sortable === true;
  }

  /** Cycle a column: unsorted → ascending → descending → unsorted. */
  protected toggleSort(col: TableColumn<T>): void {
    if (!this.canSort(col)) return;
    this.sort.update((current) => {
      if (current?.key !== col.key) return { key: col.key, direction: 'asc' };
      if (current.direction === 'asc') return { key: col.key, direction: 'desc' };
      // Third click clears it, so the original order is always reachable
      // without reloading the screen.
      return null;
    });
  }

  protected sortDirection(col: TableColumn<T>): 'asc' | 'desc' | null {
    const sort = this.sort();
    return sort?.key === col.key ? sort.direction : null;
  }

  /** `aria-sort` for the header cell — how a screen reader reads the state. */
  protected ariaSort(col: TableColumn<T>): 'ascending' | 'descending' | 'none' | null {
    if (!this.canSort(col)) return null;
    const direction = this.sortDirection(col);
    return direction === 'asc' ? 'ascending' : direction === 'desc' ? 'descending' : 'none';
  }

  protected onScroll(event: Event): void {
    this.scrolled.set((event.target as HTMLElement).scrollTop > 0);
  }

  protected display(row: T, col: TableColumn<T>): string {
    const raw = this.raw(row, col);
    if (col.format) return col.format(raw, row);
    return raw == null || raw === '' ? '—' : String(raw);
  }

  protected tone(row: T, col: TableColumn<T>): BadgeTone {
    return col.tone ? col.tone(this.raw(row, col), row) : 'neutral';
  }

  protected alignClass(col: TableColumn<T>): string {
    return col.align === 'right'
      ? 'text-right'
      : col.align === 'center'
        ? 'text-center'
        : 'text-left';
  }

  private raw(row: T, col: TableColumn<T>): T[keyof T] {
    return (row as Record<string, unknown>)[col.key] as T[keyof T];
  }
}
