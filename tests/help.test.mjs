import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

const execute = promisify(execFile);
// A fixed API URL keeps the documentation links in the snapshots stable.
const env = { ...process.env, TWEENFRAME_API_URL: "https://api.test/api/public/v1" };
const cli = (...args) => execute(process.execPath, ["dist/cli.js", ...args], { env });

// Help is the product here: snapshots make every wording change visible in review.
// UPDATE_SNAPSHOTS=1 npm test rewrites them.
async function matchesSnapshot(name, actual) {
  const path = `tests/snapshots/${name}.txt`;
  if (process.env.UPDATE_SNAPSHOTS) {
    await mkdir("tests/snapshots", { recursive: true });
    await writeFile(path, actual);
  }
  assert.equal(actual, await readFile(path, "utf8"), `${path} differs; rerun with UPDATE_SNAPSHOTS=1 if intended`);
}

test("help text snapshots", async () => {
  const cases = {
    "help": ["help"],
    "recipes": ["recipes"],
    "recipes-render": ["recipes", "render", "--help"],
    "recipes-show": ["recipes", "show", "--help"],
    "assets-analyze": ["assets", "analyze", "--help"],
    "renders-wait": ["renders", "wait", "--help"],
    "auth-status": ["auth", "status", "--help"],
    "docs": ["docs", "--help"],
  };
  for (const [name, args] of Object.entries(cases)) {
    const { stdout, stderr } = await cli(...args);
    assert.equal(stderr, "");
    await matchesSnapshot(name, stdout);
  }
});

test("help entry points agree", async () => {
  const help = await cli("help");
  assert.equal((await cli()).stdout, help.stdout);
  assert.equal((await cli("--help")).stdout, help.stdout);
  assert.equal((await cli("help", "recipes")).stdout, (await cli("recipes")).stdout);
  assert.equal((await cli("help", "recipes", "render")).stdout, (await cli("recipes", "render", "--help")).stdout);
});

test("command help names types, ranges, allowed values and a docs link", async () => {
  const { stdout } = await cli("recipes", "render", "--help");
  assert.match(stdout, /--width <16\.\.4000> +[^]*?integer\s+from\s+16\s+to\s+4000/);
  assert.match(stdout, /--quality <maximum\|normal\|minimal>/);
  assert.match(stdout, /--fps <0\.\.30> +[^]*?0 keeps the recipe.s authored frame rate/);
  assert.match(stdout, /--input <json\|file\|->/);
  assert.match(stdout, /--scale <0\.\.5> +[^]*?greater\s+than\s+0\s+and\s+at\s+most\s+5/);
  assert.match(stdout, /^Docs: https:\/\/api\.test\/docs\/agent\//m);
  for (const command of ["auth status", "renders wait", "docs", "help", "assets upload"]) {
    const help = (await cli(...command.split(" "), "--help")).stdout;
    assert.match(help, /^Usage: tweenframe /, command);
    assert.match(help, /^Docs: https?:\/\//m, command);
  }
});

test("help --json keeps the machine form and adds docs", async () => {
  const machine = JSON.parse((await cli("help", "--json", "recipes", "render")).stdout).data;
  assert.equal(machine.operations.length, 1);
  assert.equal(machine.operations[0].operationId, "renderRecipe");
  assert.equal(machine.operations[0].path, "/renders");
  assert.match(machine.operations[0].docs, /^https:\/\/api\.test\/docs\/agent\//);
  assert.ok(machine.schemas.RenderRequest);
  assert.ok(machine.schemas.OutputOptions);
  assert.equal(machine.docs.errors, "https://api.test/docs/agent/errors.md");
  assert.match(machine.docs.guide, /^https:\/\/api\.test\/docs\/agent\//);
  assert.equal(machine.docs.index, "https://api.test/docs/agent/index.json");

  const group = JSON.parse((await cli("help", "--json", "recipes")).stdout).data;
  assert.deepEqual(group.operations.map((op) => op.command), ["recipes list", "recipes show", "recipes render"]);
  await assert.rejects(cli("help", "--json", "rec"), (error) =>
    error.code === 1 && JSON.parse(error.stderr).error.code === "unknown_command");

  assert.match((await cli("--version")).stdout, /^\d+\.\d+\.\d+/);
});

test("usage errors point at the command's help and the errors guide", async () => {
  const fault = async (...args) => {
    const error = await cli(...args).then(() => assert.fail("expected exit 1"), (error) => error);
    assert.equal(error.code, 1);
    return JSON.parse(error.stderr).error;
  };
  const missing = await fault("recipes", "render", "real-estate/banner-7");
  assert.equal(missing.code, "usage");
  assert.match(missing.hint, /`tweenframe recipes render --help`/);
  assert.equal(missing.docs, "https://api.test/docs/agent/errors.md#usage");

  const unknown = await fault("recipes", "rendr");
  assert.equal(unknown.code, "unknown_command");
  assert.match(unknown.hint, /`tweenframe recipes --help`/);
  assert.equal(unknown.docs, "https://api.test/docs/agent/errors.md#unknown_command");
});
