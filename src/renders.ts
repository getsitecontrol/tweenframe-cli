import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { outputOptions } from "./generated/contract.js";
import type { OutputOptions, Render, RenderPending, RenderRequest } from "./generated/types.js";
import { apiUrl, fetchOrFail, request, token, typed, type Schema } from "./api.js";
import { CliError, type Json } from "./errors.js";
import { checkAssetPaths, localFiles, readInput, replaceFiles, selector } from "./inputs.js";

const pollIntervalMs = 1500;
const pollDeadlineMs = 6 * 60_000;

export type RenderOptions = { input: string; output?: string; wait?: boolean } & Json;

// Everything that can be checked locally is checked before the first request.
async function localChecks(options: RenderOptions) {
  const inputs = await readInput(options.input);
  const files = await localFiles(inputs);
  const overrides: Json = {};
  for (const [name, schema] of Object.entries(outputOptions))
    if (options[name] !== undefined) overrides[name] = typed(String(options[name]), schema as Schema, `--${name}`);
  if (options.output !== undefined && (await stat(options.output).catch(() => null))?.isDirectory())
    throw new CliError("invalid_value", `--output must be a file path, not a directory; got ${options.output}.`,
      { option: "--output", value: options.output }, "Name the file to write, e.g. --output out/result.gif.");
  await token();
  return { inputs, files, overrides };
}

export async function startRender(recipe: string, options: RenderOptions): Promise<unknown> {
  const reference = selector(recipe);
  const { inputs, files, overrides } = await localChecks(options);
  const detail = await request("getRecipe", reference);
  checkAssetPaths(files, detail.asset_paths);
  // The same local file is uploaded once even if it appears at several paths.
  const uploads = new Map<string, Promise<string>>();
  for (const file of files)
    if (!uploads.has(file.path)) uploads.set(file.path, request("uploadAsset", {}, file.path).then((asset) => {
      if (typeof asset.url !== "string") throw new CliError("invalid_response", "Upload returned no asset URL.");
      return asset.url;
    }));
  const urls = new Map(await Promise.all(files.map(async (file) => [file.url, await uploads.get(file.path)!] as const)));
  // Only the flags the user passed: the API merges the recipe defaults and knows which keys each format accepts.
  const body: RenderRequest = {
    recipe: { id: detail.id, version: detail.version },
    inputs: replaceFiles(inputs, urls) as Json,
    ...(Object.keys(overrides).length ? { output: overrides as OutputOptions } : {}),
  };
  const initial = await request("renderRecipe", {}, body);
  return options.wait || options.output ? awaitRender(initial, options.output) : settled(initial);
}

export async function waitRender(options: RenderOptions): Promise<unknown> {
  const value = await readInput(options.input);
  const render = (value.data && typeof value.data === "object" ? value.data : value) as Render;
  if (!["completed", "pending", "failed"].includes(render.status))
    throw new CliError("invalid_input",
      `Input is not a render: status must be one of completed, pending, failed; got ${JSON.stringify(render.status)}.`,
      undefined, "Pass the JSON printed by `tweenframe recipes render` (with or without its {data: ...} wrapper).");
  if (options.output !== undefined && (await stat(options.output).catch(() => null))?.isDirectory())
    throw new CliError("invalid_value", `--output must be a file path, not a directory; got ${options.output}.`,
      { option: "--output", value: options.output }, "Name the file to write, e.g. --output out/result.gif.");
  return awaitRender(render, options.output);
}

function settled(render: Render): Render {
  if (render.status === "failed")
    throw (render.error ? CliError.from(render.error) : new CliError("render_failed", "Render failed without an error body."))
      .withDetails({ uid: render.uid });
  return render;
}

// poll_url is the source of truth; uid + poll_token cover a missing or foreign URL.
function pollTarget(render: RenderPending): Json {
  if (render.poll_url) {
    const url = new URL(render.poll_url, apiUrl + "/");
    const jobKey = url.pathname.split("/").filter(Boolean).pop();
    const t = url.searchParams.get("t") ?? render.poll_token;
    if (jobKey && t) return { jobKey: decodeURIComponent(jobKey), t };
  }
  if (render.uid && render.poll_token) return { jobKey: render.uid, t: render.poll_token };
  throw new CliError("poll_url_missing", "Pending render has no poll URL.", { render });
}

async function awaitRender(initial: Render, destination?: string): Promise<unknown> {
  let current = initial;
  const deadline = Date.now() + pollDeadlineMs;
  while (current.status === "pending") {
    if (Date.now() > deadline)
      throw new CliError("render_timeout", "Render is still pending after six minutes.", { render: current });
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    current = await request("getRender", pollTarget(current));
  }
  const done = settled(current);
  if (done.status !== "completed" || !done.result_url)
    throw new CliError("render_failed", "Render did not produce a result URL.", { render: done });
  if (!destination) return done;
  try {
    return { render: done, download: await saveResult(done.result_url, destination) };
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    throw error.withDetails({ uid: done.uid, status: done.status, result_url: done.result_url });
  }
}

async function saveResult(url: string, path: string): Promise<{ path: string; bytes: number }> {
  const absolute = new URL(url, apiUrl + "/").href;
  const response = await fetchOrFail(absolute).catch((error: CliError) => {
    throw new CliError("download_failed", error.message, error.body.details);
  });
  if (!response.ok)
    throw new CliError("download_failed", `Result download returned HTTP ${response.status}.`, { http_status: response.status });
  const bytes = Buffer.from(await response.arrayBuffer());
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  } catch (error) {
    throw new CliError("write_failed", error instanceof Error ? error.message : String(error), { path });
  }
  return { path, bytes: bytes.length };
}
