# Pocket Forge

A GitHub-compatible git forge in a single Node.js process, standard library
only. It speaks git smart HTTP (v0 + v2, fetch and push), the GitHub REST
API v3, a small GraphQL executor, and MCP (JSON-RPC 2.0) — all over one
in-memory store.

## Run

```sh
node --experimental-strip-types main.ts
```

Environment:

- `MAKEFUN_SHOP_TOKEN` — bearer token the server validates (empty = no auth,
  for local testing).
- `MAKEFUN_ENV_URL` — trial control plane (`/register`, `/done`). When unset,
  the server just serves forever.
- `PORT` — listen port (0 = ephemeral).

## Layout

- `main.ts` — entrypoint: bind, register to the trial env, poll done.
- `app.ts` — HTTP server, routing, bearer auth, body parsing.
- `store.ts` — in-memory state: repositories, git objects, issues, PRs.
- `gitutil.ts` — git object model, packfile read/write, reachability.
- `gitproto.ts` — git smart HTTP: pkt-lines, advertisement, ls-refs, fetch,
  receive-pack.
- `rest.ts` — GitHub REST API v3 handlers.
- `graphql.ts` — small GraphQL parser + executor.
- `mcp.ts` — MCP JSON-RPC 2.0 endpoint with six tools.

## Notes

- State is in-memory and deterministic: commit timestamps come from a
  counter, not the wall clock, so identical request sequences produce
  identical object ids.
- No dependencies. Node >= 22.6 (type stripping).
