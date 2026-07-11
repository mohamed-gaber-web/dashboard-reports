import { BadgeTone } from './badge.model';

/** Declarative column definition for {@link DataTableComponent}. */
export interface TableColumn<T> {
  /** Property on the row to read. */
  key: keyof T & string;
  /** Column heading. */
  header: string;
  /** Text alignment; numbers usually want `right`. */
  align?: 'left' | 'right' | 'center';
  /** How to render the cell — plain text or a coloured status badge. */
  kind?: 'text' | 'badge';
  /** Format the raw value for display (e.g. thousands separators). */
  format?: (value: T[keyof T], row: T) => string;
  /** For `badge` columns: map the value/row to a colour tone. */
  tone?: (value: T[keyof T], row: T) => BadgeTone;
}
