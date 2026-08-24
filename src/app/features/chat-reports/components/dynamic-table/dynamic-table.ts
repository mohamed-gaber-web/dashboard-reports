import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { DataTableComponent } from '../../../../shared/ui/data-table/data-table';
import { TableColumn } from '../../../../shared/models/table-column.model';
import { numericValue } from '../../../../shared/utils/compare.util';
import { TableComponentSpec } from '../../models/report-payload.model';

/** A payload row, keyed so the shared table can address it by column. */
type Row = Record<string, string>;

/**
 * Renders one `table` node from the payload — sortable, sticky-headed.
 *
 * ## Adapter, not a table
 *
 * The payload carries POSITIONAL data: `headers: string[]` and
 * `rows: string[][]`. The shared `app-data-table` is driven by keyed
 * `TableColumn` definitions. This component is the adapter between the two,
 * which is the whole reason it exists — hand-rolling a second table here would
 * have been drift, and the shared one already owns sticky headers, the scroll
 * shadow, zebra striping, the empty state, and now sorting.
 *
 * Sorting was added to `app-data-table` rather than built here, so every screen
 * in the app gets it. It is opt-in at both levels and off by default, so no
 * existing table changed behaviour.
 */
@Component({
  selector: 'app-dynamic-table',
  imports: [DataTableComponent],
  templateUrl: './dynamic-table.html',
  styleUrl: './dynamic-table.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DynamicTableComponent {
  readonly spec = input.required<TableComponentSpec>();

  /**
   * Cap the height and scroll the rows inside it. The shared table's header is
   * sticky, so a long table never scrolls its own column names away.
   */
  readonly maxHeight = input('22rem');

  /**
   * Positional index → synthetic key. Column headers are model-authored and can
   * repeat, collide with `__proto__`, or be empty, so they are never used as
   * object keys.
   */
  private static key(index: number): string {
    return `c${index}`;
  }

  protected readonly columns = computed<TableColumn<Row>[]>(() => {
    const spec = this.spec();
    return spec.headers.map((header, i) => {
      const key = DynamicTableComponent.key(i);
      return {
        key,
        header,
        // Right-align a column whose cells read as quantities. A column of
        // numbers aligned left is hard to compare down the page.
        align: this.isNumericColumn(i) ? 'right' : 'left',
        sortable: true,
        // Sort "$4,350" as 4350, not as a string beginning with a dollar sign.
        // Without this "92" sorts after "145" and the column looks broken.
        sortValue: (value) => numericValue(String(value ?? '')) ?? String(value ?? ''),
      } satisfies TableColumn<Row>;
    });
  });

  protected readonly rows = computed<Row[]>(() =>
    this.spec().rows.map((cells) => {
      const row: Row = {};
      cells.forEach((cell, i) => (row[DynamicTableComponent.key(i)] = cell));
      return row;
    }),
  );

  protected readonly caption = computed(() => {
    const count = this.spec().rows.length;
    return `${count.toLocaleString()} ${count === 1 ? 'row' : 'rows'}`;
  });

  /**
   * Whether every non-blank cell in a column parses as a quantity.
   *
   * Every cell must qualify — one stray "n/a" does not make a numeric column
   * text, but a column of names with a single "2024" in it is not numeric, and
   * requiring all of them is the check that tells those apart.
   */
  private isNumericColumn(index: number): boolean {
    const key = DynamicTableComponent.key(index);
    const values = this.rows()
      .map((row) => row[key])
      .filter((v) => v !== undefined && v.trim() !== '');
    return values.length > 0 && values.every((v) => numericValue(v) !== null);
  }
}
