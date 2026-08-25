import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { IconComponent } from '../../../../shared/ui/icon/icon';

/**
 * Renders a model-authored HTML report inside a fully-restricted iframe.
 *
 * ## Why an iframe and not `[innerHTML]`
 *
 * Two independent reasons, and both are decisive on their own.
 *
 * **Safety.** This markup is written by an LLM from data that includes customer
 * names and free-text fields. Put into the application's DOM it would be one
 * successful injection away from reading the D365 bearer token out of memory or
 * rewriting the page around it. In a `sandbox`ed frame with no `allow-scripts`
 * and no `allow-same-origin`, script is inert, the origin is opaque, and the
 * document cannot reach the parent, its storage, or its cookies. The frame is
 * the trust boundary — not a sanitiser, which is a list of things someone
 * remembered to block.
 *
 * **Fidelity.** Angular's HTML sanitiser strips `<style>` outright and most of
 * an inline `<svg>` with it, so `[innerHTML]` would not render this report — it
 * would render a stack of unstyled Arabic text. The frame is what lets the
 * document keep its own stylesheet, its own charts and its own reading
 * direction without any of that leaking into the app's CSS.
 *
 * ## Why `bypassSecurityTrustHtml` is correct here
 *
 * Angular treats `iframe[srcdoc]` as an HTML sink and sanitises it, which would
 * strip the document for no gain: the sandbox has already removed the capability
 * the sanitiser exists to remove. Bypassing it is therefore narrowing the
 * defence to one mechanism that actually works, not removing the only one. The
 * `sandbox` attribute is written STATICALLY in the template because Angular
 * refuses it as a binding — a rule that exists precisely so it cannot be
 * weakened at runtime.
 *
 * ## Why the height is controlled from out here
 *
 * A frame cannot size itself to its content without script, and script is the
 * thing being denied. So the parent owns the height: a tall default with the
 * document scrolling inside it, and an expand toggle for reading it in full.
 * That is a small cost for keeping the sandbox absolute.
 */
@Component({
  selector: 'app-html-document',
  imports: [IconComponent],
  templateUrl: './html-document.html',
  styleUrl: './html-document.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HtmlDocumentComponent {
  readonly html = input.required<string>();
  readonly title = input<string>();

  private readonly sanitizer = inject(DomSanitizer);

  protected readonly expanded = signal(false);

  protected readonly icons = {
    expand: 'M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7',
    collapse: 'M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7',
  };

  protected readonly frameTitle = computed(() => this.title() || 'Generated report');

  /**
   * The fragment wrapped in the minimum document it needs.
   *
   * The model is told not to send `<html>`/`<head>`/`<body>`, so they are added
   * here — along with the charset (the content is Arabic; without it a byte-wise
   * fallback renders mojibake), the RTL direction, and a `base` that sends any
   * link to a new tab, since a sandboxed frame cannot navigate itself anywhere
   * useful anyway.
   *
   * The reset is minimal on purpose: this document brings its own design, and
   * anything opinionated here would fight it.
   */
  protected readonly srcdoc = computed<SafeHtml>(() =>
    this.sanitizer.bypassSecurityTrustHtml(
      [
        '<!doctype html>',
        '<html dir="rtl" lang="ar">',
        '<head>',
        '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        '<base target="_blank">',
        '<style>',
        'html,body{margin:0;padding:0;background:#fff;',
        '-webkit-text-size-adjust:100%;text-size-adjust:100%}',
        'img,svg{max-width:100%}',
        '</style>',
        '</head>',
        '<body>',
        this.html(),
        '</body>',
        '</html>',
      ].join(''),
    ),
  );

  protected toggle(): void {
    this.expanded.update((open) => !open);
  }
}
