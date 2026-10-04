import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const specText = await readFile(resolve("openapi/tweenframe.json"), "utf8");
const spec = JSON.parse(specText);
if (spec.openapi !== "3.1.0") throw new Error("Expected OpenAPI 3.1.0.");
const schemas = spec.components?.schemas;
if (!schemas || typeof schemas !== "object") throw new Error("Missing component schemas.");
// Modes the runtime in src/cli.ts implements; anything else would silently do nothing.
const modes = new Set(["store-identity", "request", "upload", "analyze", "render", "wait"]);
const hash = createHash("sha256").update(specText).digest("hex").slice(0, 12);
const banner = `// Generated from openapi/tweenframe.json (sha256 ${hash}). Do not edit.\n`;

function refName(ref) {
  const prefix = "#/components/schemas/";
  if (!ref?.startsWith(prefix)) throw new Error(`Unsupported schema reference: ${ref}`);
  const name = ref.slice(prefix.length);
  if (!(name in schemas)) throw new Error(`Unknown schema: ${name}`);
  return name;
}

function tsType(schema) {
  if (!schema || schema === true) return "unknown";
  if (schema.$ref) return refName(schema.$ref);
  if (schema.oneOf) return schema.oneOf.map(tsType).join(" | ");
  if (Array.isArray(schema.type))
    return schema.type.map((type) => (type === "null" ? "null" : tsType({ ...schema, type }))).join(" | ");
  if (schema.enum) return schema.enum.map((item) => JSON.stringify(item)).join(" | ");
  if (schema.type === "array") return `Array<${tsType(schema.items)}>`;
  if (schema.type === "object" || schema.properties) {
    const fields = Object.entries(schema.properties ?? {}).map(([key, value]) => {
      const optional = schema.required?.includes(key) ? "" : "?";
      return `${JSON.stringify(key)}${optional}: ${tsType(value)};`;
    });
    if (schema.additionalProperties) {
      const extra = schema.additionalProperties === true ? "unknown" : tsType(schema.additionalProperties);
      if (fields.length === 0) return `Record<string, ${extra}>`;
    }
    return `{ ${fields.join(" ")} }`;
  }
  if (schema.type === "integer" || schema.type === "number") return "number";
  if (schema.type === "boolean") return "boolean";
  if (schema.type === "string") return "string";
  throw new Error(`Unsupported schema: ${JSON.stringify(schema)}`);
}

const operations = [];
for (const [path, pathItem] of Object.entries(spec.paths ?? {})) {
  for (const [method, operation] of Object.entries(pathItem)) {
    if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
    if (operation["x-cli"]?.hidden) continue;
    if (!operation.operationId || !operation["x-cli"]?.command || !operation["x-cli"]?.mode) {
      throw new Error(`Missing operationId or x-cli on ${method.toUpperCase()} ${path}`);
    }
    const cli = operation["x-cli"];
    if (!modes.has(cli.mode)) throw new Error(`Unknown x-cli.mode ${cli.mode} on ${operation.operationId}`);
    // A group and an action of one or more words; extra words become nested subcommands.
    const names = cli.command.split(" ");
    if (names.length < 2 || names.some((name) => !/^[a-z][a-z-]*$/.test(name)))
      throw new Error(`CLI commands must be a group and an action: ${cli.command}`);
    const responses = Object.entries(operation.responses ?? {}).filter(([status]) => /^2\d\d$/.test(status));
    if (responses.length !== 1) throw new Error(`Expected one success response for ${operation.operationId}`);
    const responseSchema = responses[0][1].content?.["application/json"]?.schema;
    if (!responseSchema) throw new Error(`Missing JSON response for ${operation.operationId}`);
    const body = operation.requestBody?.content ?? {};
    const contentType = Object.keys(body)[0];
    const bodySchema = contentType ? body[contentType].schema : undefined;
    const positionals = cli.positionals ?? [];
    // Help is rendered from these fields, so an operation without them would ship an incomplete help page.
    const description = cli.description ?? operation.description;
    if (!description) throw new Error(`Missing description on ${operation.operationId}`);
    const examples = cli.examples ?? [];
    if (!Array.isArray(examples) || examples.length === 0 || examples.some((line) => typeof line !== "string" || !line.startsWith("tweenframe ")))
      throw new Error(`x-cli.examples on ${operation.operationId} must be a non-empty list of command lines starting with "tweenframe "`);
    const argumentTexts = cli.arguments ?? {};
    for (const name of Object.keys(argumentTexts)) {
      if (!positionals.includes(name)) throw new Error(`x-cli.arguments names unknown positional ${name} on ${operation.operationId}`);
    }
    if (cli.docs !== undefined && typeof cli.docs !== "string") throw new Error(`x-cli.docs must be a URL on ${operation.operationId}`);
    const parameters = operation.parameters ?? [];
    for (const name of positionals) {
      const parameter = parameters.find((item) => item.name === name);
      if (cli.mode === "request" && !parameter) throw new Error(`Unknown positional ${name} on ${operation.operationId}`);
      if (!argumentTexts[name] && !parameter?.description)
        throw new Error(`Positional ${name} on ${operation.operationId} needs x-cli.arguments or a parameter description`);
    }
    // x-cli.options maps a flag to a JSON body field; its type, text and required-ness come from the body schema.
    const optionMap = cli.options ?? {};
    const resolvedBody = bodySchema?.$ref ? schemas[refName(bodySchema.$ref)] : bodySchema;
    const options = Object.entries(optionMap).map(([flag, field]) => {
      const schema = resolvedBody?.properties?.[field];
      if (contentType !== "application/json" || !schema)
        throw new Error(`x-cli.options --${flag} names unknown JSON body field ${field} on ${operation.operationId}`);
      if (!schema.description) throw new Error(`Body field ${field} on ${operation.operationId} needs a description; it becomes --${flag} help.`);
      if (!/^[a-z][a-z-]*$/.test(flag) || positionals.includes(flag))
        throw new Error(`x-cli.options has an invalid or clashing flag ${flag} on ${operation.operationId}`);
      return { flag, field, required: Boolean(resolvedBody.required?.includes(field)), schema };
    });
    if (options.length) {
      const mapped = new Set(Object.values(optionMap));
      for (const field of resolvedBody.required ?? [])
        if (!mapped.has(field)) throw new Error(`Required body field ${field} on ${operation.operationId} has no x-cli.options flag`);
    }
    operations.push({
      operationId: operation.operationId,
      command: cli.command,
      mode: cli.mode,
      summary: operation.summary ?? "",
      description,
      examples,
      docs: cli.docs ?? null,
      arguments: argumentTexts,
      method: method.toUpperCase(),
      path,
      authenticated: Boolean(operation.security?.length),
      positionals,
      options,
      parameters: parameters.map(({ name, in: location, required, schema, description }) => ({
        name, in: location, required: Boolean(required), schema, description: description ?? "",
      })),
      contentType: contentType ?? null,
      bodySchema: bodySchema ?? null,
      responseSchema,
    });
  }
}
const ids = new Set(operations.map((operation) => operation.operationId));
if (ids.size !== operations.length || operations.length === 0) throw new Error("Duplicate or empty operation catalog.");
const outputSchema = schemas.OutputOptions;
if (!outputSchema?.properties) throw new Error("Missing OutputOptions schema.");
for (const [name, property] of Object.entries(outputSchema.properties)) {
  if (!property.description) throw new Error(`OutputOptions.${name} needs a description; it becomes --${name} help.`);
}
// Groups are OpenAPI tags named after the first word of x-cli.command.
const usedGroups = [...new Set(operations.map((operation) => operation.command.split(" ")[0]))];
const tags = new Map((spec.tags ?? []).map((tag) => [tag.name, tag]));
const meta = {
  title: spec.info?.title ?? "",
  description: spec.info?.["x-cli"]?.description ?? spec.info?.description ?? "",
  docs: {
    skill: spec.info?.["x-cli"]?.docs ?? null,
    index: spec.info?.["x-docs-index"] ?? spec.info?.["x-cli"]?.index ?? null,
  },
  groups: usedGroups.map((name) => ({
    name,
    description: tags.get(name)?.description ?? "",
    docs: tags.get(name)?.externalDocs?.url ?? null,
  })),
};
const contract = banner + `export const meta = ${JSON.stringify(meta, null, 2)} as const;\n\n`
  + `export const operations = ${JSON.stringify(operations, null, 2)} as const;\n\n`
  + `export const outputOptions = ${JSON.stringify(outputSchema.properties, null, 2)} as const;\n\n`
  + `export const schemas = ${JSON.stringify(schemas, null, 2)} as const;\n\n`
  + `export type OperationId = typeof operations[number]["operationId"];\n`;
const types = banner
  + Object.entries(schemas).map(([name, schema]) => `export type ${name} = ${tsType(schema)};`).join("\n")
  + "\n\nexport type OperationResponses = {\n"
  + operations.map(({ operationId, responseSchema }) => `  ${JSON.stringify(operationId)}: ${tsType(responseSchema)};`).join("\n")
  + "\n};\n";

for (const [name, contents] of [["src/generated/contract.ts", contract], ["src/generated/types.ts", types]]) {
  const target = resolve(name);
  if (process.argv.includes("--check")) {
    if (await readFile(target, "utf8") !== contents) throw new Error(`${name} is stale. Run npm run generate.`);
  } else {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
    process.stdout.write(`Generated ${name}\n`);
  }
}
