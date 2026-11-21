// store.ts — the forge's whole state, in memory: one process per trial, so no
// disk persistence is needed. Repositories hold git objects (sha -> object),
// refs, issues, pull requests, labels and comments; every id is stable for
// the life of the process, which is what the REST/GraphQL/MCP views compare.
//
// Git objects are stored exactly as git stores them: sha1("<type> <len>\0" +
// bytes). Trees are built from flat file maps, commits from trees, and the
// merge path works on flat maps too, so the REST contents API, the git smart
// HTTP layer and the pull-request merge all read the same truth.

import { createHash } from 'node:crypto';
import { scenarioIdentity, type ScenarioUser } from './scenario.ts';

export type ObjType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: ObjType;
  content: Buffer;
}

export interface Label {
  name: string;
  color: string;
}

export interface IssueComment {
  id: number;
  body: string;
  user: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: IssueComment[];
  user: string;
  createdAt: string;
  updatedAt: string;
  seq: number;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  mergeBaseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  user: string;
  createdAt: string;
  updatedAt: string;
  seq: number;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Issue[];
  pulls: Pull[];
  labels: Label[];
  nextNumber: number;
  nextCommentId: number;
  createdAt: string;
  updatedAt: string;
}

export const ZERO_OID = '0'.repeat(40);

/** sha1("<type> <size>\0" + content), as git hashes an object. */
export function sha1Object(type: ObjType, content: Buffer): string {
  const head = Buffer.from(`${type} ${content.length}\0`, 'utf8');
  return createHash('sha1').update(head).update(content).digest('hex');
}

/** Parse a commit object's raw bytes into its fields. */
export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(content: Buffer): ParsedCommit {
  const text = content.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2).replace(/\n$/, '');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** One entry of a parsed tree object. */
export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object's raw bytes into its entries. */
export function parseTree(content: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < content.length) {
    const space = content.indexOf(0x20, offset);
    if (space === -1) break;
    const nul = content.indexOf(0x00, space + 1);
    if (nul === -1 || nul + 21 > content.length) break;
    const mode = content.toString('utf8', offset, space);
    const name = content.toString('utf8', space + 1, nul);
    const oid = content.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Serialize tree entries (already git-sorted) into a tree object's bytes. */
export function serializeTree(entries: TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Git's sort order for tree entries: directories compare as "name/". */
export function treeEntryKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/** Count lines in a buffer (a trailing newline does not add an empty line). */
export function lineCount(content: Buffer): number {
  if (content.length === 0) return 0;
  const text = content.toString('utf8');
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

/** Added lines of `next` against `prev`, by multiset difference of lines. */
export function addedLines(prev: Buffer, next: Buffer): number {
  const prevLines = prev.toString('utf8').split('\n');
  const counts = new Map<string, number>();
  for (const line of prevLines) counts.set(line, (counts.get(line) ?? 0) + 1);
  let added = 0;
  for (const line of next.toString('utf8').split('\n')) {
    const left = counts.get(line) ?? 0;
    if (left > 0) counts.set(line, left - 1);
    else added += 1;
  }
  // A trailing empty line from the final newline is not a real line.
  if (next.length > 0 && next[next.length - 1] === 0x0a) added = Math.max(0, added - 1);
  return added;
}

export class Store {
  readonly viewer: ScenarioUser;
  readonly stranger: ScenarioUser;
  readonly repos = new Map<string, Repo>();
  readonly reposById = new Map<number, Repo>();
  private nextRepoId = 5000;
  private nextIssueId = 10000;
  private nextCommentId = 20000;
  private nextPullId = 30000;
  private seq = 0;

  constructor() {
    const identity = scenarioIdentity();
    this.viewer = identity.viewer;
    this.stranger = identity.stranger;
  }

  /** Monotonic creation order, shared by issues, pulls and commits. */
  tick(): number {
    this.seq += 1;
    return this.seq;
  }

  /** The next stable numeric id for an issue. */
  nextIssueIdValue(): number {
    const id = this.nextIssueId;
    this.nextIssueId += 1;
    return id;
  }

  /** The next stable numeric id for a comment. */
  nextCommentIdValue(): number {
    const id = this.nextCommentId;
    this.nextCommentId += 1;
    return id;
  }

  /** The next stable numeric id for a pull request. */
  nextPullIdValue(): number {
    const id = this.nextPullId;
    this.nextPullId += 1;
    return id;
  }

  nowIso(): string {
    return new Date().toISOString();
  }

  // ---------------------------------------------------------- repositories

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | null {
    return this.repos.get(this.repoKey(owner, name)) ?? null;
  }

  getRepoById(id: number): Repo | null {
    return this.reposById.get(id) ?? null;
  }

  createRepo(owner: string, name: string, options: { description?: string; isPrivate?: boolean }): Repo | null {
    if (this.getRepo(owner, name) !== null) return null;
    const now = this.nowIso();
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      owner,
      description: options.description ?? '',
      isPrivate: options.isPrivate ?? false,
      defaultBranch: 'main',
      objects: new Map(),
      refs: new Map(),
      issues: [],
      pulls: [],
      labels: [],
      nextNumber: 1,
      nextCommentId: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.nextRepoId += 1;
    this.repos.set(this.repoKey(owner, name), repo);
    this.reposById.set(repo.id, repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    const repo = this.getRepo(owner, name);
    if (repo === null) return false;
    this.repos.delete(this.repoKey(owner, name));
    this.reposById.delete(repo.id);
    return true;
  }

  listViewerRepos(): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === this.viewer.login) out.push(repo);
    }
    out.sort((a, b) => a.id - b.id);
    return out;
  }

  // ---------------------------------------------------------- git objects

  getObject(repo: Repo, sha: string): GitObject | null {
    return repo.objects.get(sha) ?? null;
  }

  putObject(repo: Repo, type: ObjType, content: Buffer): string {
    const sha = sha1Object(type, content);
    if (!repo.objects.has(sha)) repo.objects.set(sha, { type, content });
    return sha;
  }

  makeBlob(repo: Repo, content: Buffer): string {
    return this.putObject(repo, 'blob', content);
  }

  /**
   * Build a tree object from a flat path -> content map, creating every
   * intermediate tree. Returns the root tree's sha.
   */
  buildTree(repo: Repo, files: Map<string, Buffer>): string {
    return this.buildTreeFromRelative(repo, files);
  }

  /** Build a tree from paths relative to one directory (helper for buildTree). */
  private buildTreeFromRelative(repo: Repo, files: Map<string, Buffer>): string {
    const entries: TreeEntry[] = [];
    const subdirs = new Map<string, Map<string, Buffer>>();
    for (const [path, content] of files) {
      const slash = path.indexOf('/');
      if (slash === -1) {
        entries.push({ mode: '100644', name: path, oid: this.makeBlob(repo, content) });
      } else {
        const dir = path.slice(0, slash);
        let sub = subdirs.get(dir);
        if (sub === undefined) {
          sub = new Map();
          subdirs.set(dir, sub);
        }
        sub.set(path.slice(slash + 1), content);
      }
    }
    for (const [dir, sub] of subdirs) {
      entries.push({ mode: '40000', name: dir, oid: this.buildTreeFromRelative(repo, sub) });
    }
    entries.sort((a, b) => (treeEntryKey(a) < treeEntryKey(b) ? -1 : treeEntryKey(a) > treeEntryKey(b) ? 1 : 0));
    return this.putObject(repo, 'tree', serializeTree(entries));
  }

  /**
   * Flatten a tree object into path -> {mode, oid}, recursively. Returns an
   * empty map for a missing tree (an unborn ref has no tree).
   */
  flattenTree(repo: Repo, treeSha: string, prefix = ''): Map<string, { mode: string; oid: string }> {
    const out = new Map<string, { mode: string; oid: string }>();
    const obj = this.getObject(repo, treeSha);
    if (obj === null || obj.type !== 'tree') return out;
    for (const entry of parseTree(obj.content)) {
      const path = `${prefix}${entry.name}`;
      if (entry.mode === '40000') {
        for (const [sub, value] of this.flattenTree(repo, entry.oid, `${path}/`)) out.set(sub, value);
      } else {
        out.set(path, { mode: entry.mode, oid: entry.oid });
      }
    }
    return out;
  }

  /** The flat file map at a commit (path -> blob oid), or an empty map. */
  filesAtCommit(repo: Repo, commitSha: string): Map<string, { mode: string; oid: string }> {
    const obj = this.getObject(repo, commitSha);
    if (obj === null || obj.type !== 'commit') return new Map();
    return this.flattenTree(repo, parseCommit(obj.content).tree);
  }

  /** The blob bytes at a commit for one path, or null when absent. */
  blobAtCommit(repo: Repo, commitSha: string, path: string): Buffer | null {
    const files = this.filesAtCommit(repo, commitSha);
    const entry = files.get(path);
    if (entry === undefined) return null;
    const obj = this.getObject(repo, entry.oid);
    return obj !== null && obj.type === 'blob' ? obj.content : null;
  }

  /**
   * Create a commit object. The author/committer are the viewer; the message
   * is stored verbatim (one trailing newline is git's, not the message's).
   */
  makeCommit(
    repo: Repo,
    options: { tree: string; parents: string[]; message: string; epochSec?: number },
  ): string {
    const epochSec = options.epochSec ?? Math.floor(Date.now() / 1000);
    const ident = `${this.viewer.login} <${this.viewer.email}> ${epochSec} +0000`;
    const head = [`tree ${options.tree}`];
    for (const parent of options.parents) head.push(`parent ${parent}`);
    head.push(`author ${ident}`);
    head.push(`committer ${ident}`);
    const content = Buffer.from(`${head.join('\n')}\n\n${options.message}\n`, 'utf8');
    this.tick();
    return this.putObject(repo, 'commit', content);
  }

  /** Is `ancestor` reachable from `descendant` (following parents)? */
  isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const stack = [descendant];
    while (stack.length > 0) {
      const sha = stack.pop() as string;
      if (seen.has(sha)) continue;
      seen.add(sha);
      const obj = this.getObject(repo, sha);
      if (obj === null || obj.type !== 'commit') continue;
      for (const parent of parseCommit(obj.content).parents) {
        if (parent === ancestor) return true;
        stack.push(parent);
      }
    }
    return false;
  }

  /** All commits reachable from `tip`, newest creation order first. */
  commitsFrom(repo: Repo, tip: string): ParsedCommitWithSha[] {
    const out: ParsedCommitWithSha[] = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const sha = stack.pop() as string;
      if (seen.has(sha)) continue;
      seen.add(sha);
      const obj = this.getObject(repo, sha);
      if (obj === null || obj.type !== 'commit') continue;
      const parsed = parseCommit(obj.content);
      out.push({ sha, ...parsed });
      for (const parent of parsed.parents) stack.push(parent);
    }
    return out;
  }

  /** The ref a branch name resolves to, or null. */
  refOfBranch(repo: Repo, branch: string): string | null {
    return repo.refs.get(`refs/heads/${branch}`) ?? null;
  }

  /** All branch names in the repo, sorted. */
  branchNames(repo: Repo): string[] {
    const names: string[] = [];
    for (const ref of repo.refs.keys()) {
      if (ref.startsWith('refs/heads/')) names.push(ref.slice('refs/heads/'.length));
    }
    return names.sort();
  }

  /** All tag names in the repo, sorted. */
  tagNames(repo: Repo): string[] {
    const names: string[] = [];
    for (const ref of repo.refs.keys()) {
      if (ref.startsWith('refs/tags/')) names.push(ref.slice('refs/tags/'.length));
    }
    return names.sort();
  }
}

export interface ParsedCommitWithSha extends ParsedCommit {
  sha: string;
}

// ---------------------------------------------------------------------------
// Diff and merge (flat file maps: path -> blob oid).
// ---------------------------------------------------------------------------

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  oldOid: string | null;
  newOid: string | null;
  additions: number;
  deletions: number;
}

/** The file-level difference between two flat maps, with line counts. */
export function diffFileMaps(
  store: Store,
  repo: Repo,
  oldFiles: Map<string, { mode: string; oid: string }>,
  newFiles: Map<string, { mode: string; oid: string }>,
): FileChange[] {
  const changes: FileChange[] = [];
  const paths = new Set([...oldFiles.keys(), ...newFiles.keys()]);
  for (const path of [...paths].sort()) {
    const oldEntry = oldFiles.get(path);
    const newEntry = newFiles.get(path);
    if (oldEntry !== undefined && newEntry !== undefined && oldEntry.oid === newEntry.oid) continue;
    if (oldEntry === undefined && newEntry !== undefined) {
      const content = store.getObject(repo, newEntry.oid)?.content ?? Buffer.alloc(0);
      changes.push({ path, status: 'added', oldOid: null, newOid: newEntry.oid, additions: lineCount(content), deletions: 0 });
    } else if (oldEntry !== undefined && newEntry === undefined) {
      const content = store.getObject(repo, oldEntry.oid)?.content ?? Buffer.alloc(0);
      changes.push({ path, status: 'removed', oldOid: oldEntry.oid, newOid: null, additions: 0, deletions: lineCount(content) });
    } else if (oldEntry !== undefined && newEntry !== undefined) {
      const oldContent = store.getObject(repo, oldEntry.oid)?.content ?? Buffer.alloc(0);
      const newContent = store.getObject(repo, newEntry.oid)?.content ?? Buffer.alloc(0);
      changes.push({
        path,
        status: 'modified',
        oldOid: oldEntry.oid,
        newOid: newEntry.oid,
        additions: addedLines(oldContent, newContent),
        deletions: addedLines(newContent, oldContent),
      });
    }
  }
  return changes;
}

/** The file-level difference between two commits (null = empty tree). */
export function diffCommits(store: Store, repo: Repo, oldSha: string | null, newSha: string | null): FileChange[] {
  const oldFiles = oldSha === null ? new Map() : store.filesAtCommit(repo, oldSha);
  const newFiles = newSha === null ? new Map() : store.filesAtCommit(repo, newSha);
  return diffFileMaps(store, repo, oldFiles, newFiles);
}

/**
 * Squash-merge a pull request onto its base branch. Returns the merge commit
 * sha, or a conflict reason. The merge commit's tree is the base tip's tree
 * with the head's changes (since the merge base) applied; a path changed on
 * both sides to different contents is a conflict.
 */
export function squashMerge(
  store: Store,
  repo: Repo,
  pull: Pull,
): { ok: true; sha: string } | { ok: false; reason: string } {
  const baseTip = store.refOfBranch(repo, pull.baseRef);
  const headTip = store.refOfBranch(repo, pull.headRef);
  if (baseTip === null || headTip === null) return { ok: false, reason: 'the head or base branch is gone' };
  if (pull.state !== 'open') return { ok: false, reason: 'the pull request is already closed' };
  const baseFiles = store.filesAtCommit(repo, baseTip);
  const headChanges = diffCommits(store, repo, pull.mergeBaseSha, headTip);
  const baseChanges = diffCommits(store, repo, pull.mergeBaseSha, baseTip);
  const baseChanged = new Map(baseChanges.map((change) => [change.path, change]));
  for (const change of headChanges) {
    const other = baseChanged.get(change.path);
    if (other === undefined) continue;
    if (other.newOid !== change.newOid) {
      return { ok: false, reason: `merge conflict in ${change.path}` };
    }
  }
  // Apply the head's changes onto the base tip's tree.
  const merged = new Map<string, Buffer>();
  for (const [path, entry] of baseFiles) {
    const obj = store.getObject(repo, entry.oid);
    if (obj !== null) merged.set(path, obj.content);
  }
  for (const change of headChanges) {
    if (change.newOid === null) merged.delete(change.path);
    else {
      const obj = store.getObject(repo, change.newOid);
      if (obj !== null) merged.set(change.path, obj.content);
    }
  }
  const tree = store.buildTree(repo, merged);
  const sha = store.makeCommit(repo, {
    tree,
    parents: [baseTip],
    message: `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}`,
  });
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = store.nowIso();
  pull.mergeCommitSha = sha;
  pull.updatedAt = store.nowIso();
  return { ok: true, sha };
}

/** Whether a pull request would merge cleanly right now (for mergeable). */
export function mergeableState(store: Store, repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pull.state !== 'open') return 'UNKNOWN';
  const baseTip = store.refOfBranch(repo, pull.baseRef);
  const headTip = store.refOfBranch(repo, pull.headRef);
  if (baseTip === null || headTip === null) return 'UNKNOWN';
  const headChanges = diffCommits(store, repo, pull.mergeBaseSha, headTip);
  const baseChanges = diffCommits(store, repo, pull.mergeBaseSha, baseTip);
  const baseChanged = new Map(baseChanges.map((change) => [change.path, change]));
  for (const change of headChanges) {
    const other = baseChanged.get(change.path);
    if (other !== undefined && other.newOid !== change.newOid) return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

// ---------------------------------------------------------------------------
// Issues, pull requests, labels, comments.
// ---------------------------------------------------------------------------

/** Create an issue; returns null when a named label does not exist. */
export function createIssue(
  store: Store,
  repo: Repo,
  input: { title: string; body?: string; labels?: string[] },
): Issue | null {
  const attached: Label[] = [];
  for (const name of input.labels ?? []) {
    const found = repo.labels.find((label) => label.name === name);
    if (found === undefined) return null;
    attached.push(found);
  }
  const now = store.nowIso();
  const issue: Issue = {
    id: store.nextIssueIdValue(),
    number: repo.nextNumber,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    labels: attached,
    comments: [],
    user: store.viewer.login,
    createdAt: now,
    updatedAt: now,
    seq: store.tick(),
  };
  repo.nextNumber += 1;
  repo.issues.push(issue);
  return issue;
}

/** Create a pull request; returns null when a head/base branch is missing. */
export function createPull(
  store: Store,
  repo: Repo,
  input: { title: string; body?: string; head: string; base: string },
): Pull | null {
  const headSha = store.refOfBranch(repo, input.head);
  const baseSha = store.refOfBranch(repo, input.base);
  if (headSha === null || baseSha === null) return null;
  const now = store.nowIso();
  const pull: Pull = {
    id: store.nextPullIdValue(),
    number: repo.nextNumber,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    headRef: input.head,
    baseRef: input.base,
    headSha,
    baseSha,
    mergeBaseSha: baseSha,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    user: store.viewer.login,
    createdAt: now,
    updatedAt: now,
    seq: store.tick(),
  };
  repo.nextNumber += 1;
  repo.pulls.push(pull);
  return pull;
}

/** The global (Relay) id of a repository: opaque, stable, not the database id. */
export function repoGlobalId(repo: Repo): string {
  return Buffer.from(`Repository:${repo.id}`, 'utf8').toString('base64');
}

/** The global id of an issue. */
export function issueGlobalId(repo: Repo, issue: Issue): string {
  return Buffer.from(`Issue:${repo.id}:${issue.number}`, 'utf8').toString('base64');
}

/** The global id of a pull request. */
export function pullGlobalId(repo: Repo, pull: Pull): string {
  return Buffer.from(`PullRequest:${repo.id}:${pull.number}`, 'utf8').toString('base64');
}

/** Decode a global id into its kind and parts, or null when it is not one. */
export function decodeGlobalId(id: string): { kind: string; repoId: number; number: number } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const parts = text.split(':');
    if (parts.length < 2) return null;
    const kind = parts[0] as string;
    const repoId = Number(parts[1]);
    if (!Number.isInteger(repoId)) return null;
    const number = parts.length >= 3 ? Number(parts[2]) : 0;
    return { kind, repoId, number: Number.isInteger(number) ? number : 0 };
  } catch {
    return null;
  }
}

