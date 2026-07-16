import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { StatusBadgeComponent } from '../status-badge/status-badge';
import { TableColumn } from '../../models/table-column.model';
import { BadgeTone } from '../../models/badge.model';

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
