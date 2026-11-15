# github-core-clone-01 — a GitHub-compatible git forge in one Node process

A standalone forge that speaks GitHub's wire protocols from a single in-memory
store: git smart HTTP, REST v3, GraphQL v4 and MCP. No dependencies, no git
binary, no network at run time — just `node:http` and the standard library.

## Run it

```sh
node main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18+ (type stripping on by
default there); the flag `--experimental-strip-types` makes an older local
Node work too. There is nothing to install.

`main.ts` is the entry <-> env lifecycle: bind an ephemeral port, `POST
$MAKEFUN_ENV_URL/register {"port": N}`, poll `GET $MAKEFUN_ENV_URL/done`
until `{"done": true}`, exit 0. `MAKEFUN_ENV_URL` unset means exit 1.

## The surface

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}` — the env's boot probe, no token |
| `GET /api/v3/` | 200, `X-Oauth-Scopes: repo, read:org` |
| `/api/v3/...` | REST v3: repos, branches, commits, git refs, contents, labels, issues, comments, pulls, files, squash merges |
| `POST /api/graphql` | GraphQL v4: viewer, repository, issues, pull requests, node, mutations, introspection, batched operations |
| `POST /mcp` | MCP over streamable HTTP: `server/discover`, `initialize`, `tools/list`, `tools/call` (create/get repo, create/list issues, create/merge pull requests) |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs` (v0 + v2), `git-upload-pack` (v2 ls-refs/fetch, v0 fetch), `git-receive-pack` (push with report-status) |
| anything else | 404 `{"message":"Not Found"}` |

Every API call carries `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`; a missing
or wrong token is refused with 401 (except `/healthz` and the API root).

## How it is built

One `Store` holds every object — git objects, refs, issues, pulls, labels —
so REST, GraphQL and MCP always read the same state. The files:

- `scenario.ts` — the scenario's deterministic generators (FNV-1a, splitmix64, xorshift64*), reproducing the env's viewer `adaiversen` exactly.
- `gitobj.ts` — SHA-1 object ids, pkt-lines, v2 pack write/read (plain objects, no deltas), tree/commit/tag build and parse.
- `store.ts` — the store: refs, commit walking, merge bases, tree diffs, squash merges, opaque global ids.
- `git.ts` — smart HTTP. Fetches deliver the depth-limited commit set with each commit's own tree closure, minus the haves' closure cut at shallow boundaries — so a depth-1 clone sends the tip only, and a deepen-2 fetch sends exactly one more generation.
- `rest.ts` — the REST v3 router, with pagination `Link` headers and `X-GitHub-Request-Id` on every reply.
- `graphql.ts` — a small GraphQL parser and executor (operations, variables, aliases, inline fragments, `__type`).
- `mcp.ts` — JSON-RPC 2.0 over streamable HTTP, with the six tools the suite calls.
- `app.ts` — the router: reads each request body once, dispatches to the four surfaces, and never lets one bad request take the server down.

## Local grading

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process --worktree
```

Practice trial-0 (2026-11-15, this machine): **922/1000** — feature 600/600
(120/120 checks), agent 200/200, perf 122/200, replay matched byte for byte,
L1 regrade reproduced byte for byte.

## Rules and limits

Node 22 only, no dependencies at run time, no internet and no `git` binary in
the trial; the repository is mounted read-only at `/bot`, writable only under
`/tmp`. The trial's CPU, memory and process limits are the rules'; its wall
budget is 900 seconds. Contest: <https://make.fun/bounty/github-core-clone-01>.
MIT licensed.
