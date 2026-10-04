# tweenframe-cli

TypeScript CLI for the TweenFrame public recipe API. Agents discover a recipe, read its input schema,
upload assets, render and download the result. Commands, parameters and `help --json` are generated from
the OpenAPI snapshot in `openapi/tweenframe.json`.

## Layout

- `src/` — runtime (hand-written): `cli.ts` commands, `api.ts` HTTP/auth, `inputs.ts` JSON and `file://`
  handling, `renders.ts` render/poll/download, `errors.ts` error envelope with `hint`/`docs`, `help.ts` help text
  rendered from the contract, `guides.ts` the `docs` command, `config.ts` API and guide URLs.
- `tests/snapshots/` — expected help texts; `UPDATE_SNAPSHOTS=1 npm test` rewrites them after an intended change.
- `src/generated/` — generated from the OpenAPI snapshot by `scripts/generate.mjs`; committed, never edited
  by hand. `npm run typecheck` fails if it is stale.
- `openapi/tweenframe.json` — contract snapshot, refreshed with `npm run sync:openapi` from a running
  TweenFrame server (`TWEENFRAME_OPENAPI_URL`).
- `tests/` — offline tests against a mock HTTP server (`node --test`).
- `evals/` and `.claude/` — local agent evaluation harness and its agent definitions, ignored by git.
- `docs/plans/` — local specs and decision records, ignored by git.

## Commands

`npm run build`, `npm run typecheck`, `npm test`, `npm run sync:openapi`. Tests are offline. End-to-end runs need a
TweenFrame API: set `TWEENFRAME_API_URL` and, for isolated runs, `TWEENFRAME_AUTH_FILE`.

## Conventions

- Everything in this repository is in English: docs, comments, task texts, agent definitions. It is going
  to be public.
- Comments explain a non-obvious why, never what; no references to specs or tickets in code.
- The CLI knows nothing about individual recipes: recipe contracts come from the API; the catalog lives in
  the TweenFrame site repository.
- Do not commit or publish unless asked. `"private": true` stays until publishing is decided.
