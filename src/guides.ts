import { docs, docsUrl } from "./config.js";
import { fetchOrFail } from "./api.js";
import { CliError } from "./errors.js";

export type Guide = { name: string; title: string; description: string; url: string };

async function fetchText(url: string, accept: string): Promise<string> {
  const response = await fetchOrFail(url, { headers: { accept } }).catch((error: CliError) => {
    throw error.body.code === "network_error"
      ? new CliError("network_error", `Cannot fetch ${url}: ${String(error.body.details?.reason ?? error.message)}.`,
        { url, reason: error.body.details?.reason }, "Check the network and TWEENFRAME_API_URL, or open the URL in a browser.")
      : error;
  });
  if (!response.ok)
    throw new CliError("docs_unavailable", `${url} returned HTTP ${response.status}.`, { url, status: response.status });
  return response.text();
}

export async function guides(): Promise<Guide[]> {
  const text = await fetchText(docs.index, "application/json");
  let list: unknown;
  try {
    list = (JSON.parse(text) as { guides?: unknown }).guides;
  } catch { /* reported below */ }
  if (!Array.isArray(list) || list.some((item) => typeof item?.name !== "string" || typeof item?.url !== "string"))
    throw new CliError("invalid_response", `${docs.index} is not a guide index ({"guides": [{name, url, ...}]}).`, { url: docs.index });
  return list.map((item: Guide) => ({
    name: item.name, title: item.title ?? item.name, description: item.description ?? "", url: docsUrl(item.url),
  }));
}

export function guideList(list: Guide[]): string {
  const column = Math.max(...list.map((guide) => guide.name.length)) + 2;
  return "Agent guides (`tweenframe docs <name>` prints one):\n\n"
    + list.map((guide) => `  ${guide.name.padEnd(column)}${guide.description || guide.title}\n  ${" ".repeat(column)}${guide.url}`)
      .join("\n") + `\n\nIndex: ${docs.index}\n`;
}

const normalize = (name: string): string => name.toLowerCase().replace(/\.md$/, "");

export async function guideText(name: string): Promise<string> {
  const list = await guides();
  const guide = list.find((item) => normalize(item.name) === normalize(name));
  if (!guide)
    throw new CliError("docs_not_found", `No guide named ${JSON.stringify(name)}; available: ${list.map((item) => item.name).join(", ")}.`,
      { name, available: list.map((item) => item.name), index: docs.index });
  const text = await fetchText(guide.url, "text/markdown, text/plain");
  return text.endsWith("\n") ? text : text + "\n";
}
