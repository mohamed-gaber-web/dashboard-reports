import { describe, expect, it } from 'vitest';
import { GeneratedReportArtifact } from '../models/report-artifact.model';
import { artifactFilename, buildArtifactDocument } from './artifact-document';

/**
 * The document wrapper's tests.
 *
 * This function is the single source of truth behind the preview, the HTML export
 * and the PDF, so the properties worth asserting are the ones that would silently
 * differ between them if anyone ever added a second renderer: the policy is
 * present, the provenance is present, and the report's own markup is untouched.
 */

const ARTIFACT: GeneratedReportArtifact = {
  title: 'Where the backorder units sit',
  html: '<div class="rl-report"><style>.rl-report{font-size:16px}</style><h1>Backorders</h1></div>',
  summary: 'Three customers hold half the remaining units.',
  metadata: {
    module: 'sales-order',
    moduleLabel: 'Sales Order',
    generatedAt: '2026-09-06T10:30:00.000Z',
    provider: 'Claude',
    slice: 'dates from 2025-01-01 to 2025-03-31',
  },
};

describe('buildArtifactDocument', () => {
  it('produces a complete standalone document', () => {
    const doc = buildArtifactDocument(ARTIFACT);

    expect(doc.startsWith('<!doctype html>')).toBe(true);
    expect(doc).toContain('<meta charset="utf-8">');
    expect(doc).toContain('name="viewport"');
    expect(doc.trimEnd().endsWith('</html>')).toBe(true);
  });

  it('carries a policy that denies everything the report does not need', () => {
    // The sandbox stops script; only this stops a remote <img>, which loads
    // happily from an opaque origin and whose URL is an exfiltration channel.
    const doc = buildArtifactDocument(ARTIFACT);

    expect(doc).toContain('http-equiv="Content-Security-Policy"');
    expect(doc).toContain("default-src 'none'");
    expect(doc).toContain("style-src 'unsafe-inline'");
    expect(doc).toContain('img-src data:');
    // Directives that are IGNORED in a meta CSP must not be there, or a reader
    // is taught that the whole header is being ignored.
    expect(doc).not.toContain('frame-ancestors');
    expect(doc).not.toContain('sandbox');
  });

  it('passes the report’s own markup through untouched', () => {
    expect(buildArtifactDocument(ARTIFACT)).toContain(ARTIFACT.html);
  });

  it('states its provenance on every copy', () => {
    // The exported file is the copy that gets forwarded to someone who never saw
    // the screen; without this it is indistinguishable from a verified report.
    const doc = buildArtifactDocument(ARTIFACT);

    expect(doc).toContain('Sales Order');
    expect(doc).toContain('dates from 2025-01-01 to 2025-03-31');
    expect(doc).toContain('Claude');
    expect(doc).toContain('written by an AI model');
    expect(doc).toContain('not recomputed by the application');
  });

  it('says so when nothing was filtered, rather than staying silent', () => {
    const doc = buildArtifactDocument({
      ...ARTIFACT,
      metadata: { ...ARTIFACT.metadata, slice: undefined },
    });

    expect(doc).toContain('Whole module — no filter applied');
  });

  it('escapes the title, which is model output', () => {
    const doc = buildArtifactDocument({ ...ARTIFACT, title: 'A <script>alert(1)</script> title' });

    expect(doc).toContain('&lt;script&gt;');
    expect(doc).not.toContain('<title>A <script>');
  });

  it('carries print rules, so the PDF is the same document laid out for paper', () => {
    const doc = buildArtifactDocument(ARTIFACT);

    expect(doc).toContain('@page');
    expect(doc).toContain('@media print');
  });
});

describe('artifactFilename', () => {
  it('slugs the title and stamps the date', () => {
    expect(artifactFilename(ARTIFACT, 'html')).toBe('where-the-backorder-units-sit-2026-09-06.html');
  });

  it('reduces a hostile title to letters, digits and hyphens', () => {
    const name = artifactFilename({ ...ARTIFACT, title: '../../etc/passwd' }, 'html');

    expect(name).toBe('etc-passwd-2026-09-06.html');
    expect(name).not.toContain('/');
    expect(name).not.toContain('..');
  });

  it('falls back to a usable name when the title slugs to nothing', () => {
    expect(artifactFilename({ ...ARTIFACT, title: '···' }, 'html')).toBe('report-2026-09-06.html');
  });
});
