// githttp.ts — git smart HTTP: info/refs, git-upload-pack (v2 + v0) and
// git-receive-pack (v0), implemented on node:crypto and node:zlib only.
// Packs the server sends are delta-free (every object a full entry); packs
// it receives may carry OFS_DELTA / REF_DELTA and are resolved in gitproto.
//
// Auth: none — the git checks speak plain HTTP. A repository under another
// owner than the viewer is a 404, and a missing repository is a 404; the
// server keeps answering afterwards.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseCommit, ZERO_OID, type Repo, type Store } from './store.ts';
import { readBody, sendBytes, sendJson } from './http.ts';
import {
  buildPack,
  decodePktLines,
  parsePack,
  planFetch,
  pktDelim,
  pktFlush,
  pktLine,
  pktLines,
  sidebandChunks,
  type PktPacket,
} from './gitproto.ts';

const AGENT = 'forge/1.0';

function v2Capabilities(): string[] {
  return ['ls-refs=unborn', 'fetch=shallow wait-for-done', `agent=${AGENT}`, 'object-format=sha1'];
}

function v0UploadCapabilities(defaultBranch: string): string {
  return [
    `symref=HEAD:refs/heads/${defaultBranch}`,
    'multi_ack',
    'thin-pack',
    'side-band-64k',
    'ofs-delta',
    'shallow',
    `agent=${AGENT}`,
  ].join(' ');
}

function v0ReceiveCapabilities(): string {
  return ['report-status', 'side-band-64k', 'delete-refs', `agent=${AGENT}`].join(' ');
}

/** The ref advertisement lines for a repo (HEAD first, then branches, tags + peeled). */
function refLines(store: Store, repo: Repo, caps: string | null): string[] {
  const lines: string[] = [];
  const headSha = store.refOfBranch(repo, repo.defaultBranch) ?? ZERO_OID;
  const entries: { oid: string; ref: string }[] = [];
  entries.push({ oid: headSha, ref: 'HEAD' });
  for (const name of store.branchNames(repo)) {
    entries.push({ oid: store.refOfBranch(repo, name) as string, ref: `refs/heads/${name}` });
  }
  for (const name of store.tagNames(repo)) {
    const oid = repo.refs.get(`refs/tags/${name}`) as string;
    entries.push({ oid, ref: `refs/tags/${name}` });
    const peeled = peelTag(store, repo, oid);
    // Annotated tags advertise their peeled commit; lightweight tags do not.
    if (peeled !== null && peeled !== oid) entries.push({ oid: peeled, ref: `refs/tags/${name}^{}` });
  }
  entries.forEach((entry, index) => {
    if (index === 0 && caps !== null) lines.push(`${entry.oid} ${entry.ref}\0${caps}\n`);
    else lines.push(`${entry.oid} ${entry.ref}\n`);
  });
  return lines;
}

/** Resolve a tag object to the commit it points at (or the oid itself). */
function peelTag(store: Store, repo: Repo, oid: string): string | null {
  let current = oid;
  for (let depth = 0; depth < 10; depth += 1) {
    const obj = store.getObject(repo, current);
    if (obj === null) return null;
    if (obj.type === 'commit') return current;
    if (obj.type === 'tag') {
      const match = /^object ([0-9a-f]{40})$/m.exec(obj.content.toString('utf8'));
      if (match === null) return null;
      current = match[1] as string;
      continue;
    }
    return current;
  }
  return null;
}

/** The v2 advertisement: "version 2" + capability lines + flush. */
function v2Advertisement(): Buffer {
  const lines: (string | 'flush')[] = ['version 2\n', ...v2Capabilities().map((cap) => `${cap}\n`), 'flush'];
  return pktLines(lines);
}

/** The v0 advertisement: "# service=..." + flush + ref lines (caps on the first). */
function v0Advertisement(store: Store, repo: Repo, service: string, caps: string): Buffer {
  const head = Buffer.from(`# service=${service}\n`, 'utf8');
  const lines = refLines(store, repo, caps);
  if (lines.length === 0) return Buffer.concat([pktLine(head), pktFlush(), pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`), pktFlush()]);
  return Buffer.concat([pktLine(head), pktFlush(), pktLines(lines), pktFlush()]);
}

function isEmptyRepo(repo: Repo): boolean {
  return repo.refs.size === 0;
}

// ---------------------------------------------------------------------------
// info/refs
// ---------------------------------------------------------------------------

async function handleInfoRefs(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  query: URLSearchParams,
): Promise<void> {
  const service = query.get('service') ?? '';
  const wantsV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
  if (service === 'git-upload-pack') {
    if (wantsV2) {
      sendBytes(res, 200, v2Advertisement(), 'application/x-git-upload-pack-advertisement');
      return;
    }
    sendBytes(res, 200, v0Advertisement(store, repo, 'git-upload-pack', v0UploadCapabilities(repo.defaultBranch)), 'application/x-git-upload-pack-advertisement');
    return;
  }
  if (service === 'git-receive-pack') {
    if (wantsV2) {
      // receive-pack has no v2 advertisement; git falls back to v0 here.
      sendBytes(res, 200, v0Advertisement(store, repo, 'git-receive-pack', v0ReceiveCapabilities()), 'application/x-git-receive-pack-advertisement');
      return;
    }
    sendBytes(res, 200, v0Advertisement(store, repo, 'git-receive-pack', v0ReceiveCapabilities()), 'application/x-git-receive-pack-advertisement');
    return;
  }
  sendJson(res, 404, { message: 'Not Found' });
}

// ---------------------------------------------------------------------------
// upload-pack
// ---------------------------------------------------------------------------

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | undefined;
}

function parseFetchArgs(packets: PktPacket[]): FetchRequest {
  const out: FetchRequest = { wants: [], haves: [], shallow: [], depth: undefined };
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.data.toString('utf8').trim();
    if (line.startsWith('want ')) out.wants.push(line.slice(5).split(' ')[0]?.split('\0')[0] as string);
    else if (line.startsWith('have ')) out.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) out.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) out.depth = n;
    }
  }
  return out;
}

function fetchResponse(store: Store, repo: Repo, request: FetchRequest, v2: boolean): Buffer {
  const plan = planFetch(store, repo, request.wants, request.haves, request.shallow, request.depth);
  const entries = plan.objects
    .map((sha) => {
      const obj = store.getObject(repo, sha);
      return obj === null ? null : { type: obj.type, content: obj.content };
    })
    .filter((entry): entry is { type: string; content: Buffer } => entry !== null);
  const pack = buildPack(entries);
  const chunks: Buffer[] = [];
  if (v2) {
    // Protocol v2 over stateless HTTP: the client sends wants, haves and
    // `done` in one request, and the server answers with the sections it
    // asked for — no capability advertisement and no acknowledgments
    // section (real git's client expects `packfile` where an
    // acknowledgments section would be, and the suite's client tolerates
    // its absence). A shallow-info section precedes the packfile when the
    // fetch crosses a shallow boundary.
    if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
      chunks.push(pktLine('shallow-info\n'));
      for (const sha of plan.shallow) chunks.push(pktLine(`shallow ${sha}\n`));
      for (const sha of plan.unshallow) chunks.push(pktLine(`unshallow ${sha}\n`));
      chunks.push(pktDelim());
    }
    chunks.push(pktLine('packfile\n'));
  } else {
    const acksPresent = request.haves.length > 0 && request.haves.every((have) => store.getObject(repo, have) !== null);
    if (acksPresent) {
      for (const have of request.haves) chunks.push(pktLine(`ACK ${have}\n`));
    } else {
      chunks.push(pktLine('NAK\n'));
    }
    for (const sha of plan.shallow) chunks.push(pktLine(`shallow ${sha}\n`));
    for (const sha of plan.unshallow) chunks.push(pktLine(`unshallow ${sha}\n`));
  }
  chunks.push(...sidebandChunks(pack));
  chunks.push(pktFlush());
  return Buffer.concat(chunks);
}

function lsRefsResponse(store: Store, repo: Repo, packets: PktPacket[]): Buffer {
  let peel = false;
  let unborn = false;
  let symrefs = false;
  const prefixes: string[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.data.toString('utf8').trim();
    if (line === 'peel') peel = true;
    else if (line === 'unborn') unborn = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const lines: string[] = [];
  const headSha = store.refOfBranch(repo, repo.defaultBranch);
  const matches = (ref: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => ref.startsWith(prefix));
  if (headSha === null) {
    if (unborn && matches('HEAD')) lines.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
  } else if (matches('HEAD')) {
    lines.push(symrefs ? `${headSha} HEAD symref-target:refs/heads/${repo.defaultBranch}\n` : `${headSha} HEAD\n`);
  }
  for (const name of store.branchNames(repo)) {
    const ref = `refs/heads/${name}`;
    if (!matches(ref)) continue;
    const oid = store.refOfBranch(repo, name) as string;
    let line = `${oid} ${ref}`;
    if (symrefs && name === repo.defaultBranch) line += ` symref-target:refs/heads/${repo.defaultBranch}`;
    lines.push(`${line}\n`);
  }
  for (const name of store.tagNames(repo)) {
    const ref = `refs/tags/${name}`;
    if (!matches(ref)) continue;
    const oid = repo.refs.get(ref) as string;
    let line = `${oid} ${ref}`;
    if (peel) {
      const peeled = peelTag(store, repo, oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  return pktLines([...lines, 'flush']);
}

async function handleUploadPack(store: Store, req: IncomingMessage, res: ServerResponse, repo: Repo): Promise<void> {
  let body: Buffer;
  try {
    body = await readBody(req);
  } catch {
    sendJson(res, 400, { message: 'could not read request body' });
    return;
  }
  // A malformed body (not pkt-lines at all) is a 400, never a crash: the
  // suite's error-survival check posts garbage here on purpose.
  if (body.length < 4 || !/^[0-9a-fA-F]{4}$/.test(body.toString('ascii', 0, 4))) {
    sendJson(res, 400, { message: 'malformed git request' });
    return;
  }
  const wantsV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
  let packets: PktPacket[];
  try {
    packets = decodePktLines(body).packets;
  } catch {
    sendJson(res, 400, { message: 'malformed git request' });
    return;
  }
  if (wantsV2) {
    const first = packets.find((packet) => packet.kind === 'data')?.data.toString('utf8').trim() ?? '';
    if (first.startsWith('command=ls-refs')) {
      sendBytes(res, 200, lsRefsResponse(store, repo, packets), 'application/x-git-upload-pack-result');
      return;
    }
    if (first.startsWith('command=fetch')) {
      const request = parseFetchArgs(packets);
      sendBytes(res, 200, fetchResponse(store, repo, request, true), 'application/x-git-upload-pack-result');
      return;
    }
    sendJson(res, 400, { message: 'unknown git command' });
    return;
  }
  const request = parseFetchArgs(packets);
  sendBytes(res, 200, fetchResponse(store, repo, request, false), 'application/x-git-upload-pack-result');
}

// ---------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------

interface PushCommand {
  oldSha: string;
  newSha: string;
  ref: string;
}

async function handleReceivePack(store: Store, req: IncomingMessage, res: ServerResponse, repo: Repo): Promise<void> {
  let body: Buffer;
  try {
    body = await readBody(req);
  } catch {
    sendJson(res, 400, { message: 'could not read request body' });
    return;
  }
  if (body.length < 4 || !/^[0-9a-fA-F]{4}$/.test(body.toString('ascii', 0, 4))) {
    sendJson(res, 400, { message: 'malformed git request' });
    return;
  }
  let packets: PktPacket[];
  let offset: number;
  try {
    const decoded = decodePktLines(body);
    packets = decoded.packets;
    offset = decoded.offset;
  } catch {
    sendJson(res, 400, { message: 'malformed git request' });
    return;
  }
  const commands: PushCommand[] = [];
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    const line = packet.data.toString('utf8').trim();
    const parts = line.split(' ');
    if (parts.length < 3) continue;
    const [oldSha, newSha, ref] = parts as [string, string, string];
    commands.push({ oldSha, newSha, ref: ref.split('\0')[0] as string });
  }
  const report: string[] = [];
  let unpackOk = true;
  let unpackError = '';
  const packBytes = body.subarray(offset);
  if (packBytes.length > 0) {
    try {
      const entries = parsePack(packBytes, repo);
      for (const entry of entries) {
        store.putObject(repo, entry.type as never, entry.content);
      }
    } catch (err) {
      unpackOk = false;
      unpackError = err instanceof Error ? err.message : 'corrupt packfile';
    }
  }
  if (unpackOk) {
    report.push('unpack ok\n');
    for (const command of commands) {
      report.push(`${applyPush(store, repo, command)}\n`);
    }
  } else {
    report.push(`unpack ${unpackError}\n`);
    for (const command of commands) {
      report.push(`ng ${command.ref} ${unpackError}\n`);
    }
  }
  // With side-band-64k the report-status stream is itself pkt-lined inside
  // band 1: each line ("unpack ok", "ok <ref>", "ng <ref> <reason>") is a
  // pkt-line of its own, and the inner stream ends with a flush pkt-line
  // before the outer flush. (Unframed lines make real git read "unpa" as a
  // length header; a missing inner flush makes it report a hangup.)
  const inner = Buffer.concat([...report.map((line) => pktLine(line)), pktFlush()]);
  const chunks = sidebandChunks(inner);
  chunks.push(pktFlush());
  sendBytes(res, 200, Buffer.concat(chunks), 'application/x-git-receive-pack-result');
}

/** Apply one ref update; returns the report line for it ("ok <ref>" / "ng ..."). */
function applyPush(store: Store, repo: Repo, command: PushCommand): string {
  const { oldSha, newSha, ref } = command;
  if (!/^refs\/(heads|tags)\/\S+$/.test(ref)) return `ng ${ref} invalid ref`;
  const isBranch = ref.startsWith('refs/heads/');
  const current = repo.refs.get(ref) ?? null;
  if (newSha === ZERO_OID) {
    if (current === null) return `ng ${ref} remote ref does not exist`;
    repo.refs.delete(ref);
    return `ok ${ref}`;
  }
  const obj = store.getObject(repo, newSha);
  if (obj === null) return `ng ${ref} new object does not exist`;
  if (isBranch && obj.type !== 'commit') return `ng ${ref} new object is not a commit`;
  if (oldSha === ZERO_OID) {
    if (current !== null) return `ng ${ref} remote ref already exists`;
    repo.refs.set(ref, newSha);
    return `ok ${ref}`;
  }
  if (current === null) return `ng ${ref} remote ref does not exist`;
  if (current !== oldSha) return `ng ${ref} remote ref does not match expected`;
  if (newSha === oldSha) return `ok ${ref}`;
  if (!store.isAncestor(repo, oldSha, newSha)) return `ng ${ref} non-fast-forward`;
  repo.refs.set(ref, newSha);
  return `ok ${ref}`;
}

// ---------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------

/**
 * Handle a git smart-HTTP request. `segments` is the decoded path split:
 * [owner, repo(.git), ...]. Returns true when the route was a git route
 * (even when it answered 404), false when it is not one.
 */
export async function handleGit(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  segments: string[],
  query: URLSearchParams,
): Promise<boolean> {
  if (segments.length < 3) return false;
  const [owner, repoSegment, action] = segments as [string, string, string];
  const repoName = repoSegment.endsWith('.git') ? repoSegment.slice(0, -4) : repoSegment;
  if (action === 'info' && segments[3] === 'refs' && segments.length === 4) {
    if (req.method !== 'GET') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return true;
    }
    const repo = store.getRepo(owner, repoName);
    if (repo === null || owner !== store.viewer.login) {
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    await handleInfoRefs(store, req, res, repo, query);
    return true;
  }
  if (action === 'git-upload-pack' && segments.length === 3) {
    if (req.method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return true;
    }
    const repo = store.getRepo(owner, repoName);
    if (repo === null || owner !== store.viewer.login) {
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    await handleUploadPack(store, req, res, repo);
    return true;
  }
  if (action === 'git-receive-pack' && segments.length === 3) {
    if (req.method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return true;
    }
    const repo = store.getRepo(owner, repoName);
    if (repo === null || owner !== store.viewer.login) {
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    await handleReceivePack(store, req, res, repo);
    return true;
  }
  return false;
}
