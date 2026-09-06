import { ArtifactValidation, GeneratedReportArtifact } from '../models/report-artifact.model';

/**
 * The trust boundary between model output and the app — the seam
 * `report-plan.ts` is for the AI Analyst and `report-payload.parser.ts` is for
 * Chat Reports.
 *
 * ## This is defence in DEPTH, not the defence
 *
 * The isolation that actually protects the application is the sandboxed iframe in
 * `components/artifact-frame`: no `allow-scripts`, no `allow-same-origin`, plus a
 * `default-src 'none'` content-security policy inside the document itself. Script
 * is inert, the origin is opaque, and the document cannot reach the parent, its
 * storage, the D365 bearer token, or the network. That is a capability boundary —
 * a property of the browser, not a list of things someone remembered to block.
 *
 * What this file does is different and worth doing anyway:
 *
 * 1. **The exported file leaves the sandbox.** `Export HTML` hands the user a
 *    document they will open directly, where the iframe's restrictions do not
 *    apply. Anything stripped here is stripped from the file they keep.
 * 2. **A violated contract should be visible, not silent.** The system prompt
 *    forbids `<script>`, external requests and `<form>`. If one appears, the user
 *    should be told the model broke the contract rather than have it quietly
 *    fail. Every repair lands in `issues` and is shown on screen.
 *
 * It is NOT relied on to make unsafe markup safe. A regex-based HTML filter is a
 * blocklist, and blocklists lose; if this file were the only thing between the
 * model and the DOM, the design would be wrong.
 *
 * ## The house rule: repair and report, never silently reject
 *
 * A document with one stripped tag still renders and the user is told what was
 * removed. Only two things are fatal — no `html` at all, and a document past the
 * size guard — because neither leaves anything to show.
 *
 * Pure functions, no Angular: this is a boundary, and a boundary is worth testing
 * without a TestBed.
 */

/**
 * Size guard on the rendered document. Matches `LIMITS.html` in
 * `api/_lib/report-lab-contract.js`.
 *
 * Far above anything the model's token limit can actually produce, which is the
 * point: it is a runaway guard on something that becomes an iframe `srcdoc`, a
 * download and a print job, not a style rule.
 */
export const MAX_HTML_LENGTH = 400_000;
const MAX_TITLE_LENGTH = 200;
const MAX_SUMMARY_LENGTH = 2_000;

/**
 * Elements removed WITH their content: there is nothing inside any of them worth
 * keeping, and leaving the children behind would leak a `<noscript>`-style
 * fallback into the middle of the report.
 */
const VOID_ELEMENTS_WITH_CONTENT = ['script', 'iframe', 'object', 'embed', 'applet', 'frameset', 'noscript'];

/**
 * Elements whose TAG is removed but whose content stays. A `<form>` around three
 * paragraphs should lose the form, not the paragraphs.
 */
const TAGS_ONLY = ['link', 'base', 'meta', 'form', 'input', 'textarea', 'select', 'frame'];

interface Repair {
  pattern: RegExp;
  replacement: string;
  /** What to tell the user, if it fired. */
  issue: string;
}

/**
 * The repairs, in the order they are applied.
 *
 * Order matters in one place: `<script>` blocks go before attribute scrubbing, so
 * an `onclick=` inside a script body is not counted as a second, separate
 * violation of a contract that was already broken once.
 */
function repairs(): Repair[] {
  return [
    ...VOID_ELEMENTS_WITH_CONTENT.map((tag) => ({
      pattern: new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}\\s*>|<${tag}\\b[^>]*\\/?>`, 'gi'),
      replacement: '',
      issue: `Removed a <${tag}> element — the report contract forbids it and the sandbox would not run it.`,
    })),
    ...TAGS_ONLY.map((tag) => ({
      pattern: new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi'),
      replacement: '',
      issue: `Removed a <${tag}> tag — the report is a static document, not a page.`,
    })),
    {
      // Requires leading whitespace so it cannot match inside a word (a CSS
      // property such as `transition-...` never follows a space-then-"on").
      pattern: /\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi,
      replacement: '',
      issue: 'Removed inline event-handler attributes (onclick and similar). Scripting is disabled in the report.',
    },
    {
      pattern: /(\s(?:href|src|xlink:href|action|formaction)\s*=\s*)(["'])\s*javascript:[^"']*\2/gi,
      replacement: '$1$2#$2',
      issue: 'Neutralised a javascript: URL.',
    },
    {
      pattern: /(\s(?:src|href|poster|data|xlink:href)\s*=\s*)(["'])\s*(?:https?:)?\/\/[^"']*\2/gi,
      replacement: '$1$2#$2',
      issue:
        'Removed a link to an external resource. The report must be self-contained — external ' +
        'images, fonts and stylesheets are blocked and would render as broken.',
    },
    {
      pattern: /@import\s+[^;]+;?/gi,
      replacement: '',
      issue: 'Removed an @import of an external stylesheet.',
    },
    {
      pattern: /url\(\s*(['"]?)(?:https?:)?\/\/[^)]*\1\s*\)/gi,
      replacement: 'none',
      issue: 'Removed a CSS url() pointing at an external resource.',
    },
    {
      // Observed live: a model laid out an SVG chart by writing its arithmetic
      // into comments beside the coordinates — "107.5 * 1.2 = 129px from the 240px
      // baseline". Invisible on screen, and therefore invisible when someone
      // decides the document is fit to forward; but it travels in every exported
      // copy, and it is the model's working notes rather than the report.
      pattern: /<!--[\s\S]*?-->/g,
      replacement: '',
      issue: 'Removed HTML comments from the document — they carried the model’s working notes.',
    },
  ];
}

/** Strip a markdown fence the model wrapped the document in despite being told not to. */
function stripFences(html: string): string {
  const fenced = html.match(/^\s*```(?:html)?\s*\n([\s\S]*?)\n?```\s*$/i);
  return fenced ? fenced[1] : html;
}

/**
 * Reduce a whole document to its body content.
 *
 * The contract asks for a fragment because the wrapper — charset, viewport, CSP,
 * provenance footer — is added in exactly one place. A model that sends a full
 * document is not wrong about the report, only about the envelope, so the
 * envelope is discarded rather than the report.
 */
function unwrapDocument(html: string): { html: string; unwrapped: boolean } {
  const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body\s*>/i);
  if (body) return { html: body[1], unwrapped: true };

  const stripped = html
    .replace(/<!doctype[^>]*>/gi, '')
    .replace(/<\/?html\b[^>]*>/gi, '')
    .replace(/<head\b[\s\S]*?<\/head\s*>/gi, '')
    .replace(/<\/?body\b[^>]*>/gi, '');

  return { html: stripped, unwrapped: stripped !== html };
}

/** Plain text for a field the app renders with interpolation. */
function plainText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export interface ParseOptions {
  /** The module the report was built from — recorded on the artifact, never guessed. */
  module: string;
  moduleLabel: string;
  /** Which model answered. A NAME from the closed provider list, never a key. */
  provider?: string;
  /** How the data was narrowed, as a sentence. Reproduced in the document footer. */
  slice?: string;
}

/**
 * Validate and repair one raw artifact from the model.
 *
 * @param raw The `tool_use.input` as it came off the stream. Untrusted.
 */
export function parseArtifact(raw: unknown, options: ParseOptions): ArtifactValidation {
  const issues: string[] = [];

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { artifact: null, issues: ['The AI returned something that is not a report.'] };
  }

  const input = raw as Record<string, unknown>;

  if (typeof input['html'] !== 'string' || !input['html'].trim()) {
    return {
      artifact: null,
      issues: ['The AI’s reply contained no report document. Ask again, or rephrase the request.'],
    };
  }

  let html = stripFences(input['html'].trim());

  const unwrap = unwrapDocument(html);
  if (unwrap.unwrapped) {
    html = unwrap.html;
    issues.push(
      'The AI returned a whole HTML page; the app supplies the document wrapper, so the outer ' +
        '<html>/<head>/<body> was removed.',
    );
  }

  for (const repair of repairs()) {
    // `test` on a /g regex is stateful, so build a fresh one for the check.
    if (!new RegExp(repair.pattern.source, repair.pattern.flags.replace('g', '')).test(html)) continue;
    html = html.replace(repair.pattern, repair.replacement);
    issues.push(repair.issue);
  }

  // Reported, never "repaired". Observed live: a model wrote Jinja-style
  // expressions — `{{ '{:,.0f}'.format(1261) }}` — into the html field, which
  // render on screen as that literal text where the figure should be.
  //
  // There is no honest fix available here. Evaluating them would mean building a
  // template engine for one model's habit, and silently deleting them would leave
  // a report with holes where its numbers were. So the failure is named instead:
  // a report full of braces looks like an app bug, and the user should know it is
  // the model breaking a stated contract.
  if (/\{\{[\s\S]{0,200}?\}\}/.test(html)) {
    issues.push(
      'The report contains unevaluated template placeholders ({{ … }}) where figures should be — ' +
        'they will show on screen as written. Regenerate the report.',
    );
  }

  html = html.trim();

  if (!html) {
    return {
      artifact: null,
      issues: [...issues, 'Nothing was left of the report after removing content it may not contain.'],
    };
  }

  // Truncating markup mid-tag produces a document that renders half a chart and
  // looks like a bug in the app, so an oversized document is refused outright and
  // said so. The limit is far above anything the reply-token budget can reach.
  if (html.length > MAX_HTML_LENGTH) {
    return {
      artifact: null,
      issues: [
        ...issues,
        `The report document is ${html.length.toLocaleString()} characters, over the ` +
          `${MAX_HTML_LENGTH.toLocaleString()} limit. Ask for a shorter report.`,
      ],
    };
  }

  const title = plainText(input['title'], MAX_TITLE_LENGTH) || 'Untitled report';
  if (!plainText(input['title'], MAX_TITLE_LENGTH)) {
    issues.push('The report had no title, so it is filed as “Untitled report”.');
  }

  const summary = plainText(input['summary'], MAX_SUMMARY_LENGTH);

  return {
    artifact: {
      title,
      html,
      ...(summary ? { summary } : {}),
      metadata: {
        module: options.module,
        moduleLabel: options.moduleLabel,
        // Set by the app. A timestamp from the model would be a figure the model
        // made up, and this one appears in the exported document's footer.
        generatedAt: new Date().toISOString(),
        ...(options.provider ? { provider: options.provider } : {}),
        ...(options.slice ? { slice: options.slice } : {}),
      },
    },
    issues,
  };
}
