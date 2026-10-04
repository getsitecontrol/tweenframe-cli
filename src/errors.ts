import type { ErrorBody } from "./generated/types.js";
import { docsUrl, errorDocs } from "./config.js";

export type Json = Record<string, unknown>;
export type ErrorEnvelope = ErrorBody & { hint?: string; docs?: string };

// What to do next for each error the CLI raises itself; API errors bring their own.
const hints: Record<string, string> = {
  usage: "Run the command with --help to see its arguments, options and examples.",
  unknown_command: "Run `tweenframe help` to list the commands.",
  invalid_value: "Use a value from the range or list in the message; `<command> --help` shows every option.",
  invalid_json: "Pass a JSON object inline, as a file path or as - for stdin; start from an example in `tweenframe recipes show <id>`.",
  input_read_failed: "Check that the --input file exists and is readable, or pass the JSON inline.",
  invalid_input: "Compare the input with the recipe's input_schema and asset_paths from `tweenframe recipes show <id>`.",
  file_not_found: "Check the path; relative paths resolve against the current directory.",
  auth_required: "Run `tweenframe auth init`, or set TWEENFRAME_TOKEN.",
  network_error: "Check the network and TWEENFRAME_API_URL, then retry.",
  invalid_response: "Retry once; if it repeats, the CLI and API versions may differ, so report the details.",
  api_error: "The API answered without a standard error; retry later and report the details if it repeats.",
  contract_error: "This CLI build does not match the API contract; update the CLI.",
  poll_url_missing: "Pass the complete pending render JSON printed by `recipes render` to `tweenframe renders wait --input`.",
  render_timeout: "The render may still finish; resume with `tweenframe renders wait --input <render json>` using details.render.",
  render_failed: "Check the inputs against `tweenframe recipes show <id>`, retry once, then report the uid.",
  download_failed: "The render completed; download details.result_url again or rerun `tweenframe renders wait` with --output.",
  write_failed: "Check that the --output location is a writable file path with free space.",
  docs_not_found: "Run `tweenframe docs` to list the guide names.",
  docs_unavailable: "Retry later, or open details.url directly.",
  cli_error: "Unexpected CLI failure; report the message and the command line.",
};

// Every failure leaves the CLI as one `{error: ErrorEnvelope}` line on stderr.
export class CliError extends Error {
  readonly body: ErrorEnvelope;

  constructor(code: string, message: string, details?: Json, hint?: string) {
    super(message);
    this.body = {
      code, message, ...(details === undefined ? {} : { details }),
      hint: hint ?? hints[code] ?? hints.cli_error, docs: errorDocs(code),
    } as ErrorEnvelope;
  }

  // API errors pass through as sent, except that an origin-relative docs link is made openable.
  static from(body: ErrorEnvelope): CliError {
    const error = new CliError(body.code, body.message);
    (error as { body: ErrorEnvelope }).body = typeof body.docs === "string" && body.docs.startsWith("/")
      ? { ...body, docs: docsUrl(body.docs) } : body;
    return error;
  }

  withDetails(extra: Json): CliError {
    return CliError.from({ ...this.body, details: { ...this.body.details, ...extra } });
  }
}
