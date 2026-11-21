// graphql.ts — a small GraphQL v4 executor for exactly the documents gh and
// github-mcp-server send: repository/issue/pull-request reads, the four
// mutations, __type introspection, node(id:), cursor pagination and batched
// operation arrays. No library: a hand-rolled tokenizer, recursive-descent
// parser and resolver walk over the shared store.
//
// Field names are validated against the schema below, so an unknown field
// (the suite's invalid-field check) is an HTTP 200 with an errors array
// naming it, never an HTTP error.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  createIssue as storeCreateIssue,
  createPull as storeCreatePull,
  decodeGlobalId,
  diffCommits,
  issueGlobalId,
  mergeableState,
  pullGlobalId,
  repoGlobalId,
  squashMerge,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';
import { bearerToken, isRecord, readJsonBody, sendJson } from './http.ts';

// ---------------------------------------------------------------------------
// schema: the field set of every type (introspection and validation share it)
// ---------------------------------------------------------------------------

const SCHEMA: Readonly<Record<string, readonly string[]>> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'login', 'name', 'email'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef',
    'viewerPermission', 'hasIssuesEnabled', 'description', 'private',
    'createdAt', 'updatedAt', 'url', 'issue', 'issues', 'pullRequests', 'pullRequest',
  ],
  Issue: ['id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'author', 'comments', 'labels', 'url', 'repository'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'headRefName', 'baseRefName',
    'mergeable', 'merged', 'mergedAt', 'files', 'author', 'createdAt',
    'updatedAt', 'url', 'headRef', 'baseRef',
  ],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt'],
  IssueCommentEdge: ['node', 'cursor'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  Ref: ['name', 'target'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description', 'type'],
  __EnumValue: ['name', 'description'],
  __Schema: ['types', 'queryType', 'mutationType'],
};

const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'MILESTONE', 'PROJECT'];

// ---------------------------------------------------------------------------
// tokenizer + parser (the documented subset: operations, variables, fields,
// aliases, arguments, inline fragments; directives are parsed and ignored)
// ---------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'eof' };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():[]!=$@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let value = '';
      i += 1;
      while (i < input.length && input[i] !== '"') {
        if (input[i] === '\\' && i + 1 < input.length) {
          const esc = input[i + 1] as string;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          i += 2;
        } else {
          value += input[i] as string;
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (input[j] === '-') j += 1;
      while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      let isFloat = false;
      if (input[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      }
      const text = input.slice(i, j);
      tokens.push(isFloat ? { kind: 'float', value: Number(text) } : { kind: 'int', value: Number(text) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

export type GqlValue =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: GqlValue[] }
  | { kind: 'object'; fields: Record<string, GqlValue> };

export interface FieldSelection {
  kind: 'field';
  alias: string;
  name: string;
  args: Record<string, GqlValue>;
  selections: Selection[];
}

export interface FragmentSelection {
  kind: 'fragment';
  typeCondition: string | null;
  selections: Selection[];
}

export type Selection = FieldSelection | FragmentSelection;

export interface Operation {
  kind: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variables: { name: string; type: string }[];
  selections: Selection[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected "${value}" in GraphQL document, got ${JSON.stringify(token)}`);
    }
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name in GraphQL document, got ${JSON.stringify(token)}`);
    return token.value;
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.peek().kind !== 'eof') {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  private parseOperation(): Operation {
    let kind: Operation['kind'] = 'query';
    let name: string | null = null;
    const token = this.peek();
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
      kind = this.next().value as Operation['kind'];
      const maybeName = this.peek();
      if (maybeName.kind === 'name') name = this.next().value;
    }
    const variables = this.parseVariableDefinitions();
    const selections = this.parseSelectionSet();
    return { kind, name, variables, selections };
  }

  private parseVariableDefinitions(): { name: string; type: string }[] {
    const variables: { name: string; type: string }[] = [];
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === ')')) {
        this.expectPunct('$');
        const name = this.expectName();
        this.expectPunct(':');
        let type = '';
        for (;;) {
          const token = this.next();
          if (token.kind === 'name') type += token.value;
          else if (token.kind === 'punct' && (token.value === '[' || token.value === ']' || token.value === '!')) type += token.value;
          else throw new Error(`unexpected token in variable type: ${JSON.stringify(token)}`);
          const next = this.peek();
          if (next.kind === 'punct' && (next.value === '=')) {
            // Default value: skip it.
            this.next();
            this.parseValue();
            break;
          }
          if (next.kind === 'punct' && (next.value === ',' || next.value === ')' || next.value === '$')) break;
          if (next.kind === 'name') break;
        }
        variables.push({ name, type });
        const next = this.peek();
        if (next.kind === 'punct' && next.value === ',') this.next();
      }
      this.expectPunct(')');
    }
    return variables;
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): Selection {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '...') {
      this.next();
      let typeCondition: string | null = null;
      const next = this.peek();
      if (next.kind === 'name' && next.value === 'on') {
        this.next();
        typeCondition = this.expectName();
      } else if (next.kind === 'name') {
        // A named fragment spread (not used by the suite's documents).
        this.next();
      }
      this.skipDirectives();
      return { kind: 'fragment', typeCondition, selections: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias = first;
    let name = first;
    const maybeColon = this.peek();
    if (maybeColon.kind === 'punct' && maybeColon.value === ':') {
      this.next();
      name = this.expectName();
    }
    const args = this.parseArguments();
    this.skipDirectives();
    let selections: Selection[] = [];
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '{') {
      selections = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, selections };
  }

  private parseArguments(): Record<string, GqlValue> {
    const args: Record<string, GqlValue> = {};
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === ')')) {
        const name = this.expectName();
        this.expectPunct(':');
        args[name] = this.parseValue();
        const next = this.peek();
        if (next.kind === 'punct' && next.value === ',') this.next();
      }
      this.expectPunct(')');
    }
    return args;
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '@') {
      this.next();
      this.expectName();
      this.parseArguments();
    }
  }

  private parseValue(): GqlValue {
    const token = this.next();
    switch (token.kind) {
      case 'string':
        return { kind: 'string', value: token.value };
      case 'int':
        return { kind: 'int', value: token.value };
      case 'float':
        return { kind: 'float', value: token.value };
      case 'name':
        if (token.value === 'true') return { kind: 'boolean', value: true };
        if (token.value === 'false') return { kind: 'boolean', value: false };
        if (token.value === 'null') return { kind: 'null' };
        return { kind: 'enum', value: token.value };
      case 'punct':
        if (token.value === '$') return { kind: 'var', name: this.expectName() };
        if (token.value === '[') {
          const items: GqlValue[] = [];
          while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === ']')) {
            items.push(this.parseValue());
            const next = this.peek();
            if (next.kind === 'punct' && next.value === ',') this.next();
          }
          this.expectPunct(']');
          return { kind: 'list', items };
        }
        if (token.value === '{') {
          const fields: Record<string, GqlValue> = {};
          while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '}')) {
            const name = this.expectName();
            this.expectPunct(':');
            fields[name] = this.parseValue();
            const next = this.peek();
            if (next.kind === 'punct' && next.value === ',') this.next();
          }
          this.expectPunct('}');
          return { kind: 'object', fields };
        }
        throw new Error(`unexpected punctuation ${JSON.stringify(token.value)} as a value`);
      default:
        throw new Error(`unexpected token as a value: ${JSON.stringify(token)}`);
    }
  }
}

/** Turn a parsed value into a plain JS value, resolving $variables. */
export function valueOf(node: GqlValue, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'var':
      return variables[node.name] ?? null;
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.items.map((item) => valueOf(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node.fields)) out[key] = valueOf(value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------

class GqlFieldError extends Error {}

interface Resolved {
  type: string;
  value: unknown;
}

interface IssueRef {
  repo: Repo;
  issue: Issue;
}

interface PullRef {
  repo: Repo;
  pull: Pull;
}

interface IssueConnectionValue {
  repo: Repo;
  issues: Issue[];
  first: number | null;
  after: number | null;
}

interface PullConnectionValue {
  repo: Repo;
  pulls: Pull[];
  first: number | null;
  after: number | null;
}

interface FileConnectionValue {
  repo: Repo;
  pull: Pull;
  first: number | null;
}

interface TypeInfoValue {
  name: string;
  kind: string;
  fields: string[];
  enumValues: string[];
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function numberAfterCursor(cursor: string | null | undefined): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

function gqlState(state: 'open' | 'closed'): string {
  return state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullGqlState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function sortIssues(issues: Issue[], orderBy: { field?: unknown; direction?: unknown } | null): Issue[] {
  const sorted = issues.slice();
  const direction = orderBy?.direction === 'ASC' ? 1 : -1;
  sorted.sort((a, b) => {
    if (a.createdAt !== b.createdAt) return direction * (a.createdAt < b.createdAt ? -1 : 1);
    return direction * (a.number - b.number);
  });
  return sorted;
}

function resolveField(
  store: Store,
  typeName: string,
  value: unknown,
  field: FieldSelection,
  variables: Record<string, unknown>,
): Resolved | null {
  const args: Record<string, unknown> = {};
  for (const [key, node] of Object.entries(field.args)) args[key] = valueOf(node, variables);

  switch (typeName) {
    case 'Query': {
      if (field.name === 'viewer') return { type: 'User', value: store.viewer };
      if (field.name === 'repository') {
        const owner = args.owner as string;
        const name = args.name as string;
        if (owner !== store.viewer.login) return null;
        const repo = store.getRepo(owner, name);
        return repo === null ? null : { type: 'Repository', value: repo };
      }
      if (field.name === 'node') {
        const decoded = decodeGlobalId(String(args.id ?? ''));
        if (decoded === null) return null;
        const repo = store.getRepoById(decoded.repoId);
        if (repo === null) return null;
        if (decoded.kind === 'Repository') return { type: 'Repository', value: repo };
        if (decoded.kind === 'Issue') {
          const issue = repo.issues.find((entry) => entry.number === decoded.number);
          return issue === undefined ? null : { type: 'Issue', value: { repo, issue } satisfies IssueRef };
        }
        if (decoded.kind === 'PullRequest') {
          const pull = repo.pulls.find((entry) => entry.number === decoded.number);
          return pull === undefined ? null : { type: 'PullRequest', value: { repo, pull } satisfies PullRef };
        }
        return null;
      }
      if (field.name === '__type') {
        const name = String(args.name ?? '');
        if (name === 'SearchType') {
          return { type: '__Type', value: { name, kind: 'ENUM', fields: [], enumValues: SEARCH_TYPE_VALUES } satisfies TypeInfoValue };
        }
        const fields = SCHEMA[name];
        if (fields === undefined) {
          if (['String', 'Int', 'Float', 'Boolean', 'ID'].includes(name)) {
            return { type: '__Type', value: { name, kind: 'SCALAR', fields: [], enumValues: [] } satisfies TypeInfoValue };
          }
          return null;
        }
        return { type: '__Type', value: { name, kind: 'OBJECT', fields: [...fields], enumValues: [] } satisfies TypeInfoValue };
      }
      if (field.name === '__schema') {
        return { type: '__Schema', value: {} };
      }
      return null;
    }
    case 'Mutation': {
      if (field.name === 'createIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
        if (decoded === null || decoded.kind !== 'Repository') throw new GqlFieldError('createIssue: the repositoryId does not name a repository');
        const repo = store.getRepoById(decoded.repoId);
        if (repo === null) throw new GqlFieldError('createIssue: the repositoryId does not name a repository');
        const issue = storeCreateIssue(store, repo, {
          title: String(input.title ?? ''),
          body: typeof input.body === 'string' ? input.body : '',
        });
        if (issue === null) throw new GqlFieldError('createIssue: a label does not exist');
        return { type: 'CreateIssuePayload', value: { issue: { repo, issue } satisfies IssueRef } };
      }
      if (field.name === 'closeIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeGlobalId(String(input.issueId ?? ''));
        if (decoded === null || decoded.kind !== 'Issue') throw new GqlFieldError('closeIssue: the issueId does not name an issue');
        const repo = store.getRepoById(decoded.repoId);
        const issue = repo?.issues.find((entry) => entry.number === decoded.number);
        if (repo === undefined || repo === null || issue === undefined) throw new GqlFieldError('closeIssue: the issueId does not name an issue');
        issue.state = 'closed';
        issue.updatedAt = store.nowIso();
        return { type: 'CloseIssuePayload', value: { issue: { repo, issue } satisfies IssueRef } };
      }
      if (field.name === 'createPullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
        if (decoded === null || decoded.kind !== 'Repository') throw new GqlFieldError('createPullRequest: the repositoryId does not name a repository');
        const repo = store.getRepoById(decoded.repoId);
        if (repo === null) throw new GqlFieldError('createPullRequest: the repositoryId does not name a repository');
        const pull = storeCreatePull(store, repo, {
          title: String(input.title ?? ''),
          body: typeof input.body === 'string' ? input.body : '',
          head: String(input.headRefName ?? ''),
          base: String(input.baseRefName ?? ''),
        });
        if (pull === null) throw new GqlFieldError('createPullRequest: the head or base branch does not exist');
        return { type: 'CreatePullRequestPayload', value: { pull: { repo, pull } satisfies PullRef } };
      }
      if (field.name === 'mergePullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
        if (decoded === null || decoded.kind !== 'PullRequest') throw new GqlFieldError('mergePullRequest: the pullRequestId does not name a pull request');
        const repo = store.getRepoById(decoded.repoId);
        const pull = repo?.pulls.find((entry) => entry.number === decoded.number);
        if (repo === undefined || repo === null || pull === undefined) throw new GqlFieldError('mergePullRequest: the pullRequestId does not name a pull request');
        const result = squashMerge(store, repo, pull);
        if (!result.ok) throw new GqlFieldError(`mergePullRequest: ${result.reason}`);
        return { type: 'MergePullRequestPayload', value: { pull: { repo, pull } satisfies PullRef } };
      }
      if (field.name === 'addComment') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = decodeGlobalId(String(input.subjectId ?? ''));
        if (decoded === null || decoded.kind !== 'Issue') throw new GqlFieldError('addComment: the subjectId does not name an issue');
        const repo = store.getRepoById(decoded.repoId);
        const issue = repo?.issues.find((entry) => entry.number === decoded.number);
        if (repo === undefined || repo === null || issue === undefined) throw new GqlFieldError('addComment: the subjectId does not name an issue');
        const now = store.nowIso();
        const comment = {
          id: store.nextCommentIdValue(),
          body: String(input.body ?? ''),
          user: store.viewer.login,
          createdAt: now,
          updatedAt: now,
        };
        issue.comments.push(comment);
        issue.updatedAt = now;
        return {
          type: 'AddCommentPayload',
          value: { commentEdge: { node: { id: Buffer.from(`IssueComment:${repo.id}:${comment.id}`, 'utf8').toString('base64'), body: comment.body } } },
        };
      }
      return null;
    }
    case 'User': {
      const user = value as { login: string; id: number; name: string; email: string };
      if (field.name === 'id') return { type: 'ID', value: String(user.id) };
      if (field.name === 'login') return { type: 'String', value: user.login };
      if (field.name === 'name') return { type: 'String', value: user.name };
      if (field.name === 'email') return { type: 'String', value: user.email };
      return null;
    }
    case 'Repository': {
      const repo = value as Repo;
      if (field.name === 'id') return { type: 'ID', value: repoGlobalId(repo) };
      if (field.name === 'databaseId') return { type: 'Int', value: repo.id };
      if (field.name === 'name') return { type: 'String', value: repo.name };
      if (field.name === 'nameWithOwner') return { type: 'String', value: `${repo.owner}/${repo.name}` };
      if (field.name === 'owner') return { type: 'User', value: store.viewer };
      if (field.name === 'defaultBranchRef') {
        const sha = store.refOfBranch(repo, repo.defaultBranch);
        return sha === null ? null : { type: 'Ref', value: { name: repo.defaultBranch } };
      }
      if (field.name === 'viewerPermission') return { type: 'String', value: 'ADMIN' };
      if (field.name === 'hasIssuesEnabled') return { type: 'Boolean', value: true };
      if (field.name === 'description') return { type: 'String', value: repo.description };
      if (field.name === 'private') return { type: 'Boolean', value: repo.isPrivate };
      if (field.name === 'createdAt') return { type: 'String', value: repo.createdAt };
      if (field.name === 'updatedAt') return { type: 'String', value: repo.updatedAt };
      if (field.name === 'url') return { type: 'String', value: `https://github.example/${repo.owner}/${repo.name}` };
      if (field.name === 'issue') {
        const number = Number(args.number);
        const issue = repo.issues.find((entry) => entry.number === number);
        return issue === undefined ? null : { type: 'Issue', value: { repo, issue } satisfies IssueRef };
      }
      if (field.name === 'issues') {
        const states = Array.isArray(args.states) ? (args.states as string[]) : null;
        let issues = repo.issues.slice();
        if (states !== null) {
          const wanted = new Set(states.map((state) => String(state).toUpperCase()));
          issues = issues.filter((issue) => wanted.has(gqlState(issue.state)));
        }
        issues = sortIssues(issues, (args.orderBy ?? null) as { field?: unknown; direction?: unknown } | null);
        return {
          type: 'IssueConnection',
          value: {
            repo,
            issues,
            first: typeof args.first === 'number' ? args.first : null,
            after: numberAfterCursor(args.after as string | null | undefined),
          } satisfies IssueConnectionValue,
        };
      }
      if (field.name === 'pullRequests') {
        const pulls = repo.pulls.filter((pull) => pull.state === 'open');
        return {
          type: 'PullRequestConnection',
          value: {
            repo,
            pulls,
            first: typeof args.first === 'number' ? args.first : null,
            after: numberAfterCursor(args.after as string | null | undefined),
          } satisfies PullConnectionValue,
        };
      }
      if (field.name === 'pullRequest') {
        const number = Number(args.number);
        const pull = repo.pulls.find((entry) => entry.number === number);
        return pull === undefined ? null : { type: 'PullRequest', value: { repo, pull } satisfies PullRef };
      }
      return null;
    }
    case 'Issue': {
      const ref = value as IssueRef;
      const { repo, issue } = ref;
      if (field.name === 'id') return { type: 'ID', value: issueGlobalId(repo, issue) };
      if (field.name === 'number') return { type: 'Int', value: issue.number };
      if (field.name === 'title') return { type: 'String', value: issue.title };
      if (field.name === 'body') return { type: 'String', value: issue.body };
      if (field.name === 'state') return { type: 'String', value: gqlState(issue.state) };
      if (field.name === 'createdAt') return { type: 'String', value: issue.createdAt };
      if (field.name === 'updatedAt') return { type: 'String', value: issue.updatedAt };
      if (field.name === 'author') return { type: 'User', value: store.viewer };
      if (field.name === 'labels') {
        return { type: 'LabelList', value: issue.labels.map((label) => ({ name: label.name, color: label.color })) };
      }
      if (field.name === 'comments') {
        return { type: 'IssueCommentConnection', value: { nodes: issue.comments } };
      }
      if (field.name === 'url') return { type: 'String', value: `https://github.example/${repo.owner}/${repo.name}/issues/${issue.number}` };
      if (field.name === 'repository') return { type: 'Repository', value: repo };
      return null;
    }
    case 'PullRequest': {
      const ref = value as PullRef;
      const { repo, pull } = ref;
      if (field.name === 'id') return { type: 'ID', value: pullGlobalId(repo, pull) };
      if (field.name === 'number') return { type: 'Int', value: pull.number };
      if (field.name === 'title') return { type: 'String', value: pull.title };
      if (field.name === 'body') return { type: 'String', value: pull.body };
      if (field.name === 'state') return { type: 'String', value: pullGqlState(pull) };
      if (field.name === 'headRefName') return { type: 'String', value: pull.headRef };
      if (field.name === 'baseRefName') return { type: 'String', value: pull.baseRef };
      if (field.name === 'mergeable') return { type: 'String', value: mergeableState(store, repo, pull) };
      if (field.name === 'merged') return { type: 'Boolean', value: pull.merged };
      if (field.name === 'mergedAt') return { type: 'String', value: pull.mergedAt };
      if (field.name === 'files') {
        return {
          type: 'PullRequestFileConnection',
          value: { repo, pull, first: typeof args.first === 'number' ? args.first : null } satisfies FileConnectionValue,
        };
      }
      if (field.name === 'author') return { type: 'User', value: store.viewer };
      if (field.name === 'createdAt') return { type: 'String', value: pull.createdAt };
      if (field.name === 'updatedAt') return { type: 'String', value: pull.updatedAt };
      if (field.name === 'url') return { type: 'String', value: `https://github.example/${repo.owner}/${repo.name}/pull/${pull.number}` };
      if (field.name === 'headRef') return { type: 'Ref', value: { name: pull.headRef } };
      if (field.name === 'baseRef') return { type: 'Ref', value: { name: pull.baseRef } };
      return null;
    }
    case 'IssueConnection': {
      const conn = value as IssueConnectionValue;
      const after = conn.after;
      let items = conn.issues;
      // The cursor names the last item of the previous page; the next page
      // is everything after it in the connection's own order (the sort is
      // DESC here, so a numeric comparison would run backwards).
      if (after !== null) {
        const at = items.findIndex((issue) => issue.number === after);
        items = at >= 0 ? items.slice(at + 1) : items;
      }
      const total = items.length;
      const first = conn.first;
      const page = first === null ? items : items.slice(0, first);
      if (field.name === 'nodes') {
        return { type: 'IssueList', value: page.map((issue) => ({ repo: conn.repo, issue }) satisfies IssueRef) };
      }
      if (field.name === 'edges') {
        return { type: 'IssueEdgeList', value: page.map((issue) => ({ node: { repo: conn.repo, issue } satisfies IssueRef, cursor: cursorFor(issue.number) })) };
      }
      if (field.name === 'pageInfo') {
        const hasNext = first !== null && total > first;
        return {
          type: 'PageInfo',
          value: {
            hasNextPage: hasNext,
            hasPreviousPage: after !== null,
            startCursor: page.length > 0 ? cursorFor((page[0] as Issue).number) : null,
            endCursor: page.length > 0 ? cursorFor((page[page.length - 1] as Issue).number) : null,
          },
        };
      }
      if (field.name === 'totalCount') return { type: 'Int', value: conn.issues.length };
      return null;
    }
    case 'PullRequestConnection': {
      const conn = value as PullConnectionValue;
      const after = conn.after;
      let items = conn.pulls;
      if (after !== null) {
        const at = items.findIndex((pull) => pull.number === after);
        items = at >= 0 ? items.slice(at + 1) : items;
      }
      const total = items.length;
      const first = conn.first;
      const page = first === null ? items : items.slice(0, first);
      if (field.name === 'nodes') {
        return { type: 'PullRequestList', value: page.map((pull) => ({ repo: conn.repo, pull }) satisfies PullRef) };
      }
      if (field.name === 'edges') {
        return { type: 'PullRequestEdgeList', value: page.map((pull) => ({ node: { repo: conn.repo, pull } satisfies PullRef, cursor: cursorFor(pull.number) })) };
      }
      if (field.name === 'pageInfo') {
        const hasNext = first !== null && total > first;
        return {
          type: 'PageInfo',
          value: {
            hasNextPage: hasNext,
            hasPreviousPage: after !== null,
            startCursor: page.length > 0 ? cursorFor((page[0] as Pull).number) : null,
            endCursor: page.length > 0 ? cursorFor((page[page.length - 1] as Pull).number) : null,
          },
        };
      }
      if (field.name === 'totalCount') return { type: 'Int', value: conn.pulls.length };
      return null;
    }
    case 'PullRequestFileConnection': {
      const conn = value as FileConnectionValue;
      const headTip = store.refOfBranch(conn.repo, conn.pull.headRef);
      const changes = headTip === null ? [] : diffCommits(store, conn.repo, conn.pull.mergeBaseSha, headTip);
      const first = conn.first;
      const page = first === null ? changes : changes.slice(0, first);
      if (field.name === 'nodes') {
        return { type: 'PullRequestFileList', value: page.map((change) => ({ path: change.path, additions: change.additions, deletions: change.deletions, changeType: change.status })) };
      }
      if (field.name === 'edges') {
        return { type: 'PullRequestFileEdgeList', value: page.map((change) => ({ node: { path: change.path }, cursor: cursorFor(0) })) };
      }
      if (field.name === 'pageInfo') {
        return { type: 'PageInfo', value: { hasNextPage: first !== null && changes.length > first, hasPreviousPage: false, startCursor: null, endCursor: null } };
      }
      if (field.name === 'totalCount') return { type: 'Int', value: changes.length };
      return null;
    }
    case 'PullRequestChangedFile': {
      const file = value as { path: string; additions: number; deletions: number; changeType: string };
      if (field.name === 'path') return { type: 'String', value: file.path };
      if (field.name === 'additions') return { type: 'Int', value: file.additions };
      if (field.name === 'deletions') return { type: 'Int', value: file.deletions };
      if (field.name === 'changeType') return { type: 'String', value: file.changeType.toUpperCase() };
      return null;
    }
    case 'IssueCommentEdge': {
      const edge = value as { node: { id: string; body: string } };
      if (field.name === 'node') return { type: 'IssueComment', value: edge.node };
      if (field.name === 'cursor') return { type: 'String', value: '' };
      return null;
    }
    case 'IssueComment': {
      const comment = value as { id: string; body: string };
      if (field.name === 'id') return { type: 'ID', value: comment.id };
      if (field.name === 'body') return { type: 'String', value: comment.body };
      if (field.name === 'author') return { type: 'User', value: store.viewer };
      if (field.name === 'createdAt' || field.name === 'updatedAt') return { type: 'String', value: store.nowIso() };
      return null;
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      const payload = value as { issue: IssueRef };
      if (field.name === 'issue') return { type: 'Issue', value: payload.issue };
      if (field.name === 'clientMutationId') return { type: 'String', value: null };
      return null;
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      const payload = value as { pull: PullRef };
      if (field.name === 'pullRequest') return { type: 'PullRequest', value: payload.pull };
      if (field.name === 'clientMutationId') return { type: 'String', value: null };
      return null;
    }
    case 'AddCommentPayload': {
      const payload = value as { commentEdge: { node: { id: string; body: string } } };
      if (field.name === 'commentEdge') return { type: 'IssueCommentEdge', value: payload.commentEdge };
      if (field.name === 'clientMutationId') return { type: 'String', value: null };
      return null;
    }
    case 'Ref': {
      const ref = value as { name: string };
      if (field.name === 'name') return { type: 'String', value: ref.name };
      if (field.name === 'target') return { type: 'String', value: null };
      return null;
    }
    case 'PageInfo': {
      const info = value as { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null };
      if (field.name === 'hasNextPage') return { type: 'Boolean', value: info.hasNextPage };
      if (field.name === 'hasPreviousPage') return { type: 'Boolean', value: info.hasPreviousPage };
      if (field.name === 'startCursor') return { type: 'String', value: info.startCursor };
      if (field.name === 'endCursor') return { type: 'String', value: info.endCursor };
      return null;
    }
    case '__Type': {
      const info = value as TypeInfoValue;
      if (field.name === 'name') return { type: 'String', value: info.name };
      if (field.name === 'kind') return { type: 'String', value: info.kind };
      if (field.name === 'description') return { type: 'String', value: null };
      if (field.name === 'fields') {
        return { type: '__FieldList', value: info.fields.map((name) => ({ name })) };
      }
      if (field.name === 'enumValues') {
        return { type: '__EnumValueList', value: info.enumValues.map((name) => ({ name })) };
      }
      return null;
    }
    case '__Field': {
      const fieldInfo = value as { name: string };
      if (field.name === 'name') return { type: 'String', value: fieldInfo.name };
      if (field.name === 'description') return { type: 'String', value: null };
      if (field.name === 'type') return { type: 'String', value: null };
      return null;
    }
    case '__EnumValue': {
      const enumInfo = value as { name: string };
      if (field.name === 'name') return { type: 'String', value: enumInfo.name };
      if (field.name === 'description') return { type: 'String', value: null };
      return null;
    }
    case '__Schema': {
      if (field.name === 'types') return { type: '__TypeList', value: [] };
      if (field.name === 'queryType') return { type: '__Type', value: { name: 'Query', kind: 'OBJECT', fields: [...(SCHEMA.Query ?? [])], enumValues: [] } satisfies TypeInfoValue };
      if (field.name === 'mutationType') return { type: '__Type', value: { name: 'Mutation', kind: 'OBJECT', fields: [...(SCHEMA.Mutation ?? [])], enumValues: [] } satisfies TypeInfoValue };
      return null;
    }
    default:
      return null;
  }
}

/** The GraphQL type of a list wrapper, for element resolution. */
function elementTypeOf(listType: string): string {
  switch (listType) {
    case 'IssueList':
      return 'Issue';
    case 'PullRequestList':
      return 'PullRequest';
    case 'PullRequestFileList':
      return 'PullRequestChangedFile';
    case '__FieldList':
      return '__Field';
    case '__EnumValueList':
      return '__EnumValue';
    case '__TypeList':
      return '__Type';
    case 'LabelList':
      return 'Label';
    default:
      return 'String';
  }
}

function executeSelections(
  store: Store,
  typeName: string,
  value: unknown,
  selections: Selection[],
  variables: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition !== null && selection.typeCondition !== typeName) continue;
      Object.assign(out, executeSelections(store, typeName, value, selection.selections, variables));
      continue;
    }
    if (selection.name === '__typename') {
      out[selection.alias] = typeName;
      continue;
    }
    const allowed = SCHEMA[typeName];
    if (allowed !== undefined && !allowed.includes(selection.name)) {
      throw new GqlFieldError(`Cannot query field "${selection.name}" on type "${typeName}".`);
    }
    const resolved = resolveField(store, typeName, value, selection, variables);
    if (resolved === null) {
      out[selection.alias] = null;
      continue;
    }
    out[selection.alias] = executeValue(store, resolved, selection.selections, variables);
  }
  return out;
}

function executeValue(
  store: Store,
  resolved: Resolved,
  selections: Selection[],
  variables: Record<string, unknown>,
): unknown {
  const { type, value } = resolved;
  if (value === null || value === undefined) return null;
  if (selections.length === 0) return value;
  if (type === 'IssueList' || type === 'PullRequestList' || type === 'PullRequestFileList' || type === '__FieldList' || type === '__EnumValueList' || type === '__TypeList') {
    const elementType = elementTypeOf(type);
    return (value as unknown[]).map((item) => executeSelections(store, elementType, item, selections, variables));
  }
  if (type === 'IssueEdgeList' || type === 'PullRequestEdgeList' || type === 'PullRequestFileEdgeList') {
    const elementType = type === 'IssueEdgeList' ? 'IssueEdge' : type === 'PullRequestEdgeList' ? 'PullRequestEdge' : 'PullRequestFileEdge';
    return (value as unknown[]).map((item) => {
      const edge = item as { node: unknown; cursor: string };
      const out: Record<string, unknown> = {};
      for (const selection of selections) {
        if (selection.kind === 'fragment') continue;
        if (selection.name === 'node') {
          const nodeType = elementType === 'IssueEdge' ? 'Issue' : elementType === 'PullRequestEdge' ? 'PullRequest' : 'PullRequestChangedFile';
          out[selection.alias] = executeSelections(store, nodeType, edge.node, selection.selections, variables);
        } else if (selection.name === 'cursor') {
          out[selection.alias] = edge.cursor;
        }
      }
      return out;
    });
  }
  if (type === 'LabelList') {
    return (value as { name: string; color: string }[]).map((label) => {
      const out: Record<string, unknown> = {};
      for (const selection of selections) {
        if (selection.kind === 'fragment') continue;
        if (selection.name === 'name') out[selection.alias] = label.name;
        else if (selection.name === 'color') out[selection.alias] = label.color;
      }
      return out;
    });
  }
  if (type === 'IssueCommentConnection') {
    const conn = value as { nodes: { id: number; body: string }[] };
    const out: Record<string, unknown> = {};
    for (const selection of selections) {
      if (selection.kind === 'fragment') continue;
      if (selection.name === 'nodes') {
        out[selection.alias] = conn.nodes.map((comment) =>
          executeSelections(store, 'IssueComment', { id: String(comment.id), body: comment.body }, selection.selections, variables),
        );
      }
    }
    return out;
  }
  return executeSelections(store, type, value, selections, variables);
}

export interface GqlExecution {
  data: Record<string, unknown> | null;
  errors: { message: string }[];
}

export function executeOperation(store: Store, operation: Operation, variables: Record<string, unknown>): GqlExecution {
  try {
    if (operation.kind === 'subscription') {
      return { data: null, errors: [{ message: 'subscriptions are not supported' }] };
    }
    const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
    const data = executeSelections(store, rootType, {}, operation.selections, variables);
    return { data, errors: [] };
  } catch (err) {
    if (err instanceof GqlFieldError) return { data: null, errors: [{ message: err.message }] };
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
}

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

export async function handleGraphQL(store: Store, token: string, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  let path = '/';
  try {
    path = new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    path = '/';
  }
  if (path !== '/api/graphql') return false;
  if (req.method !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return true;
  }
  const presented = bearerToken(req);
  const authed = presented !== null && presented !== '' && (token === '' || presented === token);
  if (!authed) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return true;
  }
  const read = await readJsonBody(req);
  if (!read.ok) {
    sendJson(res, 400, { message: read.error });
    return true;
  }
  const runOne = (body: unknown): GqlExecution | { error: string } => {
    if (!isRecord(body) || typeof body.query !== 'string') return { error: 'a query document is required' };
    const variables = isRecord(body.variables) ? (body.variables as Record<string, unknown>) : {};
    let operations: Operation[];
    try {
      operations = new Parser(tokenize(body.query)).parseDocument();
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'could not parse the query document' };
    }
    if (operations.length === 0) return { error: 'the document holds no operation' };
    let operation: Operation | undefined;
    if (typeof body.operationName === 'string' && body.operationName !== '') {
      operation = operations.find((entry) => entry.name === body.operationName);
      if (operation === undefined) return { error: `no operation named ${body.operationName}` };
    } else {
      operation = operations[0];
    }
    return executeOperation(store, operation, variables);
  };
  if (Array.isArray(read.value)) {
    const results: unknown[] = [];
    for (const entry of read.value) {
      const result = runOne(entry);
      if ('error' in result) {
        sendJson(res, 400, { message: result.error });
        return true;
      }
      results.push(result.errors.length > 0 ? { data: result.data, errors: result.errors } : { data: result.data });
    }
    sendJson(res, 200, results);
    return true;
  }
  const result = runOne(read.value);
  if ('error' in result) {
    sendJson(res, 400, { message: result.error });
    return true;
  }
  sendJson(res, 200, result.errors.length > 0 ? { data: result.data, errors: result.errors } : { data: result.data });
  return true;
}
