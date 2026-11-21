// mcp.ts — Model Context Protocol over streamable HTTP (the 2026-07-28
// revision): server/discover, initialize, tools/list and tools/call, with
// the six github-mcp-server tools, all on the shared store so an MCP
// repository or issue is the same object the REST view reads.
//
// Answers are plain JSON bodies (not SSE); a body that is not JSON is an
// HTTP 400 with JSON-RPC -32700; an unknown tool is -32602; a missing
// required argument is a tool result with isError: true; no Authorization
// header is an HTTP 401 before any method runs.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  createIssue as storeCreateIssue,
  createPull as storeCreatePull,
  squashMerge,
  type Repo,
  type Store,
} from './store.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';
import { bearerToken, isRecord, readBody, sendJson } from './http.ts';

const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login that will own the repository.' },
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash) into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const TOOL_REQUIRED: Record<string, string[]> = {
  create_repo: ['name'],
  get_repo: ['owner', 'repo'],
  create_issue: ['owner', 'repo', 'title'],
  list_issues: ['owner', 'repo'],
  create_pull_request: ['owner', 'repo', 'title', 'head', 'base'],
  merge_pull_request: ['owner', 'repo', 'pull_number'],
};

/** Read an argument by any of its accepted names. */
function pickArg(args: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) {
    if (args[name] !== undefined && args[name] !== null) return args[name];
  }
  return undefined;
}

function strArg(args: Record<string, unknown>, ...names: string[]): string {
  const value = pickArg(args, ...names);
  return typeof value === 'string' ? value : '';
}

interface ToolOutcome {
  ok: boolean;
  result: unknown;
}

/** Run one tool against the store; `ok: false` becomes an isError result. */
function runTool(store: Store, name: string, args: Record<string, unknown>): ToolOutcome {
  const viewer = store.viewer.login;
  switch (name) {
    case 'create_repo': {
      const repoName = strArg(args, 'name', 'repo', 'repository');
      if (repoName === '') return { ok: false, result: 'name is required' };
      const repo = store.createRepo(viewer, repoName, {
        description: strArg(args, 'description', 'about', 'summary'),
        isPrivate: pickArg(args, 'private', 'is_private') === true,
      });
      if (repo === null) return { ok: false, result: `repository ${repoName} already exists` };
      return { ok: true, result: repoJson(store, repo) };
    }
    case 'get_repo': {
      const repo = store.getRepo(strArg(args, 'owner', 'owner_login', 'login'), strArg(args, 'repo', 'repository', 'name'));
      if (repo === null) return { ok: false, result: 'repository not found' };
      return { ok: true, result: repoJson(store, repo) };
    }
    case 'create_issue': {
      const repo = store.getRepo(strArg(args, 'owner', 'owner_login', 'login'), strArg(args, 'repo', 'repository', 'name'));
      if (repo === null) return { ok: false, result: 'repository not found' };
      const title = strArg(args, 'title', 'issue_title');
      if (title === '') return { ok: false, result: 'title is required' };
      const issue = storeCreateIssue(store, repo, { title, body: strArg(args, 'body', 'issue_body', 'description', 'content') });
      if (issue === null) return { ok: false, result: 'a label does not exist in this repository' };
      return { ok: true, result: issueJson(store, repo, issue) };
    }
    case 'list_issues': {
      const repo = store.getRepo(strArg(args, 'owner', 'owner_login', 'login'), strArg(args, 'repo', 'repository', 'name'));
      if (repo === null) return { ok: false, result: 'repository not found' };
      const state = strArg(args, 'state', 'status') || 'open';
      let issues = repo.issues.slice();
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      return { ok: true, result: issues.map((issue) => issueJson(store, repo, issue)) };
    }
    case 'create_pull_request': {
      const repo = store.getRepo(strArg(args, 'owner', 'owner_login', 'login'), strArg(args, 'repo', 'repository', 'name'));
      if (repo === null) return { ok: false, result: 'repository not found' };
      const pull = storeCreatePull(store, repo, {
        title: strArg(args, 'title', 'pr_title'),
        body: strArg(args, 'body', 'description', 'content'),
        head: strArg(args, 'head', 'head_ref', 'head_branch'),
        base: strArg(args, 'base', 'base_ref', 'base_branch'),
      });
      if (pull === null) return { ok: false, result: 'the head or base branch does not exist' };
      return { ok: true, result: pullJson(store, repo, pull) };
    }
    case 'merge_pull_request': {
      const repo = store.getRepo(strArg(args, 'owner', 'owner_login', 'login'), strArg(args, 'repo', 'repository', 'name'));
      if (repo === null) return { ok: false, result: 'repository not found' };
      const number = Number(pickArg(args, 'pull_number', 'pull_request_number', 'pr_number', 'number'));
      const pull = repo.pulls.find((entry) => entry.number === number);
      if (pull === undefined) return { ok: false, result: `pull request #${number} not found` };
      const result = squashMerge(store, repo, pull);
      if (!result.ok) return { ok: false, result: result.reason };
      return { ok: true, result: { merged: true, sha: result.sha, number: pull.number, message: 'Pull request successfully merged' } };
    }
    default:
      return { ok: false, result: `unknown tool ${name}` };
  }
}

function rpcResult(res: ServerResponse, id: unknown, result: unknown): void {
  sendJson(res, 200, { jsonrpc: '2.0', id, result });
}

function rpcError(res: ServerResponse, status: number, id: unknown, code: number, message: string): void {
  sendJson(res, status, { jsonrpc: '2.0', id, error: { code, message } });
}

export async function handleMcp(store: Store, token: string, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  let path = '/';
  try {
    path = new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    path = '/';
  }
  if (path !== '/mcp') return false;
  if (req.method === 'DELETE') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return true;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return true;
  }
  const presented = bearerToken(req);
  const authed = presented !== null && presented !== '' && (token === '' || presented === token);
  if (!authed) {
    sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Requires authentication' } });
    return true;
  }
  let raw: Buffer;
  try {
    raw = await readBody(req, 1024 * 1024);
  } catch {
    sendJson(res, 400, { message: 'could not read request body' });
    return true;
  }
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    rpcError(res, 400, null, -32700, 'Parse error');
    return true;
  }
  if (!isRecord(body) || typeof body.method !== 'string') {
    rpcError(res, 200, isRecord(body) ? (body.id ?? null) : null, -32600, 'Invalid Request');
    return true;
  }
  const id = body.id ?? null;
  const params = isRecord(body.params) ? body.params : {};
  // A notification (no id) gets no JSON-RPC answer: HTTP 202, empty body.
  if (body.id === undefined) {
    res.writeHead(202, { 'x-github-request-id': `req-${Date.now().toString(36)}` });
    res.end();
    return true;
  }
  switch (body.method) {
    case 'server/discover': {
      const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
      rpcResult(res, id, {
        resultType: 'discover',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo,
        _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
      });
      return true;
    }
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const negotiated = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
      rpcResult(res, id, {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
      return true;
    }
    case 'tools/list': {
      rpcResult(res, id, { tools: TOOLS });
      return true;
    }
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
      const tool = TOOLS.find((entry) => entry.name === name);
      if (tool === undefined) {
        rpcError(res, 200, id, -32602, `unknown tool "${name}"`);
        return true;
      }
      const required = TOOL_REQUIRED[name] ?? [];
      const missing = required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
      if (missing.length > 0) {
        rpcResult(res, id, {
          content: [{ type: 'text', text: `missing required argument(s): ${missing.join(', ')}` }],
          isError: true,
        });
        return true;
      }
      const outcome = runTool(store, name, args);
      if (!outcome.ok) {
        rpcResult(res, id, {
          content: [{ type: 'text', text: typeof outcome.result === 'string' ? outcome.result : JSON.stringify(outcome.result) }],
          isError: true,
        });
        return true;
      }
      rpcResult(res, id, {
        content: [{ type: 'text', text: JSON.stringify(outcome.result) }],
        structuredContent: outcome.result,
      });
      return true;
    }
    case 'ping': {
      rpcResult(res, id, {});
      return true;
    }
    default: {
      rpcError(res, 200, id, -32601, `method not found: ${body.method}`);
      return true;
    }
  }
}

export { type Repo };
