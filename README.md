# forge — a GitHub-compatible git forge in one Node process

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/SyamXXV/git-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/SyamXXV/git-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone git forge that speaks the surfaces GitHub clients use, built
only on the Node 22 standard library: no dependencies, no `git` binary in
the shipped code, no network access from the program itself.

## What it serves

- **Git smart HTTP** (`/{owner}/{repo}[.git]/...`)
  - `info/refs` for `git-upload-pack` (protocol v2 advertisement) and
    `git-receive-pack` (v0 advertisement with `report-status`,
    `side-band-64k`, `delete-refs`).
  - `git-upload-pack`: protocol v2 (`ls-refs` with peel/symrefs/unborn/
    ref-prefix, `fetch` with want/have/shallow/deepen) and protocol v0.
    Packfiles carry full objects (no deltas) — fast enough for the suite's
    repo sizes and always valid.
  - `git-receive-pack` (v0): parses PACK v2 with OFS_DELTA and REF_DELTA,
    stores objects, updates refs fast-forward only, and answers a
    report-status stream that is itself pkt-lined inside sideband band 1.
- **REST v3** (`/api/v3/...`): API root, meta, the authenticated user,
  repositories (create/list with `Link` pagination, get/patch/delete),
  branches, git refs, commits, contents (create/update/delete with sha
  checks), labels, issues (with comments), and pull requests (create/list/
  files/merge with squash and conflict detection). Every reply is JSON
  with a non-empty `X-GitHub-Request-Id`; errors are `{message}` JSON.
- **GraphQL** (`POST /api/graphql`): `viewer`, `repository`, `node`,
  `__type`/`__schema` introspection, issues and pull-request connections
  with cursor pagination and `orderBy: CREATED_AT`, and the mutations
  `createIssue`, `closeIssue`, `createPullRequest`, `mergePullRequest`,
  `addComment`. Unknown fields answer HTTP 200 with an `errors` array;
  an unknown repository answers `data.repository: null` with no errors.
- **MCP** (`POST /mcp`): JSON-RPC 2.0 Streamable HTTP. `server/discover`
  negotiates the `2026-07-28` revision, `initialize` answers the legacy
  revisions, and `tools/list` returns six tools (`create_repo`,
  `get_repo`, `create_issue`, `list_issues`, `create_pull_request`,
  `merge_pull_request`) that read and write the same store as REST.

All four surfaces share one in-memory store: repositories, git objects
(SHA-1 addressed), refs, issues, pull requests, labels and users. A
bearer token from `MAKEFUN_SHOP_TOKEN` guards everything except the
public API root/meta; without it, protected routes answer 401. A
repository owned by another login answers 404, never 403.

## Running it

```sh
node --experimental-strip-types main.ts
```

`main.ts` is the entry <-> env lifecycle: it binds an ephemeral port,
POSTs `{"port": N}` to `$MAKEFUN_ENV_URL/register`, then polls
`$MAKEFUN_ENV_URL/done` until the env says the trial is over and exits 0.
It never binds 8080. `MAKEFUN_SHOP_TOKEN` supplies the bearer token the
suite presents.

For a local smoke test without the env, point `MAKEFUN_ENV_URL` at any
server that answers `/register` and `/done` (a stub that always answers
`{"done": false}` keeps the forge up), then drive it with `git`, `curl`,
or the kit's conformance runner:

```sh
node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:PORT --token TOK [--perf]
```

## Layout

```
main.ts            entry <-> env lifecycle (bind, register, poll, exit)
src/app.ts         the HTTP application: one Store, one router
src/http.ts        JSON/bytes replies, body reading, path + token helpers
src/store.ts       the in-memory store: repos, git objects, refs, issues, PRs
src/gitproto.ts    pkt-line codec, sideband framing, pack build/parse, fetch plan
src/githttp.ts     git smart HTTP: info/refs, upload-pack, receive-pack
src/rest.ts        REST v3 handlers
src/graphql.ts     GraphQL tokenizer, parser, executor, HTTP handler
src/mcp.ts         MCP endpoint and the six tools
src/scenario.ts    the deterministic scenario identity (viewer/stranger)
```

## Verification

See `DOSSIER.md` for the architecture notes and the full verification
record. Headline: the kit's conformance suite passes **120/120** checks
(feature 600/600, agent 200/200, perf 174/200 — total **974/1000**),
including clone/push/fetch/shallow/deepen against the real `git` CLI.
