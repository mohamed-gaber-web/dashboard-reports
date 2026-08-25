/**
 * One option in a {@link SourcePickerComponent}.
 *
 * Deliberately three plain fields and nothing else. The picker is shared UI and
 * must not know what a source IS — the AI Analyst's `AnalystSource` carries an
 * OData entity, an auth config and a field schema, none of which a dropdown has
 * any business seeing. Each feature maps its own sources down to this.
 */
export interface SourceOption {
  id: string;
  label: string;
  /** One line under the label. A bare "Transaction" says nothing on its own. */
  description?: string;
}
