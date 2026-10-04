import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { schemas } from "./generated/contract.js";
import type { Asset, AssetAnalysis } from "./generated/types.js";
import { localFile, request, token } from "./api.js";
import { CliError } from "./errors.js";

export type AnalyzeOptions = { aspect?: string[] };

const aspectsSchema = schemas.AnalyzeRequest.properties.aspects;
const aspectPattern = new RegExp(aspectsSchema.items.pattern);
// Paths the API resolves itself: managed assets and catalog photos.
const apiPath = /^\/(assets|template-catalog\/assets)\//;

// A source that is not an API URL is a local file, checked before any request.
async function localPath(source: string): Promise<string | null> {
  if (source.startsWith("file://")) {
    try {
      return fileURLToPath(source);
    } catch {
      throw new CliError("invalid_value", `Invalid local file URL: ${source}. Use an absolute file:///path URL.`, { value: source });
    }
  }
  if (/^https?:\/\//.test(source)) return null;
  if (apiPath.test(source) && !(await stat(source).catch(() => null))) return null;
  return source;
}

export async function analyzeSource(
  source: string, options: AnalyzeOptions,
): Promise<{ asset?: Asset; analysis: AssetAnalysis }> {
  const aspects = options.aspect ?? [];
  const bad = aspects.find((aspect) => !aspectPattern.test(aspect));
  if (bad !== undefined)
    throw new CliError("invalid_value",
      `--aspect must be width:height with integers from 1 to 9999 and no leading zeros, e.g. 4:5; got ${JSON.stringify(bad)}.`,
      { option: "--aspect", value: bad });
  if (aspects.length > aspectsSchema.maxItems)
    throw new CliError("invalid_value", `--aspect can be given at most ${aspectsSchema.maxItems} times; got ${aspects.length}.`,
      { option: "--aspect" });
  const path = await localPath(source);
  if (path !== null) await localFile(path);
  await token();
  const asset = path === null ? undefined : await request("uploadAsset", {}, path);
  const url = asset ? asset.url : source;
  if (typeof url !== "string" || !url) throw new CliError("invalid_response", "Upload returned no asset URL.");
  const analysis = await request("analyzeAsset", {}, { url, aspects });
  return asset ? { asset, analysis } : { analysis };
}
