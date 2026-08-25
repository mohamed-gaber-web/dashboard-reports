import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * A paragraph of the model's own prose, inside the report.
 *
 * This is what lets "why did sales decrease?" answer in the shape the question
 * has — a sentence of explanation above the metrics that support it — instead
 * of a dashboard with the explanation exiled to a panel somewhere else.
 *
 * The body is bound with `{{ }}`, never `[innerHTML]`. It is untrusted model
 * output and this contract has no markdown in it, so interpolation is both
 * simpler and strictly safer. (The chat panel renders Markdown only because
 * `markdown.util` escapes before emitting any markup.)
 */
@Component({
  selector: 'app-report-narrative',
  templateUrl: './report-narrative.html',
  styleUrl: './report-narrative.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReportNarrativeComponent {
  readonly body = input.required<string>();
}
