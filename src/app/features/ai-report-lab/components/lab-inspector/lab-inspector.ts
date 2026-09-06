import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { IconComponent } from '../../../../shared/ui/icon/icon';

type InspectorTab = 'context' | 'html';

/**
 * The development inspector: exactly what was sent to the model, and exactly what
 * came back.
 *
 * ## Why this exists
 *
 * Two of the prototype's requirements are only checkable by eye.
 *
 * **"Make it obvious which data is sent to Claude."** The whole grounding
 * argument rests on the model receiving nothing but the schema, real aggregates
 * and five sample rows. That claim is worth nothing if verifying it means reading
 * a JSON blob out of the network tab, so the Markdown context is rendered here,
 * verbatim — the same string the endpoint embeds in its system prompt.
 *
 * **"Help us evaluate whether the generated HTML itself is good."** The rendered
 * report can look excellent and still be built from 900 lines of duplicated
 * inline styles. The markup is the thing being evaluated, so it is readable
 * without opening dev tools.
 *
 * ## Why it is easy to remove
 *
 * It is mounted behind a single `@if (showDebug)` in the page, where `showDebug`
 * is `!environment.production` — a build-time constant. It renders nothing in
 * production, so no internal schema or prompt ever reaches a user's screen, and
 * deleting the feature is deleting one directory and one template block.
 *
 * Presentational: it holds a tab and a collapsed flag, and reads no service.
 */
@Component({
  selector: 'app-lab-inspector',
  imports: [IconComponent],
  templateUrl: './lab-inspector.html',
  styleUrl: './lab-inspector.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LabInspectorComponent {
  /** The Markdown context block, exactly as sent. Null before the data lands. */
  readonly context = input<string | null>(null);
  /** The document fragment, exactly as the model wrote it (after repairs). */
  readonly html = input<string | null>(null);

  protected readonly open = signal(false);
  protected readonly tab = signal<InspectorTab>('context');
  protected readonly copied = signal(false);

  protected readonly icons = {
    inspect: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.35-4.35',
    chevron: 'm6 9 6 6 6-6',
    copy: 'M9 9h10v10H9zM5 15V5h10',
    check: 'M20 6 9 17l-5-5',
  };

  /** Size of the current tab's payload — the number that answers "is this huge?". */
  protected readonly size = computed(() => {
    const value = this.body();
    return value ? `${Math.max(1, Math.round(value.length / 1024)).toLocaleString()} KB` : '—';
  });

  protected readonly body = computed(() =>
    this.tab() === 'context' ? (this.context() ?? '') : (this.html() ?? ''),
  );

  protected readonly placeholder = computed(() =>
    this.tab() === 'context'
      ? 'Nothing yet — the context is built once the module’s row count and aggregates have loaded.'
      : 'Nothing yet — generate a report and its markup appears here.',
  );

  protected toggle(): void {
    this.open.update((v) => !v);
  }

  protected select(tab: InspectorTab): void {
    this.tab.set(tab);
  }

  protected async copy(): Promise<void> {
    const text = this.body();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 1600);
    } catch {
      // Clipboard denied (insecure origin, or the user said no). The text is on
      // screen and selectable, so there is nothing useful to report.
    }
  }
}
