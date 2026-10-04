# TweenFrame CLI

Agent-facing command-line client for the TweenFrame public recipe API. An agent discovers a recipe, reads its input schema and examples, uploads local images, renders, and downloads the result without knowing anything about the recipe internals.

Commands, parameters, types and machine-readable help are generated from the OpenAPI snapshot in [openapi/tweenframe.json](openapi/tweenframe.json). A small runtime handles anonymous identity, JSON input, `file://` uploads, polling and downloads. The package is not published yet (`"private": true`).

## Usage

```sh
tweenframe auth init
tweenframe recipes list
tweenframe recipes show real-estate/banner-7          # or real-estate/banner-7@1
tweenframe assets upload photo.jpg
tweenframe assets analyze photo.jpg --aspect 4:5 --aspect 3:2
tweenframe recipes render real-estate/banner-7 --input input.json --wait --output result.gif
tweenframe recipes render --help                      # every option with its range and default
tweenframe docs recipes                               # read a guide in the terminal
```

`recipes show` returns `input_schema`, `asset_paths`, the default `output` and named `examples`, each a complete inputs object. Start from an example and change what you need. A `file://` URL at an advertised asset path (for example `photos.*.src`) is uploaded automatically, once per distinct file; a direct API call uses the URL returned by `POST /assets`. Output options (`--format`, `--width`, `--fps`, `--quality`, `--scale`, `--loop`) are separate from recipe inputs; `--fps 0` keeps the authored frame rate. Pin a version with `<id>@<version>`.

`assets analyze <source>` returns `{"data": {"asset"?, "analysis"}}`: the image size, a focal point (`analysis.focal`, normalized 0..1; use `[x, y]` as a recipe `focus` value), a subject box and a suggested cover crop per `--aspect` (`analysis.crops["4:5"]`). A local path or `file://` URL is uploaded first and its upload result returned as `asset`; an asset URL is analyzed as is. Aspects are checked locally.

`--input` accepts inline JSON, a JSON file, or `-` for stdin. Inputs, `file://` paths and output options are checked before any request. Results go to stdout as `{"data": ...}`; errors go to stderr as `{"error": {"code", "message", "details"?, "hint", "docs"}}` with exit code 1. API errors are passed through unchanged, except that an origin-relative `docs` link is made absolute. A failed render exits 1 with the render error and its `uid`; a failed download keeps `uid`, `status` and `result_url` in `details`. `renders wait --input <render json>` resumes polling a pending render.

`auth init` stores the anonymous token (valid one year) in `~/.config/tweenframe-cli/auth.json` with mode `0600`. An expired token fails with `auth_required` before any request; `auth status` shows it. `TWEENFRAME_TOKEN` supplies a token directly; `TWEENFRAME_AUTH_FILE` changes the storage path. `TWEENFRAME_API_URL` sets the API base, default `https://tweenframe.com/api/public/v1`.

The agent guide is served at `/docs/agent/SKILL.md`, the contract at `/api/public/v1/openapi.json`.

## Help and guides

Help is the documentation an agent reads first, so it is complete rather than a stub: one call should be enough to run a command correctly. `tweenframe help`, `tweenframe <group>` and `tweenframe <group> <command> --help` are rendered from the OpenAPI contract and work offline.

- **Top level** names the tool in two lines, lists every group and command with its arguments and purpose, the output and error shapes, the environment variables and the guide links.
- **A group** (`tweenframe recipes`) lists its commands with one-line purposes and links the group's guide.
- **A command** gives what it does (the operation `description`, plus what the CLI adds, such as uploading `file://` values), every argument and option with its type, allowed values, range and default taken from the schema (`--width <16..3000>`, `--quality <maximum|normal|minimal>`, `--fps <0..30>` "0 keeps the recipe's authored frame rate"), examples from `x-cli.examples`, and a `Docs:` line from `x-cli.docs` or the group tag's `externalDocs`.
- `help --json [group [action]]` prints the generated operation metadata, schemas and output options plus a `docs` object (`guide`, `skill`, `errors`, `index`).

Wording comes from the API, not from this repository: improving a description in the OpenAPI document and regenerating improves the help. Only commands the CLI implements itself (`auth status`, `docs`, `help`) and the flags its runtime adds (`--input`, `--wait`, `--output`, `--aspect`) carry hand-written help. Help snapshots in `tests/snapshots/` make every change visible; `UPDATE_SNAPSHOTS=1 npm test` rewrites them.

`tweenframe docs` lists the agent guides served by the TweenFrame site (name, one line, URL); `tweenframe docs <name>` prints that guide's Markdown verbatim, for example `tweenframe docs recipes` or `tweenframe docs errors`. The list comes from the guide index on the site the API runs on (the origin of `TWEENFRAME_API_URL`), so new guides appear without a CLI release. Without network access it fails with `network_error` and the URL it tried.

Every error, local or from the API, has a `hint` (one sentence on what to do next) and a `docs` link to its section in the errors guide (`errors.md#<code>`). Local validation names the allowed range or values, for example `--width must be an integer from 16 to 3000; got "5"`.

## Development

Requires Node.js 22.12+. The tests run offline against a mock HTTP server. End-to-end runs need a TweenFrame API; point `TWEENFRAME_API_URL` at it.

```sh
npm ci
npm run build
export TWEENFRAME_API_URL=http://localhost:3005/api/public/v1
node dist/cli.js recipes list
```

After an API change, sync the snapshot, regenerate and test. The generator fails on unknown `x-cli.mode` values and unsupported schema constructs.

```sh
TWEENFRAME_OPENAPI_URL=http://localhost:3005/api/public/v1/openapi.json npm run sync:openapi
npm run typecheck
npm test
npm pack --pack-destination /tmp
npm install --prefix /tmp/tweenframe-cli-local /tmp/tweenframe-cli-0.1.0.tgz
/tmp/tweenframe-cli-local/node_modules/.bin/tweenframe help
```

Source layout: `src/cli.ts` registers commands, `src/api.ts` handles HTTP and auth, `src/inputs.ts` handles input JSON and `file://` values, `src/renders.ts` renders, polls and downloads, `src/help.ts` and `src/guides.ts` render help and fetch guides. `src/generated/` is produced by `scripts/generate.mjs`; do not edit it.
