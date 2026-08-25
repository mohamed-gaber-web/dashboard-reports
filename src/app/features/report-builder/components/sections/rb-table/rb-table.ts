import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { DataTableComponent } from '../../../../../shared/ui/data-table/data-table';
import { TableBlockResult } from '../../../models/report-definition.model';

/**
 * The detail rows behind the report.
 *
 * It is capped — this is the RENDERED page, not the answer. The cap is stated
 * beneath the table rather than implied, because a table that silently shows the
 * first hundred of eleven million rows while looking complete is the single most
 * misleading thing a report can contain. The "every row" export is a separate,
 * explicit action.
 */
@Component({
  selector: 'app-rb-table',
  imports: [DataTableComponent],
  templateUrl: './rb-table.html',
  styleUrl: './rb-table.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RbTableComponent {
  readonly table = input.required<TableBlockResult>();
  readonly maxHeight = input('min(26rem, 42vh)');

  protected readonly shown = computed(() => this.table().displayRows.length);
  protected readonly truncated = computed(() => this.table().total > this.shown());
}
