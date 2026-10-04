import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
// A fixed API URL keeps the documentation links predictable.
const env = { ...process.env, TWEENFRAME_API_URL: "https://api.test/api/public/v1" };
const cli = (...args) => execute(process.execPath, ["dist/cli.js", ...args], { env });

test("help entry points agree", async () => {
  const help = await cli("help");
  assert.equal((await cli()).stdout, help.stdout);
  assert.equal((await cli("--help")).stdout, help.stdout);
  assert.equal((await cli("help", "recipes")).stdout, (await cli("recipes")).stdout);
  assert.equal((await cli("help", "recipes", "render")).stdout, (await cli("recipes", "render", "--help")).stdout);
  assert.equal((await cli("help", "auth", "email", "verify")).stdout, (await cli("auth", "email", "verify", "--help")).stdout);
  assert.equal((await cli("help", "auth", "email")).stdout, (await cli("auth", "email")).stdout);
});

test("every command help has a usage line and a docs link", async () => {
  for (const command of ["recipes render", "auth status", "renders wait", "docs", "help", "assets upload", "auth email verify"]) {
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

  const verify = JSON.parse((await cli("help", "--json", "auth", "email", "verify")).stdout).data.operations;
  assert.deepEqual(verify.map((op) => op.operationId), ["verifyEmailCode"]);
  assert.deepEqual(verify[0].options.map((option) => [option.flag, option.field, option.required]),
    [["challenge", "challenge_id", true], ["code", "code", true]]);

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
  assert.equal(missing.docs, "https://api.test/docs/agent/errors.md#usage");

  const unknown = await fault("recipes", "rendr");
  assert.equal(unknown.code, "unknown_command");
  assert.equal(unknown.docs, "https://api.test/docs/agent/errors.md#unknown_command");
});
