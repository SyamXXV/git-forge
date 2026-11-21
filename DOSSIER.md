# DOSSIER — forge (github-core-clone-01)

## What was built

A GitHub-compatible git forge in a single Node 22 process, standard
library only (`node:http`, `node:crypto`, `node:zlib`, `node:fs` nowhere
in the request path). One in-memory `Store` backs four surfaces — git
smart HTTP, REST v3, GraphQL v4 and MCP — so a repository created over
MCP is the same object REST reads, and a branch pushed over git is the
same branch a pull request merges.

### Store (`src/store.ts`)

- Repos in a `Map` (numeric ids from 5000, `node_id` `R_<id>`), each with
  `refs: Map<string, sha>`, `objects: Map<sha, {type, content}>`,
  issues, pulls, labels, comments.
- Git objects are SHA-1 addressed exactly as git computes them
  (`<type> <len>\0` + bytes). Trees are built recursively from a flat
  path map and serialised in git's sort order (directories compare as
  `name/`); commits carry author/committer `adaiversen <...>` with epoch
  timestamps and `+0000`.
- `diffCommits` walks merge-base → tip and counts added/deleted lines
  per path with a multiset diff; `squashMerge` detects a conflict when
  both sides changed the same path to different bytes, and otherwise
  builds the merged tree (base tip + head changes) with the base tip as
  the single parent.
- Global ids are opaque base64 (`Repository:<id>`,
  `Issue:<repoId>:<number>`, `PullRequest:<repoId>:<number>`), never a
  bare number.
- Scenario identity (`src/scenario.ts`) derives the viewer
  (`adaiversen`, id 1000) and the stranger (`olgabauer`, id 1002) from
  the fixed seed `0x6a09e667f3bcc909n` with FNV-1a + splitmix64 +
  xorshift64*, verified against the kit's `wire.ts` derivation.

### Git protocol (`src/gitproto.ts`, `src/githttp.ts`)

- pkt-line codec (flush 0000, delim 0001, response-end 0002), sideband
  framing (band 1 data, 32768-byte chunks), PACK v2 builder (full
  entries, no deltas; trailer SHA-1) and parser (OFS_DELTA + REF_DELTA,
  recursive resolution with memoisation, `inflateSync` for zlib).
- `planFetch` computes the wanted closure minus the held closure, where
  "held" never crosses a shallow boundary; shallow/unshallow lines come
  from the depth boundary and from previously shallow commits whose
  parents are now included.
- v2 fetch over stateless HTTP answers with the sections the client
  asked for and nothing else: an optional `shallow-info` section, then
  `packfile`, then a flush. **No capability advertisement and no
  `acknowledgments` section** — verified against real `git upload-pack`
  and `git http-backend`: when the client sends `done` in the same
  request, the server goes straight to the packfile.
- v0 fetch answers NAK/ACK lines, shallow lines, then the sideband pack.
- receive-pack parses the command list + raw pack, stores objects,
  applies each ref update fast-forward only (create/delete allowed,
  non-fast-forward refused per ref with `ng <ref> non-fast-forward`),
  and answers report-status as pkt-lined lines **inside** sideband band
  1, the inner stream terminated by a flush before the outer flush.
- The v0 advertisement ends with a flush after the ref lines (a missing
  one makes real git hang up on initial contact).

### REST v3 (`src/rest.ts`)

Every reply is `application/json` with `X-GitHub-Request-Id`; errors are
`{message}` JSON; unknown routes are 404 JSON; malformed JSON bodies are
400. Bearer auth from `MAKEFUN_SHOP_TOKEN` (an empty env token accepts
any non-empty bearer, for local testing). A foreign owner answers 404.
Covers: API root (+ `X-OAuth-Scopes`), meta, user, user/repos (create
201 / duplicate 422; list with `Link: rel="next"` absolute URLs),
repos get/patch/delete (204), branches, git/refs, commits (`?sha=`),
contents PUT (201 create / 200 update / 409 stale sha; creating a
missing branch forks it from the default tip; an unborn repo accepts its
first PUT) and DELETE (200 `{commit:{sha}}`), labels, issues (422 on an
unknown label; state/sort/direction + pagination), comments, pulls
(422 on a duplicate open head+base; files from merge-base → head tip;
merge squash 200 / 404 / 405 on conflict).

### GraphQL (`src/graphql.ts`)

A hand-written tokenizer + recursive-descent parser (operations,
variables with defaults, aliases, arguments, inline and named
fragments, directives parsed and ignored) and a typed executor. The
schema table drives both introspection (`__type` fields/enumValues for
Issue/PullRequest/Repository/SearchType) and unknown-field validation
(`Cannot query field "X" on type "Y".`). Connections page by cursor
(`cursor:<number>` base64); pagination slices by position in the
connection's own order, which is what makes DESC ordering page
correctly. Mutations create/close issues, create/merge pull requests
and add comments on the shared store. Batched bodies answer in order.
Two parser bugs found by the suite and fixed: variable definitions
separated by whitespace (the type loop must stop at the next `$`) and
cursor pagination in DESC order.

### MCP (`src/mcp.ts`)

`server/discover` (supportedVersions 2026-07-28 + the four legacy
revisions, `capabilities: {tools: {}}`, `serverInfo`), `initialize`
(echoes the negotiated legacy revision), `notifications/initialized`
(202, no body), `tools/list` (a module-level constant array, so two
calls are byte-identical), `tools/call` (the six github-mcp-server
tools; unknown tool -32602, missing required argument `isError: true`,
tool failures `isError: true` with a message). Malformed JSON is HTTP
400 with -32700; no Authorization is HTTP 401 before any method runs.
String ids are echoed verbatim, so two concurrent calls keep their own
ids and results.

### Lifecycle (`main.ts`, `src/app.ts`)

`main.ts` keeps the starter's lifecycle exactly (bind 0, register, poll
`/done`, exit 0) and adds the token wiring (`MAKEFUN_SHOP_TOKEN` →
`createApp(token)`). `app.ts` routes `/healthz`, `/api/graphql`,
`/mcp`, `/api/v3/*`, then the git routes, then a JSON 404.

## Verification

### Conformance suite (kit `sdk/run.ts`, local, Node 24.22.1)

```
checks: 120 registered of the manifest's 120; 120 passed, 0 failed
feature 600 (round(600 * 120 / 120))
agent   200 (round(200 * 15 / 15), the mcp group)
perf    174 (the four benchmark workloads)
score   974 of 1000; working 1

benchmark push:  p50 674.233 ms, p99 729.788 ms -> 41 point(s)
benchmark clone: p50 97.166 ms, p99 105.023 ms -> 43 point(s)
benchmark read:  p50 640.691 ms, p99 720.283 ms -> 50 point(s)
benchmark write: p50 155.748 ms, p99 247.160 ms -> 40 point(s)
```

All 30 git checks, all REST checks, all 20 GraphQL checks and all 15
MCP checks pass. The suite was run twice more during debugging (106/120
then 119/120) before reaching 120/120; the two GraphQL bugs above were
the only failures after the git fixes.

### Real `git` CLI (2.43.0) against the running forge

- `git clone` (protocol v2 and v0), `--depth 1` shallow clone (1 commit).
- `git push` a new commit, a new branch, a mixed push (one ok + one
  non-fast-forward: only the ok ref advances), a ref delete, and a
  non-fast-forward push (rejected, ref unmoved).
- `git ls-remote`, `git fetch` (incremental, nothing-new, deepen).
- Cross-checked byte-for-byte against `git http-backend` as the
  reference server for the v2 fetch response shape and the receive-pack
  report framing (both were wrong on first attempt and fixed from the
  reference trace).

### REST / GraphQL / MCP smoke tests (curl)

- REST: create repo → PUT contents → GET contents round-trips bytes;
  unauthenticated user → 401; API root → 200 + `X-OAuth-Scopes`.
- GraphQL: `viewer`, repository + issues connection, unknown field →
  HTTP 200 + `errors` naming the field, unknown repository → null with
  no errors, no auth → 401.
- MCP: discover/initialize, tools/list byte-identical across two calls,
  create_repo/get_repo round-trip, unknown tool → -32602, no auth →
  401, malformed JSON → 400 + -32700.

## What was NOT built / known limits

- Packfiles carry no deltas (full objects only). The suite's repos are
  small, so this is faster than delta search and always valid; a very
  large repo would transfer more bytes than a delta pack.
- No `filter` support in fetch (the `filter` capability is therefore
  not advertised); no `want-ref` / `wanted-refs` section; no
  `report-status-v2` (only `report-status` is advertised, per the
  rules); no `object-info` / `server-option` capabilities.
- No persistence: the store is in-memory, one trial = one process, as
  the rules allow.
- No `deepen-since` / `deepen-not` handling beyond ignoring the args
  (the fetch plan only honours `deepen <n>` and `shallow` boundaries).
- Perf is 174/200; the four workloads are all comfortably faster than
  the reference times, with `read` at the 50-point cap.
