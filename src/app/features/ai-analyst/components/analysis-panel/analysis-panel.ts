import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { IconComponent } from '../../../../shared/ui/icon/icon';
import { Analysis } from '../../models/analysis.model';

/**
 * The written analysis, shown above the computed report.
 *
 * This is the only place in the app where prose from the model is presented as
 * content rather than as chat. It is therefore labelled as written by AI, and
 * carries the reminder that the figures beside it are computed — the distinction
 * that makes the narrative safe to show at all.
 */
@Component({
  selector: 'app-analysis-panel',
  imports: [IconComponent],
  templateUrl: './analysis-panel.html',
  styleUrl: './analysis-panel.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AnalysisPanelComponent {
  readonly analysis = input.required<Analysis>();

  protected readonly icons = {
    sparkle:
      'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z M5 3v4M3 5h4M19 17v4M17 19h4',
    check: 'M20 6 9 17l-5-5',
  };
}
