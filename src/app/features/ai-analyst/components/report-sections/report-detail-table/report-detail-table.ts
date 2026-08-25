import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { DataTableComponent } from '../../../../../shared/ui/data-table/data-table';
import { TableResult } from '../../../models/report-spec.model';

/**
 * The detail rows behind the report.
 *
 * Capped and scrolled in place under a sticky header: a page of 100 rows would
 * otherwise push every chart above it off the screen. The cap is stated in
 * words, because a table is a PAGE of the answer and a reader who assumes
 * otherwise will draw the wrong conclusion from the last row they can see.
 */
@Component({
  selector: 'app-report-detail-table',
  imports: [DataTableComponent],
  templateUrl: './report-detail-table.html',
  styleUrl: './report-detail-table.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReportDetailTableComponent {
  readonly table = input.required<TableResult>();
  /** Any CSS length. Tighter in a compact report — see `dynamic-report`. */
  readonly maxHeight = input('min(26rem, 42vh)');
}
