import { outputOptions } from "./generated/contract.js";
import type { RecipeDetail } from "./generated/types.js";
import { docsUrl } from "./config.js";
import { CliError } from "./errors.js";
import { wrap } from "./help.js";

type Node = {
  type?: string | string[]; enum?: readonly unknown[]; const?: unknown; default?: unknown; description?: string;
  minimum?: number; maximum?: number; exclusiveMinimum?: number; minItems?: number; maxItems?: number;
  items?: Node; properties?: Record<string, Node>; required?: string[]; anyOf?: Node[]; oneOf?: Node[]; $ref?: string;
  $defs?: Record<string, Node>; "x-input-type"?: string; "x-group"?: string; "x-accept"?: string[];
  "x-shown-when"?: { param?: string; in?: readonly unknown[]; any?: string[] };
};
type Row = { name: string; type: string; presence: string; text: string; heading?: boolean };

export type ShowOptions = { json?: boolean; example?: string };

const lineWidth = 140;
const longEnum = 30;
// Deeper fields are named on their parent's line, so a recipe fits one screen; --json has them all.
const maxDepth = 1;

// The first sentence carries the meaning; the rest is in --json.
function firstSentence(text: string, room: number): string {
  const end = text.search(/(?<!\b(?:e\.g|i\.e|etc|vs))[.!?](\s|$)/);
  const sentence = (end === -1 ? text : text.slice(0, end + 1)).replace(/\s+/g, " ").trim();
  if (sentence.length <= room) return sentence;
  return sentence.slice(0, sentence.lastIndexOf(" ", room - 2)) + " …";
}

function compact(value: unknown): string {
  const text = JSON.stringify(value) ?? "";
  return text.length > 24 ? text.slice(0, 22) + "…" : text;
}

function condition(when: Node["x-shown-when"]): string {
  if (when?.any?.length) return `(when ${when.any.join(" or ")} is set) `;
  if (!when?.param) return "";
  return when.in ? `(when ${when.param} is ${when.in.map(String).join(" or ")}) ` : `(when ${when.param} is set) `;
}

function range(node: Node): string {
  const low = node.minimum ?? (node.exclusiveMinimum === undefined ? undefined : `>${node.exclusiveMinimum}`);
  if (low !== undefined && node.maximum !== undefined) return ` ${low}..${node.maximum}`;
  if (low !== undefined) return typeof low === "number" ? ` >=${low}` : ` ${low}`;
  return node.maximum === undefined ? "" : ` <=${node.maximum}`;
}

export function recipeSummary(detail: RecipeDetail): string {
  const root = detail.input_schema as Node;
  const resolve = (node: Node): Node =>
    node.$ref?.startsWith("#/$defs/") ? resolve(root.$defs?.[node.$ref.slice(8)] ?? {}) : node;

  function label(raw: Node): string {
    const node = resolve(raw);
    const union = node.anyOf ?? node.oneOf;
    if (union) return [...new Set(union.map(label))].join(" | ");
    if (node["x-input-type"] === "asset") return "image";
    if (node["x-input-type"] === "color") return "color";
    if (node.const !== undefined) return JSON.stringify(node.const);
    if (node.enum) {
      const values = node.enum.map(String).join("|");
      return values.length <= longEnum ? values : `one of ${node.enum.length}`;
    }
    if (Array.isArray(node.type)) return node.type.join(" | ");
    if (node.type === "array") {
      const count = node.minItems !== undefined && node.minItems === node.maxItems ? node.minItems : "";
      const item = node.items ? resolve(node.items) : {};
      const numeric = item.type === "integer" || item.type === "number";
      return numeric ? `${item.type}[${count}]${range(item)}` : `${node.items ? label(node.items) : "any"}[${count}]`;
    }
    if (node.type === "integer" || node.type === "number") return node.type + range(node);
    return node.type ?? "any";
  }

  // The documented fields of an object, of a list's items or of the object branch of a union.
  function fields(raw: Node): { node: Node; list: boolean } | null {
    const node = resolve(raw);
    if (node.properties) return { node, list: false };
    if (node.type === "array" && node.items && resolve(node.items).properties) return { node: resolve(node.items), list: true };
    const branch = (node.anyOf ?? node.oneOf)?.map(resolve).find((item) => item.properties);
    return branch ? { node: branch, list: false } : null;
  }

  // A shared type as the engine publishes it: a `$ref` param, a list of `$ref` items or a nullable `$ref`.
  // Other references (inside unions, or in older stored schemas) stay anonymous and are shown by shape.
  const refName = (node?: Node) => node?.$ref?.startsWith("#/$defs/") ? node.$ref.slice(8) : undefined;
  function named(raw: Node): { name: string; accept?: string[]; nullable: boolean } | null {
    const items = raw.type === "array" ? raw.items : undefined;
    const branches = raw.anyOf ?? [];
    const branch = branches.length === 2 && branches.some((item) => item.type === "null")
      ? branches.find((item) => item.$ref) : undefined;
    const target = raw.$ref ? raw : items?.$ref ? items : branch;
    const name = refName(target);
    if (!name) return null;
    return { name, accept: target!["x-accept"] ?? raw["x-accept"], nullable: !!branch };
  }
  const accepts = (kinds: string[]) => kinds.length === 1 ? `${kinds[0]} only` : kinds.join("|");

  // Below the top level only documented fields are listed; the rest is in --json.
  const documented = (parent: Node, depth: number) =>
    Object.entries(parent.properties ?? {}).filter(([, raw]) => depth === 0 || raw.description);

  // Ungrouped inputs first, then each group in order of first appearance; headings only when groups exist.
  function grouped(entries: [string, Node][]): ([string, Node] | string)[] {
    const groups = [...new Set(entries.map(([, raw]) => raw["x-group"]))];
    if (groups.every((group) => group === undefined)) return entries;
    return [undefined, ...groups.filter((group) => group !== undefined)].flatMap((group) => {
      const members = entries.filter(([, raw]) => raw["x-group"] === group);
      return group === undefined || !members.length ? members : [group, ...members];
    });
  }

  const rows: (Row & { description: string; suffix: string })[] = [];
  const types = new Map<string, string>();
  function walk(parent: Node, depth: number, prefix: string) {
    const entries = documented(parent, depth);
    for (const entry of depth === 0 ? grouped(entries) : entries) {
      if (typeof entry === "string") {
        rows.push({ name: `[${entry}]`, type: "", presence: "", text: "", description: "", suffix: "", heading: true });
        continue;
      }
      const [name, raw] = entry;
      const node = resolve(raw);
      const nested = fields(raw);
      const type = named(raw);
      const path = prefix + name + (nested?.list ? "[]" : "");
      const children = nested ? documented(nested.node, depth + 1).map(([child]) => child) : [];
      const first = type ? !types.has(type.name) : true;
      const expand = children.length > 0 && depth < maxDepth && first;
      let suffix = "";
      if (type && !first && depth < maxDepth) suffix = ` Fields as under ${types.get(type.name)}.`;
      else if (!type && children.length && !expand) suffix = ` Fields: ${children.join(", ")}.`;
      if (type && first) types.set(type.name, path);
      rows.push({
        name: "  ".repeat(depth) + name + (nested?.list ? "[]" : ""),
        type: type
          ? type.name + (type.nullable ? " | null" : "") + (type.accept ? ` (${accepts(type.accept)})` : "")
          : nested?.list ? "list" : label(raw),
        presence: parent.required?.includes(name) ? "required"
          : raw.default !== undefined ? `default ${compact(raw.default)}` : "optional",
        text: "",
        description: condition(raw["x-shown-when"] ?? node["x-shown-when"]) + (raw.description ?? node.description ?? ""),
        suffix,
      });
      if (expand) walk(nested!.node, depth + 1, path + ".");
    }
  }
  walk(root, 0, "");

  const header: Row = { name: "NAME", type: "TYPE", presence: "DEFAULT", text: "DESCRIPTION" };
  const columns = [header, ...rows.filter((row) => !row.heading)];
  const widths = (["name", "type", "presence"] as const).map((key) => Math.max(...columns.map((row) => row[key].length)));
  const room = Math.max(50, lineWidth - widths.reduce((sum, width) => sum + width + 2, 2));
  for (const row of rows.filter((item) => !item.heading)) row.text = firstSentence(row.description, room - row.suffix.length) + row.suffix;
  const line = (row: Row) => row.heading ? `  ${row.name}` : `  ${row.name.padEnd(widths[0])}  ${row.type.padEnd(widths[1])}  ${row.presence.padEnd(widths[2])}  ${row.text}`.trimEnd();

  const images = detail.asset_paths.map((path) => path.join(".").replace(/\.\*/g, "[]"));
  const defaults = Object.entries(detail.output ?? {}).map(([key, value]) => `${key} ${value}`).join(", ");
  const formats = (outputOptions.format.enum as readonly string[]).join(", ");
  const nameWidth = Math.max(0, ...detail.examples.map((example) => example.name.length));
  const reference = `${detail.id}@${detail.version}`;
  const parts = [
    `${reference}: ${detail.title}`,
    wrap(detail.description, 0),
    `Inputs (${rows.some((row) => row.heading) ? "grouped under [Group] lines, " : ""}`
      + `nested fields are indented, list items are shown as name[]):\n${[header, ...rows].map(line).join("\n")}`,
  ];
  if (types.size) {
    const typeWidth = Math.max(...[...types.keys()].map((name) => name.length));
    parts.push("Types (shared field sets named in TYPE; `tweenframe docs recipes` explains the standard ones):\n"
      + [...types.keys()].map((name) => {
        const def = root.$defs?.[name] ?? {};
        const meaning = def.description ? firstSentence(def.description, lineWidth) + " " : "";
        const names = Object.keys(def.properties ?? {}).join(", ");
        return `  ${name.padEnd(typeWidth)}  ${wrap(`${meaning}Fields: ${names}.`, typeWidth + 4)}`;
      }).join("\n"));
  }
  if (images.length)
    parts.push(wrap(`Images: ${images.join(", ")}. Put a local file in as file:///absolute/path; \`recipes render\` uploads it.`, 0));
  parts.push(wrap(`Output defaults: ${defaults || "none"}. Formats: ${formats}. Change them with the flags of `
    + "`tweenframe recipes render` (--format, --width, --scale, --fps, --quality, --loop).", 0));
  if (detail.examples.length)
    parts.push(`Examples (\`tweenframe recipes show ${detail.id} --example <name>\` prints one as JSON):\n`
      + detail.examples.map((example) => `  ${example.name.padEnd(nameWidth)}  ${wrap(example.description ?? "", nameWidth + 4)}`.trimEnd()).join("\n"));
  const guide = detail.docs?.guide;
  parts.push(`${guide ? `Docs: ${docsUrl(guide)}\n` : ""}Full input schema: tweenframe recipes show ${reference} --json`);
  return parts.join("\n\n") + "\n";
}

export function exampleInputs(detail: RecipeDetail, name: string): Record<string, unknown> {
  const example = detail.examples.find((item) => item.name === name);
  if (!example) {
    const names = detail.examples.map((item) => item.name);
    throw new CliError("invalid_value", `--example must be one of: ${names.join(", ") || "(none)"}; got ${JSON.stringify(name)}.`,
      { option: "--example", value: name, allowed: names },
      `Use an example name listed by \`tweenframe recipes show ${detail.id}\`.`);
  }
  return example.inputs;
}
