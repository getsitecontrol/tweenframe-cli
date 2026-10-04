import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const api = "/api/public/v1";
const gif = Buffer.from("GIF89a");
const detail = {
  id: "real-estate/banner-7", version: 1, title: "Banner", description: "d", tags: [], preview_url: "/p.webp",
  asset_paths: [["photos", "*", "src"], ["logo", "src"]],
  input_schema: {
    type: "object", required: ["photos"],
    $defs: {
      Media: {
        type: "object", required: ["src"],
        properties: {
          src: { type: "string", "x-input-type": "asset", description: "Photo, e.g. a file:// URL." },
          focus: { type: "array", items: { type: "number", minimum: 0, maximum: 1 }, minItems: 2, maxItems: 2, description: "Crop focus." },
        },
      },
    },
    properties: {
      headline: { type: "string", default: "LOFT", description: "Headline. Shown at the top." },
      photos: {
        type: "array", minItems: 1, description: "Photos in order.", "x-group": "Photos",
        items: { $ref: "#/$defs/Media", "x-accept": ["image"] },
      },
      logo: {
        anyOf: [{ $ref: "#/$defs/Media" }, { type: "null" }], default: null, description: "Logo.", "x-group": "Photos",
        "x-accept": ["image", "gif"],
      },
      phone: { type: "string", description: "Phone.", "x-group": "Contacts" },
      contact_title: { type: "string", default: "Call", description: "Heading.", "x-group": "Contacts",
        "x-shown-when": { any: ["phone"] } },
      layout: {
        type: "object", description: "Layout.",
        properties: {
          grid: { type: "object", description: "Grid.", properties: { gap: { type: "number", description: "Gap." } } },
          side: { enum: ["left", "right"], "x-shown-when": { param: "mode", in: ["split"] }, description: "Side." },
          note: { type: "string", "x-shown-when": { param: "headline" }, description: "Note." },
        },
      },
    },
  },
  output: { format: "gif", fps: 20, width: 900 },
  docs: { guide: "/docs/agent/recipes.md" },
  examples: [{ name: "minimal", description: "One photo.", inputs: { photos: [{ src: "/template-catalog/assets/a.jpg" }] } }],
};
const textDetail = {
  ...detail, id: "text/loop", asset_paths: [],
  input_schema: { type: "object", properties: { text: { type: "string", description: "Text." } } },
  examples: [{ name: "minimal", description: "One line.", inputs: { text: "Hello" } }],
};
const guides = [
  { name: "skill", title: "TweenFrame skill", description: "Setup and workflow.", url: "/docs/agent/SKILL.md" },
  { name: "errors", title: "Errors", description: "Every error code and what to do.", url: "/docs/agent/errors.md" },
  { name: "recipes", title: "Recipes", description: "How recipes work.", url: "/docs/agent/recipes.md" },
];
const errorsGuide = "# Errors\n\n## invalid_value\n\nA value is outside its range.";
let calls = [];
let polls = {};
let server;
let base;
let directory;

function handle(request, body) {
  const url = new URL(request.url, "http://mock");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const route = url.pathname.slice(api.length);
  if (url.pathname === "/result.gif") return [200, gif];
  if (url.pathname === "/docs/agent/index.json") return [200, { guides }];
  if (url.pathname === "/docs/agent/errors.md") return [200, Buffer.from(errorsGuide)];
  if (url.pathname === "/docs/agent/recipes.md") return [500, Buffer.from("boom")];
  if (route === "/identity") return [200, { id: "tf_test", token: "test-token", expires_at: "2099-01-01T00:00:00Z" }];
  if (route === "/auth/email/start") return [200, { challenge_id: "ch_1", expires_at: "2099-01-01T00:10:00Z" }];
  if (route === "/auth/email/verify") {
    const { code } = JSON.parse(body);
    if (code !== "042917")
      return [400, { error: { code: "email_code_invalid", message: "The code is wrong or expired.", hint: "Start over." } }];
    return [200, { token: "account-key", kind: "account", email: "person@example.com", account_id: "acc_1", workspace_id: "ws_1" }];
  }
  if (route === "/recipes") return [200, { recipes: [{ id: detail.id, version: 1 }] }];
  if (route === "/recipes/real-estate/banner-7" && [null, "1"].includes(url.searchParams.get("version")))
    return [200, detail];
  if (route === "/recipes/text/loop") return [200, textDetail];
  if (route.startsWith("/recipes/"))
    return [404, { error: {
      code: "recipe_not_found", message: "Recipe is not in the public catalog.",
      hint: "Run `tweenframe recipes list`.", docs: "/docs/agent/errors.md#recipe_not_found",
    } }];
  if (route === "/assets") {
    const name = body.toString().match(/image-(\w+)/)[1];
    return [201, { id: name, url: `https://assets.test/${name}.png`, sha256: "a".repeat(64) }];
  }
  if (route === "/assets/analyze") {
    const { url: source, aspects } = JSON.parse(body);
    if (source.includes("foreign"))
      return [403, { error: { code: "asset_forbidden", message: "Referenced asset is not owned by this account." } }];
    const crop = { x: 0.1, y: 0, w: 0.8, h: 0.9, object_position: { x: 0.5, y: 0 } };
    return [200, {
      contract_version: 2, model_version: { selector: "2" },
      image: { width: 1200, height: 800, orientation_applied: false },
      focal: { x: 0.5, y: 0.3, source: "saliency", confidence: 0.8 },
      subject: { x: 0.1, y: 0, w: 0.8, h: 0.7 }, object_position: { x: 0.5, y: 0.2 },
      faces: [], crops: Object.fromEntries(aspects.map((aspect) => [aspect, crop])), warnings: [],
    }];
  }
  if (route === "/renders") {
    const { inputs } = JSON.parse(body);
    if (inputs.headline === "wide") return [403, { error: {
      code: "registration_required", message: "Rendering 1600 px wide needs an account. Verify your email and repeat the request.",
      details: { limit: 1000, actual: 1600, render_started: false },
      hint: "Ask the user for their email, run `auth email start`, then `auth email verify`.",
      docs: "/docs/agent/errors.md#registration_required",
    } }];
    const job = { pending: "job-ok", failed: "job-fail", missing: "job-missing" }[inputs.headline];
    if (!job) return [200, { status: "completed", uid: "r0", format: "gif", result_url: `${origin}/result.gif` }];
    return [200, { status: "pending", uid: job, poll_url: `${api}/renders/${job}?t=tok`, poll_token: "tok" }];
  }
  const job = route.match(/^\/renders\/([\w-]+)$/)?.[1];
  if (job && url.searchParams.get("t") === "tok") {
    polls[job] = (polls[job] ?? 0) + 1;
    if (job === "job-fail")
      return [200, { status: "failed", uid: job, error: { code: "render_error", message: "Font missing." } }];
    if (polls[job] < 3) return [200, { status: "pending", uid: job, poll_url: `${api}/renders/${job}?t=tok`, poll_token: "tok" }];
    const result = job === "job-missing" ? "/missing.gif" : "/result.gif";
    return [200, { status: "completed", uid: job, format: "gif", result_url: `${origin}${result}` }];
  }
  return [404, { error: { code: "not_found", message: "Not found" } }];
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "tweenframe-cli-"));
  server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    calls.push({ url: request.url, method: request.method, auth: request.headers.authorization, body });
    const [status, payload] = handle(request, body);
    response.statusCode = status;
    if (Buffer.isBuffer(payload)) return response.end(payload);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(payload));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}${api}`;
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
});
beforeEach(() => { calls = []; polls = {}; });

function run(args, env = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, ["dist/cli.js", ...args], {
      env: { ...process.env, TWEENFRAME_API_URL: base, TWEENFRAME_AUTH_FILE: join(directory, "auth.json"), ...env },
    }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
  });
}
async function ok(...args) {
  const result = await run(args);
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout).data;
}
async function fails(args, env) {
  const result = await run(args, env);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  return JSON.parse(result.stderr).error;
}
async function photo(name) {
  const path = join(directory, `${name}.png`);
  await writeFile(path, `image-${name}`);
  return pathToFileURL(path).href;
}

test("auth, catalog, render with polling, download and renders wait", async () => {
  assert.equal((await ok("auth", "init")).id, "tf_test");
  assert.equal((await ok("auth", "status")).authenticated, true);
  assert.equal((await ok("recipes", "list")).recipes[0].id, "real-estate/banner-7");
  assert.equal((await ok("recipes", "show", "real-estate/banner-7", "--json")).version, 1);
  assert.equal(calls.at(-1).url, `${api}/recipes/real-estate/banner-7`);

  const [one, two] = [await photo("one"), await photo("two")];
  const destination = join(directory, "out", "result.gif");
  calls = [];
  const result = await ok(
    "recipes", "render", "real-estate/banner-7",
    "--input", JSON.stringify({
      headline: "pending",
      photos: [{ src: one, focus: [0.5, 0.5] }, { src: two }, { src: one }],
    }),
    "--quality", "normal", "--width", "600", "--output", destination,
  );
  assert.equal(polls["job-ok"], 3);
  assert.equal(result.render.status, "completed");
  assert.equal(result.download.bytes, gif.length);
  assert.deepEqual(await readFile(destination), gif);

  const uploads = calls.filter((call) => call.url === `${api}/assets`);
  assert.equal(uploads.length, 2, "the same file:// is uploaded once per render");
  assert.ok(uploads.every((call) => call.auth === "Bearer test-token"));
  const renderRequest = JSON.parse(calls.find((call) => call.url === `${api}/renders`).body);
  assert.deepEqual(renderRequest.recipe, { id: "real-estate/banner-7", version: 1 });
  assert.deepEqual(renderRequest.inputs.photos, [
    { src: "https://assets.test/one.png", focus: [0.5, 0.5] },
    { src: "https://assets.test/two.png" },
    { src: "https://assets.test/one.png" },
  ]);
  assert.deepEqual(renderRequest.output, { width: 600, quality: "normal" });

  const envelope = join(directory, "render-output.json");
  await writeFile(envelope, JSON.stringify({ data: result.render }));
  assert.equal((await ok("renders", "wait", "--input", envelope)).status, "completed");

  calls = [];
  await ok("recipes", "render", "real-estate/banner-7", "--input", JSON.stringify(renderRequest.inputs));
  assert.equal(calls.filter((call) => call.url === `${api}/assets`).length, 0);
  assert.equal(calls.find((call) => call.url === `${api}/renders`).body.includes('"output"'), false);

  calls = [];
  await ok("recipes", "render", "real-estate/banner-7", "--input", '{"headline":"x"}', "--format", "mp4", "--width", "300");
  assert.deepEqual(JSON.parse(calls.find((call) => call.url === `${api}/renders`).body).output, { format: "mp4", width: 300 },
    "recipe output defaults such as loop are not copied into the request");
});

test("recipes show pins a version with id@version or a second argument", async () => {
  await ok("auth", "init");
  for (const args of [["real-estate/banner-7@1"], ["real-estate/banner-7", "1"]]) {
    calls = [];
    assert.equal((await ok("recipes", "show", ...args, "--json")).id, "real-estate/banner-7");
    assert.equal(calls[0].url, `${api}/recipes/real-estate/banner-7?version=1`);
  }
  const error = await fails(["recipes", "show", "real-estate/banner-7@2"]);
  assert.equal(error.code, "recipe_not_found");
});

test("recipes show prints a readable summary, --example prints one example's inputs", async () => {
  const { code, stdout } = await run(["recipes", "show", "real-estate/banner-7"]);
  assert.equal(code, 0);
  assert.ok(stdout.length > 0);

  const example = await run(["recipes", "show", "real-estate/banner-7", "--example", "minimal"]);
  assert.equal(example.code, 0);
  assert.deepEqual(JSON.parse(example.stdout), detail.examples[0].inputs);
  assert.equal(example.stderr, "Image input photos[].src holds catalog photos; "
    + "replace them with file:///absolute/path to use your own.\n", "only image paths set in the example are named, on stderr");
  const text = await run(["recipes", "show", "text/loop", "--example", "minimal"]);
  assert.equal(text.code, 0);
  assert.deepEqual(JSON.parse(text.stdout), { text: "Hello" });
  assert.equal(text.stderr, "", "no note without images");

  const unknown = await fails(["recipes", "show", "real-estate/banner-7", "--example", "full"]);
  assert.equal(unknown.code, "invalid_value");
  assert.deepEqual(unknown.details.allowed, ["minimal"]);
  calls = [];
  const both = await fails(["recipes", "show", "real-estate/banner-7", "--json", "--example", "minimal"]);
  assert.equal(both.code, "usage");
  assert.equal(calls.length, 0, "a usage error sends no request");
});

test("API error envelope goes to stderr with an absolute docs link and exit code 1", async () => {
  const error = await fails(["recipes", "show", "real-estate/unknown"]);
  assert.deepEqual(error, {
    code: "recipe_not_found", message: "Recipe is not in the public catalog.", hint: "Run `tweenframe recipes list`.",
    docs: `${new URL(base).origin}/docs/agent/errors.md#recipe_not_found`,
  });
});

test("failed render exits 1 with the render error and uid", async () => {
  await ok("auth", "init");
  const error = await fails(["recipes", "render", "real-estate/banner-7", "--input", '{"headline":"failed"}', "--wait"]);
  assert.equal(error.code, "render_error");
  assert.equal(error.details.uid, "job-fail");
});

test("download failure keeps the render data in error details", async () => {
  await ok("auth", "init");
  const error = await fails([
    "recipes", "render", "real-estate/banner-7", "--input", '{"headline":"missing"}', "--output", join(directory, "x.gif"),
  ]);
  assert.equal(error.code, "download_failed");
  assert.equal(error.details.uid, "job-missing");
  assert.equal(error.details.status, "completed");
  assert.match(error.details.result_url, /\/missing\.gif$/);
  assert.equal(error.details.http_status, 404);
});

test("expired token is auth_required before any request", async () => {
  const authFile = join(directory, "expired.json");
  await writeFile(authFile, JSON.stringify({ id: "tf_old", token: "old", expires_at: "2020-01-01T00:00:00Z" }));
  const env = { TWEENFRAME_AUTH_FILE: authFile };
  const status = JSON.parse((await run(["auth", "status"], env)).stdout).data;
  assert.equal(status.authenticated, false);
  assert.equal(status.expired, true);
  const error = await fails(["recipes", "render", "real-estate/banner-7", "--input", '{"headline":"x"}'], env);
  assert.equal(error.code, "auth_required");
  assert.equal(calls.length, 0);
});

test("local validation happens before any network call", async () => {
  await ok("auth", "init");
  calls = [];
  const render = ["recipes", "render", "real-estate/banner-7"];
  assert.equal((await fails([...render, "--input", "{}", "--loop", "yes"])).code, "invalid_value");
  assert.equal((await fails([...render, "--input", "{}", "--width", "5"])).code, "invalid_value");
  assert.equal((await fails([...render, "--input", "[1]"])).code, "invalid_json");
  const missing = pathToFileURL(join(directory, "missing.png")).href;
  const error = await fails([...render, "--input", JSON.stringify({ photos: [{ src: missing }] })]);
  assert.equal(error.code, "file_not_found");
  assert.equal((await fails(["assets", "upload", join(directory, "nope.png")])).details.path, join(directory, "nope.png"));
  assert.equal(calls.length, 0);
});

test("file:// outside asset paths is rejected", async () => {
  await ok("auth", "init");
  const error = await fails([
    "recipes", "render", "real-estate/banner-7", "--input", JSON.stringify({ headline: await photo("three") }),
  ]);
  assert.equal(error.code, "invalid_input");
  assert.deepEqual(error.details.path, ["headline"]);
});

const analyzeCalls = () => calls.filter((call) => call.url === `${api}/assets/analyze`);

test("assets analyze uploads a local file and analyzes the managed URL", async () => {
  await ok("auth", "init");
  calls = [];
  const file = await photo("house");
  const data = await ok("assets", "analyze", file, "--aspect", "4:5", "--aspect", "3:2");
  assert.equal(data.asset.url, "https://assets.test/house.png");
  assert.equal(data.analysis.focal.y, 0.3);
  assert.deepEqual(Object.keys(data.analysis.crops), ["4:5", "3:2"]);
  assert.deepEqual(calls.map((call) => call.url), [`${api}/assets`, `${api}/assets/analyze`]);
  assert.deepEqual(JSON.parse(analyzeCalls()[0].body), { url: "https://assets.test/house.png", aspects: ["4:5", "3:2"] });
  assert.equal(analyzeCalls()[0].auth, "Bearer test-token");

  calls = [];
  const plain = await ok("assets", "analyze", new URL(file).pathname);
  assert.equal(plain.asset.url, "https://assets.test/house.png");
  assert.deepEqual(JSON.parse(analyzeCalls()[0].body).aspects, []);
});

test("assets analyze sends an asset URL or catalog path without uploading", async () => {
  await ok("auth", "init");
  for (const source of ["https://assets.test/house.png", `/template-catalog/assets/${"a".repeat(64)}.jpg`]) {
    calls = [];
    const data = await ok("assets", "analyze", source, "--aspect", "1:1");
    assert.equal(data.asset, undefined);
    assert.deepEqual(Object.keys(data.analysis.crops), ["1:1"]);
    assert.deepEqual(calls.map((call) => call.url), [`${api}/assets/analyze`]);
    assert.equal(JSON.parse(calls[0].body).url, source);
  }
});

test("assets analyze validates aspects and files locally and relays API errors", async () => {
  await ok("auth", "init");
  calls = [];
  const source = "https://assets.test/house.png";
  assert.equal((await fails(["assets", "analyze", source, "--aspect", "4/5"])).code, "invalid_value");
  assert.equal((await fails(["assets", "analyze", source, "--aspect", "04:5"])).code, "invalid_value");
  assert.equal((await fails(["assets", "analyze", join(directory, "nope.png")])).code, "file_not_found");
  assert.equal(calls.length, 0);
  const error = await fails(["assets", "analyze", "https://assets.test/foreign.png"]);
  assert.equal(error.code, "asset_forbidden");
});

test("docs lists the guides from the site index and prints one verbatim", async () => {
  const origin = new URL(base).origin;
  const listing = await run(["docs"]);
  assert.equal(listing.code, 0, listing.stderr);
  assert.equal(listing.stdout, [
    "Agent guides (`tweenframe docs <name>` prints one):",
    "",
    "  skill    Setup and workflow.",
    `           ${origin}/docs/agent/SKILL.md`,
    "  errors   Every error code and what to do.",
    `           ${origin}/docs/agent/errors.md`,
    "  recipes  How recipes work.",
    `           ${origin}/docs/agent/recipes.md`,
    "",
    `Index: ${origin}/docs/agent/index.json`,
    "",
  ].join("\n"));
  assert.equal((await ok("docs", "--json")).guides[1].url, `${origin}/docs/agent/errors.md`);

  for (const name of ["errors", "ERRORS.md"]) {
    const guide = await run(["docs", name]);
    assert.equal(guide.code, 0, guide.stderr);
    assert.equal(guide.stdout, errorsGuide + "\n");
  }

  const unknown = await fails(["docs", "nope"]);
  assert.equal(unknown.code, "docs_not_found");
  assert.deepEqual(unknown.details.available, ["skill", "errors", "recipes"]);
  assert.equal(unknown.docs, `${origin}/docs/agent/errors.md#docs_not_found`);

  const broken = await fails(["docs", "recipes"]);
  assert.equal(broken.code, "docs_unavailable");
  assert.equal(broken.details.url, `${origin}/docs/agent/recipes.md`);
});

test("docs offline fails with network_error naming the URL", async () => {
  const error = await fails(["docs"], { TWEENFRAME_API_URL: "http://127.0.0.1:9/api/public/v1" });
  assert.equal(error.code, "network_error");
  assert.equal(error.details.url, "http://127.0.0.1:9/docs/agent/index.json");
  assert.equal(error.docs, "http://127.0.0.1:9/docs/agent/errors.md#network_error");
});

test("local errors name the allowed values and carry hint and docs", async () => {
  await ok("auth", "init");
  calls = [];
  const errors = `${new URL(base).origin}/docs/agent/errors.md`;
  const render = ["recipes", "render", "real-estate/banner-7", "--input", "{}"];
  const cases = [
    [[...render, "--width", "5"], "invalid_value"],
    [[...render, "--fps", "31"], "invalid_value"],
    [[...render, "--quality", "best"], "invalid_value"],
    [[...render, "--loop", "yes"], "invalid_value"],
    [[...render, "--scale", "0"], "invalid_value"],
    [[...render, "--scale", "5.5"], "invalid_value"],
    [["recipes", "render", "real-estate/banner-7@x", "--input", "{}"], "usage"],
    [["recipes", "render", "real-estate/banner-7", "--input", "[1]"], "invalid_json"],
    [["assets", "analyze", "https://assets.test/a.png", "--aspect", "4/5"], "invalid_value"],
    [["assets", "upload", join(directory, "nope.png")], "file_not_found"],
  ];
  for (const [args, code] of cases) {
    const error = await fails(args);
    assert.equal(error.code, code, args.join(" "));
    assert.equal(typeof error.hint, "string");
    assert.ok(error.hint.length > 10);
    assert.equal(error.docs, `${errors}#${code}`);
  }
  const auth = await fails(["recipes", "render", "real-estate/banner-7", "--input", "{}"],
    { TWEENFRAME_AUTH_FILE: join(directory, "none.json") });
  assert.equal(auth.code, "auth_required");
  assert.equal(calls.length, 0);
});

test("email sign-in stores the account key without printing it", async () => {
  const authFile = join(directory, "account.json");
  const env = { TWEENFRAME_AUTH_FILE: authFile };
  const anonymous = await run(["auth", "init"], env);
  assert.equal(anonymous.code, 0, anonymous.stderr);
  assert.equal(JSON.parse((await run(["auth", "status"], env)).stdout).data.kind, "anonymous");

  calls = [];
  const start = await run(["auth", "email", "start", "--email", "person@example.com"], env);
  assert.equal(start.code, 0, start.stderr);
  assert.deepEqual(JSON.parse(start.stdout).data, { challenge_id: "ch_1", expires_at: "2099-01-01T00:10:00Z" });
  assert.equal(calls[0].url, `${api}/auth/email/start`);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].auth, "Bearer test-token");
  assert.deepEqual(JSON.parse(calls[0].body), { email: "person@example.com" });

  calls = [];
  const verify = await run(["auth", "email", "verify", "--challenge", "ch_1", "--code", "042917"], env);
  assert.equal(verify.code, 0, verify.stderr);
  assert.equal(calls[0].url, `${api}/auth/email/verify`);
  assert.equal(calls[0].auth, "Bearer test-token");
  assert.deepEqual(JSON.parse(calls[0].body), { challenge_id: "ch_1", code: "042917" }, "leading zeros are kept");
  assert.doesNotMatch(verify.stdout + verify.stderr, /account-key/);
  const printed = JSON.parse(verify.stdout).data;
  assert.equal(printed.kind, "account");
  assert.equal(printed.email, "person@example.com");
  assert.equal(printed.workspace_id, "ws_1");
  assert.equal(printed.auth_file, authFile);
  assert.equal(printed.token, undefined);
  assert.deepEqual(JSON.parse(await readFile(authFile, "utf8")),
    { token: "account-key", kind: "account", email: "person@example.com" }, "no expires_at: the key does not expire");

  const status = JSON.parse((await run(["auth", "status"], env)).stdout).data;
  assert.equal(status.authenticated, true);
  assert.equal(status.expired, false);
  assert.equal(status.kind, "account");
  assert.equal(status.email, "person@example.com");
  calls = [];
  await run(["assets", "upload", new URL(await photo("account")).pathname], env);
  assert.equal(calls[0].auth, "Bearer account-key", "the account key is the bearer from now on");
});

test("email sign-in validates the code locally and passes API errors through", async () => {
  await ok("auth", "init");
  calls = [];
  const short = await fails(["auth", "email", "verify", "--challenge", "ch_1", "--code", "42917"]);
  assert.equal(short.code, "invalid_value");
  const missing = await fails(["auth", "email", "start"]);
  assert.equal(missing.code, "usage");
  assert.equal(calls.length, 0);

  const wrong = await fails(["auth", "email", "verify", "--challenge", "ch_1", "--code", "000000"]);
  assert.equal(wrong.code, "email_code_invalid");
  assert.equal(JSON.parse(await readFile(join(directory, "auth.json"), "utf8")).token, "test-token",
    "a failed verify keeps the stored identity");
});

test("registration_required from a render passes through with hint and docs", async () => {
  await ok("auth", "init");
  const error = await fails(["recipes", "render", "real-estate/banner-7", "--input", '{"headline":"wide"}', "--width", "1600"]);
  assert.equal(error.code, "registration_required");
  assert.deepEqual(error.details, { limit: 1000, actual: 1600, render_started: false });
  assert.equal(typeof error.hint, "string");
  assert.equal(error.docs, `${new URL(base).origin}/docs/agent/errors.md#registration_required`);
});
