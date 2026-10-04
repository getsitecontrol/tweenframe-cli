import { readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { operations, type OperationId } from "./generated/contract.js";
import type { ErrorBody, OperationResponses } from "./generated/types.js";
import { CliError, type Json } from "./errors.js";
import { apiUrl } from "./config.js";
import { allowed, type Schema } from "./schema.js";

export { apiUrl };

export type Operation = (typeof operations)[number];
export type { Schema } from "./schema.js";
// One shape for the anonymous identity and the account key; no expires_at means no expiry.
export type SavedIdentity = { id?: string; token?: string; expires_at?: string; kind?: string; email?: string };

export const authFile = process.env.TWEENFRAME_AUTH_FILE ?? join(homedir(), ".config", "tweenframe-cli", "auth.json");
const byId = new Map<string, Operation>(operations.map((item) => [item.operationId, item]));
const timeoutMs = 120_000;

export async function savedIdentity(): Promise<SavedIdentity | null> {
  try {
    return JSON.parse(await readFile(authFile, "utf8")) as SavedIdentity;
  } catch {
    return null;
  }
}

// An unparsable expiry counts as expired, so a broken file never sends a stale token.
export const isExpired = (identity: SavedIdentity): boolean =>
  identity.expires_at !== undefined && !(Date.parse(identity.expires_at) > Date.now());

export async function token(): Promise<string> {
  if (process.env.TWEENFRAME_TOKEN) return process.env.TWEENFRAME_TOKEN;
  const saved = await savedIdentity();
  if (!saved?.token)
    throw new CliError("auth_required", "No identity. Run `tweenframe auth init` or set TWEENFRAME_TOKEN.", { auth_file: authFile });
  if (isExpired(saved))
    throw new CliError("auth_required", `Token expired at ${saved.expires_at}. Run \`tweenframe auth init\`.`, {
      auth_file: authFile, expires_at: saved.expires_at,
    });
  return saved.token;
}

export function typed(raw: string, schema: Schema, label: string): string | number | boolean {
  const fail = (): never => {
    throw new CliError("invalid_value", `${label} must be ${allowed(schema)}; got ${JSON.stringify(raw)}.`, {
      option: label, value: raw, allowed: allowed(schema),
    });
  };
  let value: string | number | boolean = raw;
  if (schema.type === "integer" || schema.type === "number") {
    value = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(value) || schema.type === "integer" && !Number.isInteger(value)) fail();
    if (schema.minimum !== undefined && value < schema.minimum ||
        schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum ||
        schema.maximum !== undefined && value > schema.maximum) fail();
  } else if (schema.type === "boolean") {
    if (raw !== "true" && raw !== "false") fail();
    value = raw === "true";
  }
  if (schema.enum && !schema.enum.includes(value)) fail();
  if (schema.pattern && !new RegExp(schema.pattern, "u").test(raw)) fail();
  return value;
}

// Recipe ids contain slashes; keep them readable and encode each segment.
function pathValue(value: string, name: string): string {
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === ".."))
    throw new CliError("invalid_value", `${name} must not contain empty, "." or ".." path segments; got ${JSON.stringify(value)}.`,
      { option: name, value }, "Use the recipe id exactly as `tweenframe recipes list` prints it, e.g. real-estate/banner-7.");
  return segments.map(encodeURIComponent).join("/");
}

export async function localFile(path: string): Promise<Blob> {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile())
    throw new CliError("file_not_found", `No readable file at ${path}${info?.isDirectory() ? " (it is a directory)" : ""}.`, { path });
  return new Blob([await readFile(path)]);
}

export async function fetchOrFail(url: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const cause = (error as { cause?: { code?: string; message?: string } }).cause;
    const reason = cause?.code ?? cause?.message ?? (error instanceof Error ? error.message : String(error));
    throw new CliError("network_error",
      `Cannot reach ${url} (${reason}). The API base URL is ${apiUrl}; set TWEENFRAME_API_URL to change it.`,
      { url, api_url: apiUrl, reason });
  }
}

export async function request<K extends OperationId>(id: K, values: Json = {}, body?: unknown): Promise<OperationResponses[K]> {
  const op = byId.get(id);
  if (!op) throw new CliError("contract_error", `Unknown operation ${id}.`);
  let path: string = op.path;
  const query = new URLSearchParams();
  for (const parameter of op.parameters) {
    const raw = values[parameter.name];
    if (raw === undefined || raw === "") {
      if (parameter.required) throw new CliError("usage", `Missing ${parameter.name}${parameter.description ? `: ${parameter.description}` : "."}`);
      continue;
    }
    const value = String(typed(String(raw), parameter.schema as Schema, parameter.name));
    if (parameter.in === "path") path = path.replace(`{${parameter.name}}`, pathValue(value, parameter.name));
    else if (parameter.in === "query") query.set(parameter.name, value);
  }
  const headers = new Headers({ accept: "application/json" });
  let payload: BodyInit | undefined;
  if (body !== undefined && op.contentType === "application/json") {
    headers.set("content-type", "application/json");
    payload = JSON.stringify(body);
  } else if (body !== undefined && op.contentType === "multipart/form-data") {
    if (typeof body !== "string") throw new CliError("usage", "Upload requires a file path.");
    const field = Object.keys((op.bodySchema as { properties?: Json } | null)?.properties ?? {})[0];
    if (!field) throw new CliError("contract_error", "Upload field missing from OpenAPI.");
    const form = new FormData();
    form.set(field, await localFile(body), basename(body));
    payload = form;
  }
  if (op.authenticated) headers.set("authorization", `Bearer ${await token()}`);
  const url = `${apiUrl}${path}${query.size ? `?${query}` : ""}`;
  const response = await fetchOrFail(url, { method: op.method, headers, body: payload });
  let value: Json;
  try {
    value = await response.json() as Json;
  } catch {
    throw new CliError("invalid_response", `API returned HTTP ${response.status} without JSON.`, { url, status: response.status });
  }
  if (!response.ok) {
    const fault = value.error as Partial<ErrorBody> | undefined;
    if (typeof fault?.code === "string" && typeof fault.message === "string") throw CliError.from(fault as ErrorBody);
    throw new CliError("api_error", `API returned HTTP ${response.status} without an error envelope.`, { url, status: response.status });
  }
  return value as OperationResponses[K];
}
