import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { IconComponent } from '../../../../../shared/ui/icon/icon';
import { formatSignedPercent } from '../../../../../shared/utils/format.util';
import { TimelinePoint } from '../../../models/report-definition.model';

/**
 * Period-by-period movement, newest first.
 *
 * This is the section that answers "WHEN did it change?". A line chart shows the
 * shape of a series and leaves the reader to estimate each move off the pixels;
 * a timeline states each period's figure and how far it moved from the one
 * before. Both are legitimate; they answer different questions, which is why
 * this exists alongside `app-rb-chart` rather than instead of it.
 *
 * The first (oldest visible) period may still carry a change: the composer
 * reaches back into the full series for its baseline, so an entry only reads
 * "—" when there genuinely is no earlier period to compare with.
 *
 * Direction is never coloured good or bad. A timeline has no `goodDirection` —
 * it is a description of what happened, and painting every rise green would be
 * the same lie a comparison block is careful not to tell.
 */
@Component({
  selector: 'app-rb-timeline',
  imports: [IconComponent],
  templateUrl: './rb-timeline.html',
  styleUrl: './rb-timeline.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RbTimelineComponent {
  readonly points = input.required<TimelinePoint[]>();
  readonly measureLabel = input.required<string>();

  protected readonly icons = {
    up: 'M12 19V5M5 12l7-7 7 7',
    down: 'M12 5v14M19 12l-7 7-7-7',
    flat: 'M5 12h14',
  };

  protected arrow(point: TimelinePoint): string {
    return this.icons[point.direction];
  }

  protected change(point: TimelinePoint): string {
    return point.changePercent === null ? '—' : formatSignedPercent(point.changePercent);
  }
}
