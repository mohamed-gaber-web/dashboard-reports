/**
 * Translate the JSON Schema this repo already writes into the `Schema` dialect
 * Gemini accepts. Pure — no I/O, no SDK import (BE-ARCH-03).
 *
 * ## Why translate instead of writing two schemas
 *
 * The tool schemas in `api/chat.js` and `api/_lib/report-contract.js` are the
 * contract the Angular app compiles against — `ReportSpec` and `ReportPayload`
 * are their mirror images, and CLAUDE.md already carries a standing obligation
 * to keep each pair in sync. A hand-written Gemini copy would be a THIRD place
 * to keep in sync, and the one nobody remembers. So there is exactly one schema
 * per contract and this file adapts it.
 *
 * ## What actually differs
 *
 * - Types are UPPERCASE (`STRING`, not `string`).
 * - A union is spelled `anyOf`, not `type: ['string', 'number']`.
 * - An enum must sit on a `STRING` with `format: 'enum'`.
 * - Unknown keywords are rejected rather than ignored, so anything not on
 *   Gemini's list is dropped here instead of becoming an opaque 400.
 *
 * A node that cannot be represented returns `undefined` and its parent drops it.
 * That is deliberate: a schema Gemini refuses fails the WHOLE request, while a
 * missing optional property costs one field. Every schema in this repo converts
 * whole today — the fallback exists so a future edit degrades instead of
 * breaking the endpoint.
 */

/** JSON Schema type → Gemini `Type`. Anything absent is unrepresentable. */
const TYPE = {
  string: 'STRING',
  number: 'NUMBER',
  integer: 'INTEGER',
  boolean: 'BOOLEAN',
  array: 'ARRAY',
  object: 'OBJECT',
};

/**
 * @param {unknown} node A JSON Schema node.
 * @returns {object|undefined} A Gemini `Schema`, or undefined if it cannot be
 *   expressed as one.
 */
function toGeminiSchema(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return undefined;

  // A union of scalar types. JSON Schema writes `type: ['string', 'number']`;
  // Gemini has no such form and wants branches. Branches carry the type only —
  // the description belongs to the union, not repeated inside each arm.
  if (Array.isArray(node.type)) {
    const branches = node.type.map((t) => TYPE[t]).filter(Boolean).map((type) => ({ type }));
    if (!branches.length) return undefined;
    const union = branches.length === 1 ? branches[0] : { anyOf: branches };
    if (node.description) union.description = String(node.description);
    return union;
  }

  const type = TYPE[node.type];
  if (!type) return undefined;

  const out = { type };
  if (node.description) out.description = String(node.description);

  // An enum is a STRING with `format: 'enum'` whatever the source type said.
  // Values are stringified because that is the only thing Gemini will emit for
  // one, and every enum in this repo is already a set of strings.
  if (Array.isArray(node.enum) && node.enum.length) {
    out.type = 'STRING';
    out.format = 'enum';
    out.enum = node.enum.map(String);
    return out;
  }

  if (type === 'ARRAY') {
    const items = toGeminiSchema(node.items);
    // An array whose element type is unknown is not usable: Gemini requires
    // `items`, and guessing STRING would silently change the contract.
    if (!items) return undefined;
    out.items = items;
    return out;
  }

  if (type === 'OBJECT') {
    const properties = {};
    for (const [key, value] of Object.entries(node.properties || {})) {
      const converted = toGeminiSchema(value);
      if (converted) properties[key] = converted;
    }
    // Gemini rejects an OBJECT with no properties, and a free-form object is not
    // something any contract here asks for.
    if (!Object.keys(properties).length) return undefined;

    out.properties = properties;

    // Only require what survived conversion — requiring a property that was
    // dropped would make the schema unsatisfiable.
    const required = (Array.isArray(node.required) ? node.required : []).filter((key) =>
      Object.hasOwn(properties, key),
    );
    if (required.length) out.required = required;

    // Generation order. Without it the model emits keys in an arbitrary order,
    // which for a report contract is also the order a reader would read the
    // fields in — and it measurably steadies structured output.
    out.propertyOrdering = Object.keys(properties);
    return out;
  }

  return out;
}

/**
 * Convert this repo's Anthropic-style tool definitions into Gemini function
 * declarations. Same names and descriptions, so the prompt — which refers to
 * tools by name — needs no provider-specific variant.
 */
function toFunctionDeclarations(tools) {
  return tools
    .map((tool) => {
      const parameters = toGeminiSchema(tool.input_schema);
      if (!parameters) return null;
      return { name: tool.name, description: tool.description, parameters };
    })
    .filter(Boolean);
}

module.exports = { toGeminiSchema, toFunctionDeclarations };
