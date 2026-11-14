# Pocket Forge

A GitHub-compatible git forge in a single Node process: git smart HTTP
(protocol v0 and v2, upload-pack and receive-pack), the REST API v3, GraphQL,
and an MCP server — all backed by one in-memory store, no dependencies,
standard library only.

## Run

```sh
MAKEFUN_SHOP_TOKEN=<token> node main.ts
```

`main.ts` is the entrypoint the make.fun harness drives: it binds an
ephemeral port, registers it with `$MAKEFUN_ENV_URL`, and exits when the env
says the trial is done.

## Layout

- `main.ts` — entrypoint lifecycle (bind, register, poll `/done`, exit).
- `app.ts` — HTTP router: `/healthz`, `/api/v3/*`, `/api/graphql`, `/mcp`,
  `/{owner}/{repo}.git/{info/refs,git-upload-pack,git-receive-pack}`.
- `store.ts` — the in-memory data model: repos, git objects and refs, issues,
  labels, pull requests, contents commits, squash merges.
- `gitutil.ts` — git object model: blobs, trees, commits, tags, pack read/write,
  reachability, merge-base.
- `gitproto.ts` — pkt-lines, v0/v2 advertisements, ls-refs, fetch, receive-pack.
- `rest.ts` — GitHub REST API v3 handlers.
- `graphql.ts` — a small GraphQL parser and executor (queries, mutations,
  variables, fragments, `__type` introspection, batch).
- `mcp.ts` — MCP JSON-RPC 2.0: `server/discover`, `initialize`, `tools/list`,
  `tools/call` (`create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request`).

## Notes

- Deterministic: no wall clock, no `Math.random()`. Timestamps come from
  `MAKEFUN_TRIAL_NOW` plus a monotonic counter.
- Auth: every API and git call needs `Authorization: Bearer <MAKEFUN_SHOP_TOKEN>`.
  A repo under another owner answers 404, never 403.
- All state is in memory; restarting the process starts from a clean slate.
