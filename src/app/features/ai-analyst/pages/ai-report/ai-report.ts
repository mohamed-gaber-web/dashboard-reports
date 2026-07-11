import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { PageHeaderComponent } from '../../../../shared/ui/page-header/page-header';
import { IconComponent } from '../../../../shared/ui/icon/icon';
import { SpinnerComponent } from '../../../../shared/ui/spinner/spinner';
import { EmptyStateComponent } from '../../../../shared/ui/empty-state/empty-state';
import { ChatPanelComponent } from '../../components/chat-panel/chat-panel';
import { DynamicReportComponent } from '../../components/dynamic-report/dynamic-report';
import { AiReportModel } from './ai-report.model';

/** AI Analyst screen — chat with Claude to build & export dashboard reports. */
@Component({
  selector: 'app-ai-report',
  imports: [
    PageHeaderComponent,
    IconComponent,
    SpinnerComponent,
    EmptyStateComponent,
    ChatPanelComponent,
    DynamicReportComponent,
  ],
  templateUrl: './ai-report.html',
  styleUrl: './ai-report.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [AiReportModel],
})
export class AiReportComponent {
  protected readonly model = inject(AiReportModel);

  protected readonly icons = {
    excel: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zM14 2v6h6M9 13l6 4m0-4-6 4',
    pdf: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zM14 2v6h6M9 15h6M9 18h4',
    spark:
      'M12 3v18M5.6 5.6l12.8 12.8M3 12h18M5.6 18.4 18.4 5.6',
  };
}
