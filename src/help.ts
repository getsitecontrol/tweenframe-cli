import { meta, operations, outputOptions, schemas } from "./generated/contract.js";
import { apiUrl, docs, docsUrl, groupDocs } from "./config.js";
import { allowed, placeholder, type Schema } from "./schema.js";
import type { Operation } from "./api.js";

export type ArgumentDoc = { name: string; required: boolean; description: string };
export type OptionDoc = { flags: string; description: string; required?: boolean };
export type CommandDoc = {
  path: string; summary: string; description: string; arguments: ArgumentDoc[]; options: OptionDoc[];
  examples: string[]; docs: string; output?: string;
};
export type GroupDoc = { name: string; description: string; docs: string; commands: CommandDoc[] };

const width = 100;
const sentence = (text: string): string => text ? text[0].toUpperCase() + text.slice(1) + "." : "";

// Runtime behaviour the API description cannot know: local checks, upload dedup, polling cadence.
const modeNotes: Partial<Record<Operation["mode"], string>> = {
  render: "The CLI checks --input, the output options and every file:// path locally before any request, uploads "
    + "each distinct local file once, sends the render, and with --wait or --output polls until it completes or fails.",
  wait: "The CLI polls the render every 1.5 s for up to 6 minutes; with --output it downloads the result.",
};

const showNote = "The CLI prints a readable summary: title and description, one line per input (type, required or "
  + "default, first sentence of its description; nested fields indented, list items as name[], grouped as in the "
  + "web tool), the shared types such as Media, the image paths, the output defaults and the example names. --json prints the full response for programs; --example <name> prints one "
  + "example's inputs.";
const showOutput = "Text on stdout; with --json, {\"data\": ...}; with --example, the example's inputs as JSON "
  + "(plus a one-line note on stderr when it holds catalog images). "
  + "Errors as {\"error\": {code, message, hint, docs}} on stderr, exit code 1.";

function schemaOption(name: string, schema: Schema, defaultText: string): OptionDoc {
  const parts = [schema.description ?? ""];
  if (!schema.enum && schema.type !== "boolean") parts.push(sentence(allowed(schema)));
  if (schema.default !== undefined) parts.push(`Default: ${JSON.stringify(schema.default)}.`);
  else parts.push(defaultText);
  return { flags: `--${name} ${placeholder(schema)}`, description: parts.join(" ") };
}

const inputOption = (text: string): OptionDoc => ({ flags: "--input <json|file|->", description: text, required: true });
const outputFile = (implies: boolean): OptionDoc => ({
  flags: "--output <file>",
  description: `${implies ? "Wait for completion and download" : "Download"} the result to this file; parent `
    + `directories are created.${implies ? " Implies --wait." : ""}`,
});

function operationDoc(op: Operation): CommandDoc {
  const args: ArgumentDoc[] = op.positionals.map((name) => {
    const parameter = op.parameters.find((item) => item.name === name);
    const texts = op.arguments as Record<string, string>;
    return {
      name, required: parameter ? parameter.required : true,
      description: texts[name] || parameter?.description || "",
    };
  });
  const options: OptionDoc[] = [];
  if (op.operationId === "getRecipe") {
    const version = op.parameters.find((item) => item.name === "version");
    const schema = (version?.schema ?? { type: "integer", minimum: 1 }) as Schema;
    args.push({
      name: "version", required: false,
      description: `${version?.description || "Recipe version."} ${sentence(allowed(schema))} Same as <id>@<version>.`,
    });
    options.push({ flags: "--json", description: "Print the full response as {\"data\": ...}: input_schema, asset_paths, output, examples." });
    options.push({
      flags: "--example <name>",
      description: "Print only that example's inputs as JSON, ready to save as the --input file of `recipes render`. "
        + "When the example has images, a line on stderr names their paths: they are catalog photos to replace with "
        + "your own file:///absolute/path.",
    });
  }
  if (op.mode === "analyze") {
    const aspects = schemas.AnalyzeRequest.properties.aspects;
    options.push({
      flags: "--aspect <w:h>",
      description: `${aspects.description} Repeat the flag for each aspect.`,
    });
  }
  if (op.mode === "render") {
    options.push(inputOption("Required. Recipe inputs as a JSON object: inline JSON, a JSON file path, or - for stdin. "
      + "Start from an example: `tweenframe recipes show <id> --example minimal > inputs.json`; local images go in as "
      + "file:// URLs at the recipe's asset_paths."));
    options.push({ flags: "--wait", description: "Poll until the render completes or fails and print the final render." });
    options.push(outputFile(true));
    for (const [name, schema] of Object.entries(outputOptions))
      options.push(schemaOption(name, schema as Schema, `Default: the recipe's output.${name}.`));
  }
  if (op.mode === "wait") {
    options.push(inputOption("Required. A render printed by `tweenframe recipes render`, bare or wrapped in {\"data\": ...}: "
      + "inline JSON, a JSON file path, or - for stdin."));
    options.push(outputFile(false));
  }
  const [group] = op.command.split(" ");
  return {
    path: op.command,
    summary: op.summary,
    description: [op.description, op.operationId === "getRecipe" ? showNote : modeNotes[op.mode]].filter(Boolean).join("\n\n"),
    arguments: args,
    options,
    examples: [...op.examples],
    docs: op.docs ? docsUrl(op.docs) : groupDocs(group),
    ...(op.operationId === "getRecipe" ? { output: showOutput } : {}),
  };
}

// Commands implemented only in the CLI carry their help here.
const localDocs: CommandDoc[] = [
  {
    path: "auth status",
    summary: "Show whether a usable identity is configured",
    description: "Reads the stored identity (or TWEENFRAME_TOKEN) without calling the API and reports whether it can be "
      + "used: authenticated, expired, id, expires_at, source (file or environment) and auth_file. An expired token "
      + "makes every API command fail with auth_required; run `tweenframe auth init` to get a new one.",
    arguments: [],
    options: [],
    examples: ["tweenframe auth status"],
    docs: groupDocs("auth"),
  },
  {
    path: "docs",
    summary: "List the agent guides or print one",
    description: "Without a name, lists the guides served by the TweenFrame site: name, one line, URL. With a name, "
      + "fetches that guide and prints its Markdown verbatim, so it can be read without leaving the terminal. The list "
      + "comes from the site the API runs on (TWEENFRAME_API_URL), not from the CLI.",
    arguments: [{ name: "name", required: false, description: "Guide name from the list, e.g. recipes or errors." }],
    options: [{ flags: "--json", description: "Print the guide list as {\"data\": {\"guides\": [...]}} instead of text." }],
    examples: ["tweenframe docs", "tweenframe docs recipes", "tweenframe docs errors"],
    docs: docs.index,
    output: "Text on stdout: the guide list or the guide's Markdown. Errors as JSON on stderr, exit code 1.",
  },
  {
    path: "help",
    summary: "Show help for the CLI, a group or a command",
    description: "Prints the same text as `--help`. With --json, prints the command metadata generated from the "
      + "OpenAPI contract (operations, parameters, schemas, output options) plus documentation links, for programs.",
    arguments: [{ name: "command...", required: false, description: "Group or command, e.g. recipes or recipes render." }],
    options: [{ flags: "--json", description: "Print {\"data\": {api_url, docs, operations, schemas, output_options}}." }],
    examples: ["tweenframe help recipes render", "tweenframe help --json recipes render"],
    docs: docs.skill,
    output: "Text on stdout; with --json, one JSON line.",
  },
];

export const commandDocs: CommandDoc[] = [...operations.map(operationDoc), ...localDocs];

export function groupDocsList(): GroupDoc[] {
  return meta.groups.map((group) => {
    const commands = commandDocs.filter((doc) => doc.path.startsWith(`${group.name} `));
    return { name: group.name, description: group.description, docs: groupDocs(group.name), commands };
  });
}

export function wrap(text: string, indent: number, first = indent): string {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(" ")) {
      const room = width - (lines.length === 0 && line === "" ? first : indent);
      if (line && line.length + 1 + word.length > room) {
        lines.push(line);
        line = word;
      } else line = line ? `${line} ${word}` : word;
    }
    lines.push(line);
  }
  return lines.map((line, index) => (index === 0 ? "" : " ".repeat(indent)) + line).join("\n").replace(/[ ]+\n/g, "\n");
}

function table(rows: [string, string][], column = 26): string {
  return rows.map(([left, right]) => {
    if (!right) return `  ${left}`;
    if (left.length + 2 > column) return `  ${left}\n${" ".repeat(column + 2)}${wrap(right, column + 2)}`;
    return `  ${left.padEnd(column)}${wrap(right, column + 2)}`;
  }).join("\n");
}

const usageOf = (doc: CommandDoc): string => [
  `tweenframe ${doc.path}`,
  ...doc.arguments.map((arg) => arg.required ? `<${arg.name}>` : `[${arg.name}]`),
  ...doc.options.filter((option) => option.required).map((option) => option.flags),
  ...(doc.options.some((option) => !option.required) ? ["[options]"] : []),
].join(" ");

// Usage without the program name and optional flags, for command lists.
const brief = (doc: CommandDoc): string => usageOf(doc).slice("tweenframe ".length).replace(/ \[options\]$/, "");

const jsonOutput = "JSON on stdout as {\"data\": ...}. Errors as {\"error\": {code, message, hint, docs}} on stderr, exit code 1.";

export function commandHelp(doc: CommandDoc): string {
  const parts = [`Usage: ${usageOf(doc)}`, wrap(doc.description, 0)];
  if (doc.arguments.length)
    parts.push("Arguments:\n" + table(doc.arguments.map((arg) => [arg.name, arg.description])));
  parts.push("Options:\n" + table([
    ...doc.options.map((option): [string, string] => [option.flags, option.description]),
    ["-h, --help", "Show this help."],
  ]));
  parts.push(`Output: ${wrap(doc.output ?? jsonOutput, 8, 8)}`);
  if (doc.examples.length) parts.push("Examples:\n" + doc.examples.map((line) => `  ${line}`).join("\n"));
  parts.push(`Docs: ${doc.docs}`);
  return parts.join("\n\n") + "\n";
}

export function groupHelp(group: GroupDoc): string {
  const rows = group.commands.map((doc): [string, string] => [brief(doc).slice(group.name.length + 1), doc.summary]);
  return [
    `Usage: tweenframe ${group.name} <command> [arguments] [options]`,
    sentence(group.description).replace(/\.\.$/, "."),
    "Commands:\n" + table(rows, 30),
    `Run \`tweenframe ${group.name} <command> --help\` for arguments, options, allowed values and examples.`,
    `Docs: ${group.docs}`,
  ].join("\n\n") + "\n";
}

export function programHelp(version: string): string {
  const rows: [string, string][] = [];
  for (const group of groupDocsList()) {
    rows.push([group.name, sentence(group.description).replace(/\.\.$/, ".")]);
    for (const doc of group.commands) rows.push([`  ${brief(doc)}`, doc.summary]);
  }
  for (const path of ["docs", "help"]) {
    const doc = commandDocs.find((item) => item.path === path)!;
    rows.push([`${brief(doc)} [--json]`, doc.summary]);
  }
  return [
    wrap(`tweenframe ${version}: ${meta.description.split("\n\n")[0]}`, 0),
    "Usage: tweenframe <group> <command> [arguments] [options]\n"
      + "Workflow: auth init, recipes list, recipes show <id>, recipes render <id> --input <json> --output <file>",
    "Commands:\n" + table(rows, 34),
    wrap("Run `tweenframe <group>` for a group and `tweenframe <group> <command> --help` for arguments, options, "
      + "allowed values and examples. `tweenframe docs` lists the guides.", 0),
    "Output:\n" + table([["JSON on stdout", "{\"data\": ...}; `recipes show` prints text unless --json"], ["errors on stderr", "{\"error\": {code, message, hint, docs}}, exit code 1"]]),
    "Environment:\n" + table([
      ["TWEENFRAME_API_URL", `API base URL; now ${apiUrl}`],
      ["TWEENFRAME_TOKEN", "Bearer token; overrides the stored identity"],
      ["TWEENFRAME_AUTH_FILE", "Where `auth init` stores the identity"],
    ]),
    `Docs: ${docs.skill}\nErrors: ${docs.errors}`,
  ].join("\n\n") + "\n";
}
