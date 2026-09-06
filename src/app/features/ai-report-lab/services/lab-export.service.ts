import { Injectable } from '@angular/core';
import { GeneratedReportArtifact, LabExportFormat } from '../models/report-artifact.model';
import { artifactFilename, buildArtifactDocument } from './artifact-document';

/** Raised when the browser refused to open a print job. Carries the way out. */
export class PrintUnavailableError extends Error {
  constructor() {
    super(
      'Your browser blocked the print dialog. Use “Export HTML” instead, then open the file and ' +
        'print it from there — it is the same document.',
    );
    this.name = 'PrintUnavailableError';
  }
}

/**
 * Turns a generated report into a file.
 *
 * ## One source, two formats
 *
 * Both exports render `buildArtifactDocument(artifact)` — the same string the
 * preview iframe shows. There is no second renderer and no format-specific
 * markup, so a PDF cannot come out looking like a different report from the one
 * the user approved on screen.
 *
 * ## Why PDF is a print job and not a library
 *
 * The document is already a complete, self-contained HTML page with its own
 * `@page` rules. Handing it to the browser's print engine gives real text (not a
 * rasterised screenshot), selectable and searchable, with the page breaks the
 * report asked for — for zero dependencies. A canvas-based PDF library would
 * cost megabytes and produce a picture of a report.
 *
 * ## Why the print frame is sandboxed, and with WHICH flags
 *
 * The obvious implementation is `window.open()` + `document.write()`. It is also
 * the wrong one: `about:blank` inherits the OPENER'S ORIGIN, so model-authored
 * markup would run as this application — with its `localStorage`, its cookies and
 * its D365 bearer token in reach. That is precisely the capability the preview
 * iframe exists to deny, and an export path is a poor place to hand it back.
 *
 * So printing goes through a hidden iframe with `sandbox="allow-same-origin
 * allow-modals"`:
 *
 *   NO `allow-scripts`  — script in the document never executes. This is what
 *                         makes `allow-same-origin` safe here; the pair that is
 *                         famously equivalent to no sandbox at all is
 *                         `allow-scripts` **together with** `allow-same-origin`,
 *                         and that combination is never used in this feature.
 *   `allow-same-origin` — lets THIS code reach `contentWindow.print()`. Without
 *                         it the frame has an opaque origin and the parent cannot
 *                         call into it, so there is no way to start the job.
 *   `allow-modals`      — the sandboxed-modals flag blocks `print()` outright.
 *
 * The document's own `default-src 'none'` policy still applies, so it cannot load
 * or contact anything while it is being printed.
 */
@Injectable({ providedIn: 'root' })
export class LabExportService {
  /**
   * How long to leave the print frame in the DOM when `afterprint` never fires.
   *
   * Some browsers fire it on dialog dismissal, some fire it late, and some never
   * fire it at all for a frame. Removing the frame while the job is still being
   * spooled cancels the print, so the fallback is deliberately generous — an
   * invisible, inert, scriptless iframe costs nothing to leave sitting there.
   */
  private static readonly PRINT_CLEANUP_MS = 120_000;

  async export(format: LabExportFormat, artifact: GeneratedReportArtifact): Promise<void> {
    if (format === 'html') {
      this.exportHtml(artifact);
      return;
    }
    await this.exportPdf(artifact);
  }

  /**
   * The document as a file the user keeps.
   *
   * It is standalone by construction: the fragment carries its own CSS and inline
   * SVG, the wrapper adds the charset and the policy, and the parser has already
   * removed anything pointing at a URL. Nothing of the Angular shell goes with
   * it — opening the file offline renders exactly what the preview showed.
   */
  exportHtml(artifact: GeneratedReportArtifact): void {
    const blob = new Blob([buildArtifactDocument(artifact)], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');

    link.href = url;
    link.download = artifactFilename(artifact, 'html');
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    link.remove();

    // Revoked on the next frame: revoking synchronously can beat the download
    // starting in some browsers.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  /**
   * The same document, sent to the browser's print engine.
   *
   * The frame is given A4 proportions so the document lays out at roughly the
   * page width before printing — a frame sized to nothing would resolve every
   * `min-width` media query against a sliver and print the mobile layout.
   */
  exportPdf(artifact: GeneratedReportArtifact): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const frame = document.createElement('iframe');

      // A STATIC attribute, set before the document loads. Same discipline as the
      // preview component: the sandbox must never be something that could be
      // weakened after the fact.
      frame.setAttribute('sandbox', 'allow-same-origin allow-modals');
      frame.setAttribute('aria-hidden', 'true');
      frame.setAttribute('title', 'Print preview');

      // Off-screen rather than hidden. `display:none` and `visibility:hidden`
      // both stop the browser laying the document out, and an unlaid-out
      // document prints blank.
      frame.style.cssText =
        'position:fixed;left:-10000px;top:0;width:210mm;height:297mm;border:0;pointer-events:none;';

      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (error) frame.remove();
        else setTimeout(() => frame.remove(), LabExportService.PRINT_CLEANUP_MS);
        error ? reject(error) : resolve();
      };

      frame.addEventListener('load', () => {
        try {
          const win = frame.contentWindow;
          if (!win) throw new PrintUnavailableError();
          win.focus();
          win.print();
          finish();
        } catch {
          finish(new PrintUnavailableError());
        }
      });

      frame.addEventListener('error', () => finish(new PrintUnavailableError()));

      document.body.appendChild(frame);
      // Assigned as a DOM property, so no Angular binding and no sanitiser is
      // involved. The sandbox above is already on the element.
      frame.srcdoc = buildArtifactDocument(artifact);
    });
  }
}
