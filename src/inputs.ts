import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { localFile } from "./api.js";
import { CliError, type Json } from "./errors.js";

type FileRef = { at: (string | number)[]; url: string; path: string };

export async function readInput(arg: string): Promise<Json> {
  let raw: string;
  try {
    if (arg === "-") {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
      raw = Buffer.concat(chunks).toString("utf8");
    } else if (/^\s*[[{]/.test(arg)) raw = arg;
    else raw = await readFile(arg, "utf8");
  } catch (error) {
    throw new CliError("input_read_failed", error instanceof Error ? error.message : String(error), { input: arg });
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new CliError("invalid_json", `Input is not valid JSON: ${error instanceof Error ? error.message : String(error)}.`, { input: arg });
  }
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Json;
  throw new CliError("invalid_json", `Input must be a JSON object; got ${Array.isArray(value) ? "an array" : JSON.stringify(value)}.`, { input: arg });
}

export function selector(value: string): { id: string; version?: number } {
  const at = value.lastIndexOf("@");
  if (at < 0) {
    if (!value) throw new CliError("usage", "Recipe id is required, e.g. real-estate/banner-7.", undefined,
      "Run `tweenframe recipes list` to see the recipe ids.");
    return { id: value };
  }
  const version = Number(value.slice(at + 1));
  if (at < 1 || !Number.isInteger(version) || version < 1)
    throw new CliError("usage", `Recipe must be <id> or <id>@<version> with an integer version of at least 1; got ${JSON.stringify(value)}.`,
      undefined, "Run `tweenframe recipes list` to see ids and current versions.");
  return { id: value.slice(0, at), version };
}

function walk(value: unknown, at: (string | number)[], found: { at: (string | number)[]; url: string }[]): void {
  if (typeof value === "string" && value.startsWith("file://")) found.push({ at, url: value });
  else if (Array.isArray(value)) value.forEach((item, index) => walk(item, [...at, index], found));
  else if (value && typeof value === "object")
    for (const [name, item] of Object.entries(value)) walk(item, [...at, name], found);
}

// Checked before any network call: bad URLs and missing files fail fast.
export async function localFiles(inputs: Json): Promise<FileRef[]> {
  const found: { at: (string | number)[]; url: string }[] = [];
  walk(inputs, [], found);
  return Promise.all(found.map(async ({ at, url }) => {
    let path: string;
    try {
      path = fileURLToPath(url);
    } catch {
      throw new CliError("invalid_input", `Invalid local file URL at inputs.${at.join(".")}: ${url}. Use an absolute file:///path URL.`,
        { path: at }, "Write local files as absolute file:// URLs, e.g. file:///home/me/photo.jpg.");
    }
    await localFile(path);
    return { at, url, path };
  }));
}

export function checkAssetPaths(files: FileRef[], assetPaths: readonly (readonly string[])[]): void {
  for (const file of files) {
    const matches = assetPaths.some((parts) => parts.length === file.at.length &&
      parts.every((part, index) => part === "*" ? typeof file.at[index] === "number" : part === file.at[index]));
    if (!matches)
      throw new CliError("invalid_input",
        `file:// at inputs.${file.at.join(".")} is not an asset field; asset fields are ${
          assetPaths.map((parts) => parts.join(".")).join(", ") || "none for this recipe"}.`,
        { path: file.at, asset_paths: assetPaths },
        "Put file:// URLs only at the recipe's asset_paths (`*` is a list index); other fields take plain values.");
  }
}

export function replaceFiles(value: unknown, urls: ReadonlyMap<string, string>): unknown {
  if (typeof value === "string") return urls.get(value) ?? value;
  if (Array.isArray(value)) return value.map((item) => replaceFiles(item, urls));
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, replaceFiles(item, urls)]));
  return value;
}
