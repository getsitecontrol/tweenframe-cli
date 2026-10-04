import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const source = process.env.TWEENFRAME_OPENAPI_URL ?? "http://localhost:3005/api/public/v1/openapi.json";
const destination = resolve("openapi/tweenframe.json");
const response = await fetch(source);
if (!response.ok) throw new Error(`OpenAPI download failed: HTTP ${response.status}`);
const spec = await response.json();
if (spec.openapi !== "3.1.0" || !spec.paths || !spec.components?.schemas) {
  throw new Error("Expected the TweenFrame OpenAPI 3.1 contract.");
}
const next = JSON.stringify(spec, null, 2) + "\n";
if (process.argv.includes("--check")) {
  const previous = await readFile(destination, "utf8");
  if (previous !== next) throw new Error("OpenAPI snapshot differs. Run npm run sync:openapi.");
} else {
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, next);
  process.stdout.write(`Saved ${destination}\n`);
}
