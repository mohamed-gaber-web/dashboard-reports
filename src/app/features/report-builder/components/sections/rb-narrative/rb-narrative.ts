import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * A paragraph of the model's own prose, inside the report.
 *
 * This is what lets "why did sales decrease?" answer in the shape the question
 * has — a sentence of explanation above the figures that support it — instead of
 * a dashboard with the explanation exiled to a panel somewhere else.
 *
 * The body is bound with `{{ }}`, **never** `[innerHTML]`. It is untrusted model
 * output and this contract has no markdown in it, so interpolation is both
 * simpler and strictly safer. (The conversation renders Markdown only because
 * `markdown.util` escapes before it emits any markup.)
 */
@Component({
  selector: 'app-rb-narrative',
  templateUrl: './rb-narrative.html',
  styleUrl: './rb-narrative.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RbNarrativeComponent {
  readonly body = input.required<string>();
  /** The opening block of a report reads as its lede and is set one step larger. */
  readonly lede = input(false);
}
