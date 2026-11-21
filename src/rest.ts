// rest.ts — GitHub REST v3: repositories, branches, commits, contents,
// labels, issues, comments and pull requests, all on the shared in-memory
// store. Every reply is application/json with a non-empty
// X-GitHub-Request-Id; errors are {"message": string}; a repository under
// another owner than the token's is a 404, never a 403; no token is a 401.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  createIssue as storeCreateIssue,
  createPull as storeCreatePull,
  diffCommits,
  mergeableState,
  parseCommit,
  parseTree,
  squashMerge,
  type Issue,
  type Label,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';
import { bearerToken, isRecord, queryOf, readJsonBody, sendJson, splitPath } from './http.ts';

// ---------------------------------------------------------------------------
// shapes (the JSON the checks read)
// ---------------------------------------------------------------------------

export function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: store.viewer.id, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    html_url: `https://github.example/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
  };
}

export function labelJson(label: Label): Record<string, unknown> {
  return { name: label.name, color: label.color, default: false };
}

export function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: `I_${repo.id}_${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map(labelJson),
    user: { login: issue.user, type: 'User' },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    comments: issue.comments.length,
    html_url: `https://github.example/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

export function pullJson(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = store.refOfBranch(repo, pull.headRef) ?? pull.headSha;
  const baseSha = store.refOfBranch(repo, pull.baseRef) ?? pull.baseSha;
  return {
    id: pull.id,
    node_id: `PR_${repo.id}_${pull.number}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${repo.owner}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: mergeableState(store, repo, pull) === 'MERGEABLE',
    user: { login: pull.user, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    html_url: `https://github.example/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function commitJson(store: Store, repo: Repo, sha: string): Record<string, unknown> | null {
  const obj = store.getObject(repo, sha);
  if (obj === null || obj.type !== 'commit') return null;
  const parsed = parseCommit(obj.content);
  const ident = (line: string): { name: string; email: string; date: string } => {
    const match = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(line);
    if (match === null) return { name: line, email: '', date: store.nowIso() };
    return { name: match[1] as string, email: match[2] as string, date: new Date(Number(match[3]) * 1000).toISOString() };
  };
  return {
    sha,
    commit: {
      message: parsed.message,
      author: ident(parsed.author),
      committer: ident(parsed.committer),
      tree: { sha: parsed.tree },
    },
    parents: parsed.parents.map((parent) => ({ sha: parent })),
    author: { login: store.viewer.login },
    committer: { login: store.viewer.login },
  };
}

// ---------------------------------------------------------------------------
// plumbing
// ---------------------------------------------------------------------------

export interface RestContext {
  store: Store;
  token: string;
  req: IncomingMessage;
  res: ServerResponse;
  segments: string[];
  query: URLSearchParams;
}

function unauthorized(ctx: RestContext): void {
  sendJson(ctx.res, 401, { message: 'Requires authentication' });
}

function notFound(ctx: RestContext, message = 'Not Found'): void {
  sendJson(ctx.res, 404, { message });
}

/** The repository a /repos/{owner}/{name} route names, or null (404). */
function routeRepo(ctx: RestContext): Repo | null {
  const owner = ctx.segments[3] as string;
  const name = ctx.segments[4] as string;
  if (owner !== ctx.store.viewer.login) return null;
  return ctx.store.getRepo(owner, name);
}

function parsePage(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
  return { page, perPage };
}

function paginate<T>(items: T[], query: URLSearchParams): { items: T[]; page: number; perPage: number; total: number } {
  const { page, perPage } = parsePage(query);
  const start = (page - 1) * perPage;
  return { items: items.slice(start, start + perPage), page, perPage, total: items.length };
}

/** The absolute base URL for Link headers, from the request's own Host. */
function originOf(req: IncomingMessage): string {
  const host = req.headers.host ?? '127.0.0.1';
  return `http://${host}`;
}

/** A GitHub-style Link header for a paginated list (next/last only when needed). */
function linkHeader(req: IncomingMessage, basePath: string, query: URLSearchParams, page: number, perPage: number, total: number): string {
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const origin = originOf(req);
  const build = (p: number): string => {
    const params = new URLSearchParams(query);
    params.set('page', String(p));
    params.set('per_page', String(perPage));
    return `${origin}${basePath}?${params.toString()}`;
  };
  const links: string[] = [];
  if (page < totalPages) links.push(`<${build(page + 1)}>; rel="next"`);
  if (totalPages > 1) links.push(`<${build(totalPages)}>; rel="last"`);
  if (page > 1) links.push(`<${build(1)}>; rel="first"`);
  if (page > 1) links.push(`<${build(page - 1)}>; rel="prev"`);
  return links.join(', ');
}

// ---------------------------------------------------------------------------
// repositories
// ---------------------------------------------------------------------------

async function createUserRepo(ctx: RestContext): Promise<void> {
  const read = await readJsonBody(ctx.req);
  if (!read.ok) {
    sendJson(ctx.res, 400, { message: read.error });
    return;
  }
  const body = isRecord(read.value) ? read.value : {};
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (name === '') {
    sendJson(ctx.res, 422, { message: 'name is required' });
    return;
  }
  const repo = ctx.store.createRepo(ctx.store.viewer.login, name, {
    description: typeof body.description === 'string' ? body.description : '',
    isPrivate: body.private === true,
  });
  if (repo === null) {
    sendJson(ctx.res, 422, { message: 'Repository already exists' });
    return;
  }
  sendJson(ctx.res, 201, repoJson(ctx.store, repo));
}

function listUserRepos(ctx: RestContext): void {
  const repos = ctx.store.listViewerRepos();
  const { items, page, perPage, total } = paginate(repos, ctx.query);
  const headers: Record<string, string> = {};
  const link = linkHeader(ctx.req, '/api/v3/user/repos', ctx.query, page, perPage, total);
  if (link !== '') headers.link = link;
  sendJson(ctx.res, 200, items.map((repo) => repoJson(ctx.store, repo)), headers);
}

function getRepo(ctx: RestContext): void {
  const repo = routeRepo(ctx);
  if (repo === null) {
    notFound(ctx);
    return;
  }
  sendJson(ctx.res, 200, repoJson(ctx.store, repo));
}

async function patchRepo(ctx: RestContext): Promise<void> {
  const repo = routeRepo(ctx);
  if (repo === null) {
    notFound(ctx);
    return;
  }
  const read = await readJsonBody(ctx.req);
  if (!read.ok) {
    sendJson(ctx.res, 400, { message: read.error });
    return;
  }
  const body = isRecord(read.value) ? read.value : {};
  if (typeof body.description === 'string') repo.description = body.description;
  if (body.private === true || body.private === false) repo.isPrivate = body.private;
  if (typeof body.name === 'string' && body.name.trim() !== '' && body.name !== repo.name) {
    if (ctx.store.getRepo(repo.owner, body.name) !== null) {
      sendJson(ctx.res, 422, { message: 'Repository already exists' });
      return;
    }
    ctx.store.repos.delete(ctx.store.repoKey(repo.owner, repo.name));
    repo.name = body.name;
    ctx.store.repos.set(ctx.store.repoKey(repo.owner, repo.name), repo);
  }
  repo.updatedAt = ctx.store.nowIso();
  sendJson(ctx.res, 200, repoJson(ctx.store, repo));
}

function deleteRepo(ctx: RestContext): void {
  const repo = routeRepo(ctx);
  if (repo === null) {
    notFound(ctx);
    return;
  }
  ctx.store.deleteRepo(repo.owner, repo.name);
  sendJson(ctx.res, 204, null);
}

function getUser(ctx: RestContext): void {
  const viewer = ctx.store.viewer;
  sendJson(ctx.res, 200, {
    login: viewer.login,
    id: viewer.id,
    name: viewer.name,
    email: viewer.email,
    type: 'User',
    html_url: `https://github.example/${viewer.login}`,
  });
}

// ---------------------------------------------------------------------------
// branches, refs, commits
// ---------------------------------------------------------------------------

function listBranches(ctx: RestContext): void {
  const repo = routeRepo(ctx);
  if (repo === null) {
    notFound(ctx);
    return;
  }
  const names = ctx.store.branchNames(repo);
  names.sort((a, b) => (a === repo.defaultBranch ? -1 : b === repo.defaultBranch ? 1 : a < b ? -1 : 1));
  sendJson(
    ctx.res,
    200,
    names.map((name) => ({
      name,
      commit: { sha: ctx.store.refOfBranch(repo, name) as string },
      protected: false,
    })),
  );
}

function getBranch(ctx: RestContext): void {
  const repo = routeRepo(ctx);
  if (repo === null) {
    notFound(ctx);
    return;
  }
  const branch = ctx.segments[6] as string;
  const sha = ctx.store.refOfBranch(repo, branch);
  if (sha === null) {
    notFound(ctx, 'Branch not found');
    return;
  }
  sendJson(ctx.res, 200, { name: branch, commit: { sha }, protected: false });
}

async function createRef(ctx: RestContext): Promise<void> {
  const repo = routeRepo(ctx);
  if (repo === null) {
    notFound(ctx);
    return;
  }
  const read = await readJsonBody(ctx.req);
  if (!read.ok) {
    sendJson(ctx.res, 400, { message: read.error });
    return;
  }
  const body = isRecord(read.value) ? read.value : {};
  const ref = typeof body.ref === 'string' ? body.ref : '';
  const sha = typeof body.sha === 'string' ? body.sha : '';
  if (!/^refs\/(heads|tags)\/\S+$/.test(ref) || !/^[0-9a-f]{40}$/.test(sha)) {
    sendJson(ctx.res, 422, { message: 'ref and sha are required' });
    return;
  }
  if (repo.refs.has(ref)) {
    sendJson(ctx.res, 422, { message: 'Reference already exists' });
    return;
  }
  const obj = ctx.store.getObject(repo, sha);
  if (obj === null || (ref.startsWith('refs/heads/') && obj.type !== 'commit')) {
    sendJson(ctx.res, 422, { message: 'the sha does not name an object in this repository' });
    return;
  }
  repo.refs.set(ref, sha);
  sendJson(ctx.res, 201, { ref, object: { sha, type: obj.type } });
}

function getRef(ctx: RestContext): void {
  const repo = routeRepo(ctx);
  if (repo === null) {
    notFound(ctx);
    return;
  }
  const ref = ctx.segments.slice(6).join('/');
  const sha = repo.refs.get(ref);
  if (sha === undefined) {
    notFound(ctx, 'Reference does not exist');
    return;
  }
  const obj = ctx.store.getObject(repo, sha);
  sendJson(ctx.res, 200, { ref, object: { sha, type: obj?.type ?? 'commit' } });
}

function listCommits(ctx: RestContext): void {
  const repo = routeRepo(ctx);
  if (repo === null) {
    notFound(ctx);
    return;
  }
  const refParam = ctx.query.get('sha') ?? repo.defaultBranch;
  let tip: string | null = ctx.store.refOfBranch(repo, refParam);
  if (tip === null && /^[0-9a-f]{40}$/.test(refParam)) tip = refParam;
  if (tip === null || ctx.store.getObject(repo, tip) === null) {
    notFound(ctx, 'Commit not found');
    return;
  }
  const commits = ctx.store.commitsFrom(repo, tip);
  const { items, page, perPage, total } = paginate(commits, ctx.query);
  const headers: Record<string, string> = {};
  const link = linkHeader(ctx.req, `/api/v3/repos/${repo.owner}/${repo.name}/commits`, ctx.query, page, perPage, total);
  if (link !== '') headers.link = link;
  const out: unknown[] = [];
  for (const commit of items) {
    const json = commitJson(ctx.store, repo, commit.sha);
    if (json !== null) out.push(json);
  }
  sendJson(ctx.res, 200, out, headers);
}

// ---------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------

/** The tree sha of a directory inside a commit, or null when it is not a dir. */
function treeShaAtPath(store: Store, repo: Repo, commitSha: string, dirPath: string): string | null {
  const obj = store.getObject(repo, commitSha);
  if (obj === null || obj.type !== 'commit') return null;
  let treeSha = parseCommit(obj.content).tree;
  if (dirPath === '') return treeSha;
  for (const segment of dirPath.split('/')) {
    const treeObj = store.getObject(repo, treeSha);
    if (treeObj === null || treeObj.type !== 'tree') return null;
    const entries = parseTree(treeObj.content);
    const found = entries.find((entry) => entry.name === segment && entry.mode === '40000');
    if (found === undefined) return null;
    treeSha = found.oid;
  }
  return treeSha;
}

async function putContent(ctx: RestContext): Promise<void> {
  const repo = routeRepo(ctx);
  if (repo === null) {
    notFound(ctx);
    return;
  }
  const read = await readJsonBody(ctx.req);
  if (!read.ok) {
    sendJson(ctx.res, 400, { message: read.error });
    return;
  }
  const body = isRecord(read.value) ? read.value : {};
  const filePath = ctx.segments.slice(6).join('/');
  const message = typeof body.message === 'string' ? body.message : '';
  const contentB64 = typeof body.content === 'string' ? body.content : '';
  if (message === '' || contentB64 === '') {
    sendJson(ctx.res, 422, { message: 'message and content are required' });
    return;
  }
  let content: Buffer;
  try {
    content = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
  } catch {
    sendJson(ctx.res, 400, { message: 'content is not valid base64' });
    return;
  }
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  let tip = ctx.store.refOfBranch(repo, branch);
  if (tip === null) {
    if (repo.refs.size === 0) {
      // The repository's first commit: the branch becomes the default.
      repo.defaultBranch = branch;
    } else {
      // A new branch starts at the default branch tip (the MCP fallback).
      const baseTip = ctx.store.refOfBranch(repo, repo.defaultBranch);
      if (baseTip === null) {
        sendJson(ctx.res, 422, { message: 'the repository has no commits' });
        return;
      }
      repo.refs.set(`refs/heads/${branch}`, baseTip);
      tip = baseTip;
    }
  }
  const files = tip === null ? new Map() : ctx.store.filesAtCommit(repo, tip);
  const existing = files.get(filePath);
  const givenSha = typeof body.sha === 'string' ? body.sha : null;
  if (existing !== undefined) {
    if (givenSha === null) {
      sendJson(ctx.res, 422, { message: 'the file already exists; pass its sha to update it' });
      return;
    }
    if (givenSha !== existing.oid) {
      sendJson(ctx.res, 409, { message: 'the sha does not match the current file' });
      return;
    }
  }
  const contents = new Map<string, Buffer>();
  for (const [path, entry] of files) {
    const obj = ctx.store.getObject(repo, entry.oid);
    if (obj !== null) contents.set(path, obj.content);
  }
  contents.set(filePath, content);
  const tree = ctx.store.buildTree(repo, contents);
  const commitSha = ctx.store.makeCommit(repo, { tree, parents: tip === null ? [] : [tip], message });
  repo.refs.set(`refs/heads/${branch}`, commitSha);
  const blobSha = ctx.store.makeBlob(repo, content);
  const status = existing === undefined ? 201 : 200;
  sendJson(ctx.res, status, {
    content: {
      name: filePath.split('/').pop() ?? filePath,
      path: filePath,
      sha: blobSha,
      size: content.length,
      encoding: 'base64',
      content: content.toString('base64'),
    },
    commit: { sha: commitSha },
  });
}

function getContent(ctx: RestContext): void {
  const repo = routeRepo(ctx);
  if (repo === null) {
    notFound(ctx);
    return;
  }
  const filePath = ctx.segments.slice(6).join('/');
  const refParam = ctx.query.get('ref') ?? repo.defaultBranch;
  let tip: string | null = ctx.store.refOfBranch(repo, refParam);
  if (tip === null && /^[0-9a-f]{40}$/.test(refParam)) tip = refParam;
  if (tip === null) {
    notFound(ctx);
    return;
  }
  const files = ctx.store.filesAtCommit(repo, tip);
  const entry = files.get(filePath);
  if (entry !== undefined) {
    const obj = ctx.store.getObject(repo, entry.oid);
    const content = obj !== null ? obj.content : Buffer.alloc(0);
    sendJson(ctx.res, 200, {
      type: 'file',
      encoding: 'base64',
      size: content.length,
      name: filePath.split('/').pop() ?? filePath,
      path: filePath,
      content: content.toString('base64'),
      sha: entry.oid,
    });
    return;
  }
  // A directory: its direct children (files and subdirectories).
  const prefix = filePath === '' ? '' : `${filePath}/`;
  const listed: Record<string, unknown>[] = [];
  const seenDirs = new Set<string>();
  for (const [path, fileEntry] of files) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) {
      const obj = ctx.store.getObject(repo, fileEntry.oid);
      listed.push({
        type: 'file',
        name: rest,
        path,
        sha: fileEntry.oid,
        size: obj !== null ? obj.content.length : 0,
      });
    } else {
      const dir = rest.slice(0, slash);
      if (seenDirs.has(dir)) continue;
      seenDirs.add(dir);
      const dirPath = `${prefix}${dir}`;
      const treeSha = treeShaAtPath(ctx.store, repo, tip, dirPath);
      listed.push({ type: 'dir', name: dir, path: dirPath, sha: treeSha ?? '' });
    }
  }
  if (listed.length === 0) {
    notFound(ctx);
    return;
  }
  listed.sort((a, b) => String(a.name) < String(b.name) ? -1 : 1);
  sendJson(ctx.res, 200, listed);
}

async function deleteContent(ctx: RestContext): Promise<void> {
  const repo = routeRepo(ctx);
  if (repo === null) {
    notFound(ctx);
    return;
  }
  const filePath = ctx.segments.slice(6).join('/');
  const read = await readJsonBody(ctx.req);
  if (!read.ok) {
    sendJson(ctx.res, 400, { message: read.error });
    return;
  }
  const body = isRecord(read.value) ? read.value : {};
  const message = typeof body.message === 'string' ? body.message : '';
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  const tip = ctx.store.refOfBranch(repo, branch);
  if (tip === null) {
    notFound(ctx);
    return;
  }
  const files = ctx.store.filesAtCommit(repo, tip);
  const existing = files.get(filePath);
  if (existing === undefined) {
    notFound(ctx);
    return;
  }
  const givenSha = typeof body.sha === 'string' ? body.sha : null;
  if (givenSha !== null && givenSha !== existing.oid) {
    sendJson(ctx.res, 409, { message: 'the sha does not match the current file' });
    return;
  }
  const contents = new Map<string, Buffer>();
  for (const [path, entry] of files) {
    if (path === filePath) continue;
    const obj = ctx.store.getObject(repo, entry.oid);
    if (obj !== null) contents.set(path, obj.content);
  }
  const tree = ctx.store.buildTree(repo, contents);
  const commitSha = ctx.store.makeCommit(repo, { tree, parents: [tip], message: message === '' ? `Delete ${filePath}` : message });
  repo.refs.set(`refs/heads/${branch}`, commitSha);
  sendJson(ctx.res, 200, { commit: { sha: commitSha } });
}

// ---------------------------------------------------------------------------
// labels
// ---------------------------------------------------------------------------

async function createLabel(ctx: RestContext): Promise<void> {
  const repo = routeRepo(ctx);
  if (repo === null) {
    notFound(ctx);
    return;
  }
  const read = await readJsonBody(ctx.req);
  if (!read.ok) {
    sendJson(ctx.res, 400, { message: read.error });
    return;
  }
  const body = isRecord(read.value) ? read.value : {};
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (name === '') {
    sendJson(ctx.res, 422, { message: 'name is required' });
    return;
  }
  const existing = repo.labels.find((label) => label.name === name);
  if (existing !== undefined) {
    sendJson(ctx.res, 201, labelJson(existing));
    return;
  }
  const color = typeof body.color === 'string' && /^[0-9a-fA-F]{6}$/.test(body.color) ? body.color.toLowerCase() : 'ededed';
  const label: Label = { name, color };
  repo.labels.push(label);
  sendJson(ctx.res, 201, labelJson(label));
}

function listLabels(ctx: RestContext): void {
  const repo = routeRepo(ctx);
  if (repo === null) {
    notFound(ctx);
    return;
  }
  sendJson(ctx.res, 200, repo.labels.map(labelJson));
}

// ---------------------------------------------------------------------------
// issues and comments
// ---------------------------------------------------------------------------

function findIssue(repo: Repo, number: number): Issue | null {
  return repo.issues.find((issue) => issue.number === number) ?? null;
}

async function createIssueRoute(ctx: RestContext): Promise<void> {
  const repo = routeRepo(ctx);
  if (repo === null) {
    notFound(ctx);
    return;
  }
  const read = await readJsonBody(ctx.req);
  if (!read.ok) {
    sendJson(ctx.res, 400, { message: read.error });
    return;
  }
  const body = isRecord(read.value) ? read.value : {};
  const title = typeof body.title === 'string' ? body.title : '';
  if (title === '') {
    sendJson(ctx.res, 422, { message: 'title is required' });
    return;
  }
  const labels = Array.isArray(body.labels) ? body.labels.filter((entry): entry is string => typeof entry === 'string') : [];
  const issue = storeCreateIssue(ctx.store, repo, {
    title,
    body: typeof body.body === 'string' ? body.body : '',
    labels,
  });
  if (issue === null) {
    sendJson(ctx.res, 422, { message: 'a label does not exist in this repository' });
    return;
  }
  sendJson(ctx.res, 201, issueJson(ctx.store, repo, issue));
}

function listIssues(ctx: RestContext): void {
  const repo = routeRepo(ctx);
  if (repo === null) {
    notFound(ctx);
    return;
  }
  const state = ctx.query.get('state') ?? 'open';
  const direction = ctx.query.get('direction') ?? 'desc';
  let issues = repo.issues.slice();
  if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
  else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
  else if (state !== 'all') issues = issues.filter((issue) => issue.state === 'open');
  issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
  const { items, page, perPage, total } = paginate(issues, ctx.query);
  const headers: Record<string, string> = {};
  const link = linkHeader(ctx.req, `/api/v3/repos/${repo.owner}/${repo.name}/issues`, ctx.query, page, perPage, total);
  if (link !== '') headers.link = link;
  sendJson(ctx.res, 200, items.map((issue) => issueJson(ctx.store, repo, issue)), headers);
}

function getIssue(ctx: RestContext): void {
  const repo = routeRepo(ctx);
  if (repo === null) {
    notFound(ctx);
    return;
  }
  const number = Number(ctx.segments[6]);
  const issue = Number.isInteger(number) ? findIssue(repo, number) : null;
  if (issue === null) {
    notFound(ctx);
    return;
  }
  sendJson(ctx.res, 200, issueJson(ctx.store, repo, issue));
}

async function patchIssue(ctx: RestContext): Promise<void> {
  const repo = routeRepo(ctx);
  if (repo === null) {
    notFound(ctx);
    return;
  }
  const number = Number(ctx.segments[6]);
  const issue = Number.isInteger(number) ? findIssue(repo, number) : null;
  if (issue === null) {
    notFound(ctx);
    return;
  }
  const read = await readJsonBody(ctx.req);
  if (!read.ok) {
    sendJson(ctx.res, 400, { message: read.error });
    return;
  }
  const body = isRecord(read.value) ? read.value : {};
  if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
  if (typeof body.title === 'string') issue.title = body.title;
  if (typeof body.body === 'string') issue.body = body.body;
  issue.updatedAt = ctx.store.nowIso();
  sendJson(ctx.res, 200, issueJson(ctx.store, repo, issue));
}

async function createComment(ctx: RestContext): Promise<void> {
  const repo = routeRepo(ctx);
  if (repo === null) {
    notFound(ctx);
    return;
  }
  const number = Number(ctx.segments[6]);
  const issue = Number.isInteger(number) ? findIssue(repo, number) : null;
  if (issue === null) {
    notFound(ctx);
    return;
  }
  const read = await readJsonBody(ctx.req);
  if (!read.ok) {
    sendJson(ctx.res, 400, { message: read.error });
    return;
  }
  const body = isRecord(read.value) ? read.value : {};
  if (typeof body.body !== 'string' || body.body === '') {
    sendJson(ctx.res, 422, { message: 'body is required' });
    return;
  }
  const now = ctx.store.nowIso();
  const comment = {
    id: ctx.store.nextCommentIdValue(),
    body: body.body,
    user: ctx.store.viewer.login,
    createdAt: now,
    updatedAt: now,
  };
  issue.comments.push(comment);
  issue.updatedAt = now;
  sendJson(ctx.res, 201, {
    id: comment.id,
    body: comment.body,
    user: { login: comment.user, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
  });
}

function listComments(ctx: RestContext): void {
  const repo = routeRepo(ctx);
  if (repo === null) {
    notFound(ctx);
    return;
  }
  const number = Number(ctx.segments[6]);
  const issue = Number.isInteger(number) ? findIssue(repo, number) : null;
  if (issue === null) {
    notFound(ctx);
    return;
  }
  sendJson(
    ctx.res,
    200,
    issue.comments.map((comment) => ({
      id: comment.id,
      body: comment.body,
      user: { login: comment.user, type: 'User' },
      created_at: comment.createdAt,
      updated_at: comment.updatedAt,
    })),
  );
}

// ---------------------------------------------------------------------------
// pull requests
// ---------------------------------------------------------------------------

function findPull(repo: Repo, number: number): Pull | null {
  return repo.pulls.find((pull) => pull.number === number) ?? null;
}

async function createPullRoute(ctx: RestContext): Promise<void> {
  const repo = routeRepo(ctx);
  if (repo === null) {
    notFound(ctx);
    return;
  }
  const read = await readJsonBody(ctx.req);
  if (!read.ok) {
    sendJson(ctx.res, 400, { message: read.error });
    return;
  }
  const body = isRecord(read.value) ? read.value : {};
  const title = typeof body.title === 'string' ? body.title : '';
  const head = typeof body.head === 'string' ? body.head : '';
  const base = typeof body.base === 'string' ? body.base : '';
  if (title === '' || head === '' || base === '') {
    sendJson(ctx.res, 422, { message: 'title, head and base are required' });
    return;
  }
  const headName = head.includes(':') ? (head.split(':').pop() as string) : head;
  const baseName = base.includes(':') ? (base.split(':').pop() as string) : base;
  const duplicate = repo.pulls.find((pull) => pull.state === 'open' && pull.headRef === headName && pull.baseRef === baseName);
  if (duplicate !== undefined) {
    sendJson(ctx.res, 422, { message: 'a pull request is already open for this head and base' });
    return;
  }
  const pull = storeCreatePull(ctx.store, repo, {
    title,
    body: typeof body.body === 'string' ? body.body : '',
    head: headName,
    base: baseName,
  });
  if (pull === null) {
    sendJson(ctx.res, 422, { message: 'the head or base branch does not exist' });
    return;
  }
  sendJson(ctx.res, 201, pullJson(ctx.store, repo, pull));
}

function listPulls(ctx: RestContext): void {
  const repo = routeRepo(ctx);
  if (repo === null) {
    notFound(ctx);
    return;
  }
  const state = ctx.query.get('state') ?? 'open';
  let pulls = repo.pulls.slice();
  if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
  else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
  else if (state !== 'all') pulls = pulls.filter((pull) => pull.state === 'open');
  pulls.sort((a, b) => b.seq - a.seq);
  const { items, page, perPage, total } = paginate(pulls, ctx.query);
  const headers: Record<string, string> = {};
  const link = linkHeader(ctx.req, `/api/v3/repos/${repo.owner}/${repo.name}/pulls`, ctx.query, page, perPage, total);
  if (link !== '') headers.link = link;
  sendJson(ctx.res, 200, items.map((pull) => pullJson(ctx.store, repo, pull)), headers);
}

function getPull(ctx: RestContext): void {
  const repo = routeRepo(ctx);
  if (repo === null) {
    notFound(ctx);
    return;
  }
  const number = Number(ctx.segments[6]);
  const pull = Number.isInteger(number) ? findPull(repo, number) : null;
  if (pull === null) {
    notFound(ctx);
    return;
  }
  sendJson(ctx.res, 200, pullJson(ctx.store, repo, pull));
}

function listPullFiles(ctx: RestContext): void {
  const repo = routeRepo(ctx);
  if (repo === null) {
    notFound(ctx);
    return;
  }
  const number = Number(ctx.segments[6]);
  const pull = Number.isInteger(number) ? findPull(repo, number) : null;
  if (pull === null) {
    notFound(ctx);
    return;
  }
  const headTip = ctx.store.refOfBranch(repo, pull.headRef);
  if (headTip === null) {
    notFound(ctx);
    return;
  }
  const changes = diffCommits(ctx.store, repo, pull.mergeBaseSha, headTip);
  sendJson(
    ctx.res,
    200,
    changes.map((change) => ({
      filename: change.path,
      status: change.status,
      additions: change.additions,
      deletions: change.deletions,
      changes: change.additions + change.deletions,
      sha: change.newOid ?? change.oldOid ?? '',
    })),
  );
}

function mergePull(ctx: RestContext): void {
  const repo = routeRepo(ctx);
  if (repo === null) {
    notFound(ctx);
    return;
  }
  const number = Number(ctx.segments[6]);
  const pull = Number.isInteger(number) ? findPull(repo, number) : null;
  if (pull === null) {
    notFound(ctx);
    return;
  }
  const result = squashMerge(ctx.store, repo, pull);
  if (!result.ok) {
    sendJson(ctx.res, 405, { message: result.reason });
    return;
  }
  sendJson(ctx.res, 200, { sha: result.sha, merged: true, message: 'Pull request successfully merged' });
}

// ---------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------

/**
 * Handle a /api/v3 request. Returns true when the path was a REST route
 * (even when it answered 404), false when it is not under /api/v3.
 */
export async function handleRest(
  store: Store,
  token: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const segments = splitPath(((): string => {
    try {
      return new URL(req.url ?? '/', 'http://entry').pathname;
    } catch {
      return '/';
    }
  })());
  if (segments[0] !== 'api' || segments[1] !== 'v3') return false;
  const method = req.method ?? 'GET';
  const ctx: RestContext = { store, token, req, res, segments, query: queryOf(req) };

  // The API root and meta are public; everything else needs the bearer token.
  const isPublic = method === 'GET' && ((segments.length === 2) || (segments.length === 3 && segments[2] === 'meta'));
  if (!isPublic) {
    const presented = bearerToken(req);
    const ok = presented !== null && presented !== '' && (token === '' || presented === token);
    if (!ok) {
      unauthorized(ctx);
      return true;
    }
  }

  if (method === 'GET' && segments.length === 2) {
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }
  if (method === 'GET' && segments.length === 3 && segments[2] === 'meta') {
    sendJson(res, 200, { installed_version: '1.0.0' });
    return true;
  }
  if (method === 'GET' && segments.length === 3 && segments[2] === 'user') {
    getUser(ctx);
    return true;
  }
  if (segments.length >= 3 && segments[2] === 'user' && segments[3] === 'repos') {
    if (method === 'GET') {
      listUserRepos(ctx);
      return true;
    }
    if (method === 'POST') {
      await createUserRepo(ctx);
      return true;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }
  if (segments.length >= 5 && segments[2] === 'repos') {
    const sub = segments[5];
    if (sub === undefined) {
      if (method === 'GET') getRepo(ctx);
      else if (method === 'PATCH') await patchRepo(ctx);
      else if (method === 'DELETE') deleteRepo(ctx);
      else sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    if (sub === 'branches') {
      if (method === 'GET' && segments.length === 6) listBranches(ctx);
      else if (method === 'GET' && segments.length === 7) getBranch(ctx);
      else sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    if (sub === 'commits') {
      if (method === 'GET') listCommits(ctx);
      else sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    if (sub === 'git' && segments[6] === 'refs') {
      if (method === 'POST' && segments.length === 7) await createRef(ctx);
      else if (method === 'GET' && segments.length >= 8) getRef(ctx);
      else sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    if (sub === 'contents') {
      if (method === 'PUT') await putContent(ctx);
      else if (method === 'GET') getContent(ctx);
      else if (method === 'DELETE') await deleteContent(ctx);
      else sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    if (sub === 'labels') {
      if (method === 'POST') await createLabel(ctx);
      else if (method === 'GET') listLabels(ctx);
      else sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    if (sub === 'issues') {
      if (method === 'POST' && segments.length === 6) {
        await createIssueRoute(ctx);
        return true;
      }
      if (method === 'GET' && segments.length === 6) {
        listIssues(ctx);
        return true;
      }
      if (segments.length >= 7) {
        if (segments[7] === 'comments') {
          if (method === 'POST') await createComment(ctx);
          else if (method === 'GET') listComments(ctx);
          else sendJson(res, 404, { message: 'Not Found' });
          return true;
        }
        if (method === 'GET') getIssue(ctx);
        else if (method === 'PATCH') await patchIssue(ctx);
        else sendJson(res, 404, { message: 'Not Found' });
        return true;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    if (sub === 'pulls') {
      if (method === 'POST' && segments.length === 6) {
        await createPullRoute(ctx);
        return true;
      }
      if (method === 'GET' && segments.length === 6) {
        listPulls(ctx);
        return true;
      }
      if (segments.length >= 7) {
        if (segments[7] === 'files' && method === 'GET') {
          listPullFiles(ctx);
          return true;
        }
        if (segments[7] === 'merge' && method === 'PUT') {
          mergePull(ctx);
          return true;
        }
        if (method === 'GET') getPull(ctx);
        else sendJson(res, 404, { message: 'Not Found' });
        return true;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
  }
  sendJson(res, 404, { message: 'Not Found' });
  return true;
}
