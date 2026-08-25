/**
 * How the model is asked to shape a reply.
 *
 * This is a REQUEST-side concept, not part of the payload: it selects which
 * system prompt `/api/chat-report` uses, and the reply that comes back is a
 * normal {@link ReportPayload} either way. Keeping it out of the payload is what
 * lets a transcript hold both styles at once — switching mid-conversation
 * changes the next answer, not the ones already on screen.
 *
 * A closed union, validated server-side against the same list. The value rides
 * on the wire from the browser, so an unrecognised one falls back to `standard`
 * rather than erroring — the same rule the provider name follows, and for the
 * same reason: a stale tab should keep working.
 */
export type ReportStyle = 'standard' | 'executive';

/** What the picker shows. One entry per member of the union above. */
export interface ReportStyleOption {
  id: ReportStyle;
  label: string;
  /** One line on what changes — the difference is not obvious from the name. */
  description: string;
}

export const REPORT_STYLES: readonly ReportStyleOption[] = [
  {
    id: 'standard',
    label: 'Standard',
    description: 'Tiles, charts and tables rendered by the app, in your theme',
  },
  {
    id: 'executive',
    label: 'Executive',
    description: 'A designed financial brief in Arabic — KPIs, ratios, red flags, actions',
  },
];

/** Storage key for the sticky selection. `rd.` prefix per the app-wide convention. */
export const REPORT_STYLE_KEY = 'rd.chat.style';

export function isReportStyle(value: unknown): value is ReportStyle {
  return value === 'standard' || value === 'executive';
}
