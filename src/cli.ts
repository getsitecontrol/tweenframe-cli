#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Command, CommanderError } from "commander";
import { operations, outputOptions, schemas } from "./generated/contract.js";
import { apiUrl, authFile, isExpired, localFile, request, savedIdentity, type Operation } from "./api.js";
import { docs, groupDocs } from "./config.js";
import { commandDocs, commandHelp, groupDocsList, groupHelp, programHelp, type CommandDoc } from "./help.js";
import { guideList, guideText, guides } from "./guides.js";
import { analyzeSource, type AnalyzeOptions } from "./analyze.js";
import { CliError, type Json } from "./errors.js";
import type { RecipeDetail } from "./generated/types.js";
import { selector } from "./inputs.js";
import { startRender, waitRender, type RenderOptions } from "./renders.js";
import { exampleImageHint, exampleInputs, recipeSummary, type ShowOptions } from "./show.js";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const emit = (data: unknown): void => { process.stdout.write(JSON.stringify({ data }) + "\n"); };

async function execute(op: Operation, args: string[], options: Json): Promise<unknown> {
  switch (op.mode) {
    case "store-identity": {
      const identity = await request("createAnonymousIdentity");
      await mkdir(dirname(authFile), { recursive: true, mode: 0o700 });
      await writeFile(authFile, JSON.stringify(identity) + "\n", { mode: 0o600 });
      await chmod(authFile, 0o600);
      return { id: identity.id, expires_at: identity.expires_at, auth_file: authFile };
    }
    case "request": {
      const values: Json = Object.fromEntries(op.positionals.map((name, index) => [name, args[index]]));
      // `recipes show id@version` pins a version like `recipes render` does.
      if (op.operationId === "getRecipe") {
        const reference = selector(String(args[0] ?? ""));
        if (reference.version !== undefined && args[1] !== undefined)
          throw new CliError("usage", "Give the version either as <id>@<version> or as a second argument, not both.");
        if (options.json && options.example !== undefined)
          throw new CliError("usage", "Use either --json or --example, not both.");
        Object.assign(values, { id: reference.id, version: args[1] ?? reference.version });
      }
      return request(op.operationId, values);
    }
    case "upload":
      await localFile(args[0]);
      return request(op.operationId, {}, args[0]);
    case "analyze":
      return analyzeSource(args[0], options as AnalyzeOptions);
    case "render":
      return startRender(args[0], options as RenderOptions);
    case "wait":
      return waitRender(options as RenderOptions);
    default: {
      const unknown: never = op;
      throw new CliError("contract_error", `Unsupported command mode in ${JSON.stringify(unknown)}.`);
    }
  }
}

let commanderOutput = "";
const program = new Command();
program.name("tweenframe").version(version);
program.exitOverride();
// Commander's own messages are replaced by JSON errors; help shown on a bare group is kept.
program.configureOutput({ writeErr: (text) => { commanderOutput += text; } });
program.helpInformation = () => programHelp(version);

const docOf = (path: string): CommandDoc => {
  const doc = commandDocs.find((item) => item.path === path);
  if (!doc) throw new CliError("contract_error", `No help for ${path}.`);
  return doc;
};

// Arguments and options are registered from the same model the help text is rendered from.
function register(parent: Command, name: string, doc: CommandDoc): Command {
  const command = parent.command(name).description(doc.summary);
  for (const arg of doc.arguments)
    command.argument(arg.required ? `<${arg.name}>` : `[${arg.name}]`, arg.description);
  for (const option of doc.options) {
    if (option.flags.startsWith("--aspect "))
      command.option(option.flags, option.description, (value: string, previous: string[]) => [...previous, value], [] as string[]);
    else if (option.required) command.requiredOption(option.flags, option.description);
    else command.option(option.flags, option.description);
  }
  command.helpInformation = () => commandHelp(doc);
  return command;
}

const groups = new Map<string, Command>();
for (const group of groupDocsList()) {
  const command = program.command(group.name).description(group.description);
  command.helpInformation = () => groupHelp(group);
  groups.set(group.name, command);
}
for (const op of operations) {
  const [groupName, actionName] = op.command.split(" ");
  register(groups.get(groupName)!, actionName, docOf(op.command)).action(async (...received: unknown[]) => {
    const cliCommand = received.at(-1) as Command;
    const options = cliCommand.opts() as Json;
    const result = await execute(op, cliCommand.args, options);
    if (op.operationId !== "getRecipe" || options.json) return emit(result);
    const detail = result as RecipeDetail;
    const { example } = options as ShowOptions;
    if (example === undefined) return void process.stdout.write(recipeSummary(detail));
    const inputs = exampleInputs(detail, example);
    process.stdout.write(JSON.stringify(inputs, null, 2) + "\n");
    const hint = exampleImageHint(detail, inputs);
    if (hint) process.stderr.write(hint + "\n");
  });
}
register(groups.get("auth")!, "status", docOf("auth status")).action(async () => {
  if (process.env.TWEENFRAME_TOKEN) return emit({ authenticated: true, source: "environment" });
  const saved = await savedIdentity();
  if (!saved?.token) return emit({ authenticated: false, auth_file: authFile });
  const expired = isExpired(saved);
  emit({ authenticated: !expired, expired, id: saved.id, expires_at: saved.expires_at, source: "file", auth_file: authFile });
});
register(program, "docs", docOf("docs")).action(async (name: string | undefined, options: { json?: boolean }) => {
  if (name !== undefined) {
    process.stdout.write(await guideText(name));
    return;
  }
  const list = await guides();
  if (options.json) emit({ guides: list, index: docs.index });
  else process.stdout.write(guideList(list));
});

const unknownCommand = (path: string[]) => new CliError("unknown_command",
  `Unknown command ${path.join(" ")}. Commands: ${[...groups.keys(), "docs", "help"].join(", ")}.`);
register(program, "help", docOf("help")).action((path: string[], options: { json?: boolean }) => {
  if (options.json) {
    const selected = operations.filter((op) => path.every((name, index) => op.command.split(" ")[index] === name));
    if (!selected.length) throw unknownCommand(path);
    const guide = path.length >= 2 ? docOf(selected[0].command).docs : path.length === 1 ? groupDocs(path[0]) : docs.skill;
    emit({
      api_url: apiUrl,
      docs: { guide, skill: docs.skill, errors: docs.errors, index: docs.index },
      operations: selected.map((op) => ({ ...op, docs: docOf(op.command).docs })),
      schemas, output_options: outputOptions,
    });
    return;
  }
  let target = program;
  for (const name of path) {
    const child = target.commands.find((item) => item.name() === name);
    if (!child) throw unknownCommand(path);
    target = child;
  }
  process.stdout.write(target.helpInformation());
});

// The command a failed parse was meant for, so a usage hint can point at its help.
function attemptedCommand(): string {
  const words = process.argv.slice(2).filter((word) => !word.startsWith("-"));
  const group = program.commands.find((item) => item.name() === words[0]);
  const action = group?.commands.find((item) => item.name() === words[1]);
  return ["tweenframe", group?.name(), action?.name()].filter(Boolean).join(" ");
}

try {
  await program.parseAsync(process.argv);
} catch (error) {
  if (error instanceof CommanderError && ["commander.helpDisplayed", "commander.version"].includes(error.code)) {
    process.exitCode = 0;
  } else if (error instanceof CommanderError && error.code === "commander.help") {
    // A bare `tweenframe` or `tweenframe <group>` prints that help like `--help` does.
    process.stdout.write(commanderOutput);
    process.exitCode = 0;
  } else {
    let fault: CliError;
    if (error instanceof CliError) fault = error;
    else if (error instanceof CommanderError) {
      const message = error.message.replace(/^error: /, "");
      const command = attemptedCommand();
      fault = error.code === "commander.unknownCommand"
        ? new CliError("unknown_command", message, undefined, `Run \`${command} --help\` to list the commands.`)
        : new CliError("usage", message, undefined, `Run \`${command} --help\` for arguments, options and allowed values.`);
    } else fault = new CliError("cli_error", error instanceof Error ? error.message : String(error));
    if (fault.body.hint?.includes("`<command> --help`") && fault.body.docs?.startsWith(docs.errors))
      fault.body.hint = fault.body.hint.replace("`<command> --help`", `\`${attemptedCommand()} --help\``);
    process.stderr.write(JSON.stringify({ error: fault.body }) + "\n");
    process.exitCode = 1;
  }
}
