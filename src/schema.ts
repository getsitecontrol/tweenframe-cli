export type Schema = {
  type?: string; enum?: readonly unknown[]; minimum?: number; maximum?: number; exclusiveMinimum?: number;
  default?: unknown; description?: string;
};

const noun = (schema: Schema): string => schema.type === "integer" ? "an integer" : "a number";

// One phrase used both in help lines and in invalid_value messages, so they never disagree.
export function allowed(schema: Schema): string {
  if (schema.enum) return `one of: ${schema.enum.join(", ")}`;
  if (schema.type === "boolean") return "true or false";
  if (schema.type === "integer" || schema.type === "number") {
    const { minimum: min, maximum: max, exclusiveMinimum: above } = schema;
    if (min !== undefined && max !== undefined) return `${noun(schema)} from ${min} to ${max}`;
    if (above !== undefined) return `${noun(schema)} greater than ${above}${max !== undefined ? ` and at most ${max}` : ""}`;
    if (min !== undefined) return `${noun(schema)} of at least ${min}`;
    if (max !== undefined) return `${noun(schema)} of at most ${max}`;
    return noun(schema);
  }
  return "a string";
}

// Placeholder shown after a flag: `<16..3000>`, `<maximum|normal|minimal>`, `<number>`.
export function placeholder(schema: Schema): string {
  if (schema.enum) return `<${schema.enum.join("|")}>`;
  if (schema.type === "boolean") return "<true|false>";
  if (schema.type === "integer" || schema.type === "number") {
    const low = schema.minimum ?? schema.exclusiveMinimum;
    if (low !== undefined && schema.maximum !== undefined) return `<${low}..${schema.maximum}>`;
    return `<${schema.type}>`;
  }
  return "<string>";
}
