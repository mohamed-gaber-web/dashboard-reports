import { describe, expect, it } from 'vitest';
import { escapeHtml, renderMarkdown } from './markdown.util';

/**
 * The renderer's safety rests on one property: input is escaped before any markup
 * exists. These tests pin that property, not the prettiness of the output — if a
 * future rule emits caller text without escaping it first, the injection group
 * below is what catches it.
 */
describe('renderMarkdown', () => {
  describe('cannot inject HTML', () => {
    it('escapes tags in plain prose', () => {
      const out = renderMarkdown('<script>alert(1)</script>');
      expect(out).not.toContain('<script>');
      expect(out).toContain('&lt;script&gt;');
    });

    it('escapes tags inside emphasis', () => {
      expect(renderMarkdown('**<img src=x onerror=alert(1)>**')).not.toContain('<img');
    });

    it('escapes tags inside code spans and fences', () => {
      expect(renderMarkdown('`<b>x</b>`')).not.toContain('<b>');
      expect(renderMarkdown('```\n<b>x</b>\n```')).not.toContain('<b>');
    });

    it('escapes tags inside table cells', () => {
      const out = renderMarkdown('| a |\n| --- |\n| <b>x</b> |');
      expect(out).not.toContain('<b>');
      expect(out).toContain('&lt;b&gt;');
    });

    it('refuses a javascript: link, leaving it as text', () => {
      const out = renderMarkdown('[click](javascript:alert(1))');
      expect(out).not.toContain('href="javascript');
      expect(out).toContain('[click]');
    });

    it('allows http, https and mailto links', () => {
      expect(renderMarkdown('[a](https://x.test)')).toContain('href="https://x.test"');
      expect(renderMarkdown('[a](http://x.test)')).toContain('href="http://x.test"');
      expect(renderMarkdown('[a](mailto:a@b.test)')).toContain('href="mailto:a@b.test"');
    });

    it('escapes quotes so an attribute cannot be broken out of', () => {
      expect(escapeHtml('" onmouseover="x')).not.toContain('"');
    });
  });

  describe('block constructs', () => {
    it('renders headings below h1 — h1 belongs to the page', () => {
      expect(renderMarkdown('# Title')).toBe('<h2>Title</h2>');
    });

    it('renders unordered and ordered lists', () => {
      expect(renderMarkdown('- a\n- b')).toBe('<ul><li>a</li><li>b</li></ul>');
      expect(renderMarkdown('1. a\n2. b')).toBe('<ol><li>a</li><li>b</li></ol>');
    });

    it('closes a list when prose follows', () => {
      const out = renderMarkdown('- a\n\ntext');
      expect(out).toBe('<ul><li>a</li></ul><p>text</p>');
    });

    it('renders a table with a header row', () => {
      const out = renderMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |');
      expect(out).toContain('<th>a</th>');
      expect(out).toContain('<td>1</td>');
    });

    it('joins wrapped lines into one paragraph', () => {
      expect(renderMarkdown('one\ntwo')).toBe('<p>one two</p>');
    });

    it('renders blockquotes and rules', () => {
      expect(renderMarkdown('> quoted')).toBe('<blockquote>quoted</blockquote>');
      expect(renderMarkdown('---')).toBe('<hr />');
    });
  });

  describe('inline constructs', () => {
    it('renders bold, italic and strikethrough', () => {
      expect(renderMarkdown('**b**')).toContain('<strong>b</strong>');
      expect(renderMarkdown('*i*')).toContain('<em>i</em>');
      expect(renderMarkdown('~~s~~')).toContain('<del>s</del>');
    });

    it('leaves markdown inside a code span literal', () => {
      const out = renderMarkdown('`**not bold**`');
      expect(out).toContain('<code>**not bold**</code>');
      expect(out).not.toContain('<strong>');
    });

    /**
     * Regression: the code-span placeholder was once a bare ` N `, so ordinary
     * prose containing a spaced number was rewritten into an out-of-range code
     * span ("in 3 minutes" → "in <code>undefined</code>inutes").
     */
    it('leaves spaced numbers in prose alone', () => {
      const out = renderMarkdown('ready in 3 minutes');
      expect(out).toBe('<p>ready in 3 minutes</p>');
      expect(out).not.toContain('<code>');
    });

    it('does not corrupt prose when a code span is also present', () => {
      const out = renderMarkdown('wait 5 then run `npm test` for 2 minutes');
      expect(out).toContain('wait 5 then run');
      expect(out).toContain('<code>npm test</code>');
      expect(out).toContain('for 2 minutes');
    });
  });

  it('handles empty and nullish input', () => {
    expect(renderMarkdown('')).toBe('');
    expect(renderMarkdown(undefined as unknown as string)).toBe('');
  });
});
