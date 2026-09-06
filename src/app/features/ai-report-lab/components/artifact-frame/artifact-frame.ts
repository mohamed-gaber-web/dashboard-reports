import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { PREVIEW_WIDTHS, PreviewWidth } from '../../models/report-artifact.model';

/**
 * Renders a model-authored HTML/SVG report inside a fully-restricted iframe.
 *
 * **This component is the security boundary of the whole prototype.** Everything
 * else — the parser's repairs, the document's content-security policy — is depth
 * behind it.
 *
 * ## Why an iframe and not `[innerHTML]`
 *
 * Two independent reasons, either one decisive.
 *
 * **Safety.** This markup is written by an LLM from data containing customer
 * names and free text. Placed in the application's DOM it would be one successful
 * injection away from reading the D365 bearer token out of memory, calling the
 * app's own APIs with it, or rewriting the page around it. In a `sandbox`ed frame
 * script is inert, the origin is opaque, and the document can reach neither the
 * parent, nor its storage, nor its cookies. That is a capability boundary the
 * browser enforces — not a sanitiser, which is a list of things someone
 * remembered to block.
 *
 * **Fidelity.** Angular's sanitiser strips `<style>` outright and most of an
 * inline `<svg>` with it. `[innerHTML]` would not render this report; it would
 * render a stack of unstyled paragraphs where the charts used to be. The frame is
 * what lets the document keep its own stylesheet and its own graphics without any
 * of it leaking into the app's CSS.
 *
 * ## Why the sandbox is EMPTY, and not `allow-scripts`
 *
 * `sandbox=""` applies every restriction. The brief suggested `allow-scripts`,
 * and this deliberately does not take it, because the rule it also states —
 * enable only what is required — decides the question:
 *
 * - The report contract forbids `<script>` outright and asks for inline SVG, so
 *   nothing in a conforming document needs scripting. Granting it buys no
 *   capability the report is allowed to use.
 * - Script in an opaque-origin frame still cannot reach this app — but it CAN
 *   still make outbound requests, and a URL is a channel. Denying scripting
 *   removes that class of problem rather than mitigating it.
 *
 * The one thing scripting would buy is a frame that measures and reports its own
 * height. That is paid for below instead. **If a future iteration genuinely needs
 * interactivity, this is the single line to change** — and the document's
 * `default-src 'none'` policy would then become the thing holding the network
 * shut, so it must not be relaxed at the same time.
 *
 * `sandbox` is written as a STATIC attribute in the template because Angular
 * refuses it as a binding — a rule that exists precisely so it cannot be weakened
 * at runtime, and this component depends on it rather than working around it.
 *
 * ## Why `bypassSecurityTrustHtml` is correct here
 *
 * Angular treats `iframe[srcdoc]` as an HTML sink and sanitises it, which would
 * strip the document for no gain: the sandbox has already removed the capability
 * the sanitiser exists to remove. Bypassing it narrows the defence to the
 * mechanism that actually works; it does not remove the only one.
 *
 * ## Why the height is controlled from out here
 *
 * A frame cannot size itself to its content without script, and script is the
 * thing being denied. So the parent owns the height: the frame fills the preview
 * pane and the document scrolls inside it, exactly as it would in a browser tab.
 * That is a small cost for keeping the sandbox absolute — and the device widths
 * turn it into a feature, because constraining a real nested browsing context is
 * how the report's responsiveness gets CHECKED rather than assumed.
 */
@Component({
  selector: 'app-artifact-frame',
  templateUrl: './artifact-frame.html',
  styleUrl: './artifact-frame.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ArtifactFrameComponent {
  /** The COMPLETE document — see `artifact-document.ts`. Never a bare fragment. */
  readonly document = input.required<string>();
  readonly title = input<string>('Generated report');
  readonly width = input<PreviewWidth>('desktop');

  private readonly sanitizer = inject(DomSanitizer);

  /**
   * The frame's maximum width, as a CSS length.
   *
   * A real width on a real nested browsing context, so the document's own media
   * queries resolve against it — which is the only honest way to check that a
   * generated report reflows. Scaling a screenshot would not.
   */
  protected readonly maxWidth = computed(() => {
    const px = PREVIEW_WIDTHS.find((w) => w.id === this.width())?.px;
    return px ? `${px}px` : '100%';
  });

  protected readonly srcdoc = computed<SafeHtml>(() =>
    this.sanitizer.bypassSecurityTrustHtml(this.document()),
  );
}
