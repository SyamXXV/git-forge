// app.ts — the forge HTTP application: one Store, one router.
//
// GET  /healthz                         -> 200 {ok:true}
// POST /api/graphql                     -> GraphQL (viewer, repository, node,
//                                           __type, and the five mutations)
// POST /mcp                             -> MCP (server/discover, initialize,
//                                           tools/list, tools/call)
// /api/v3/*                             -> REST v3 (see rest.ts)
// /{owner}/{repo}[.git]/{info/refs,git-upload-pack,git-receive-pack}
//                                       -> git smart HTTP (see githttp.ts)
// anything else                         -> 404 JSON {message}

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleGit } from './githttp.ts';
import { sendJson, splitPath } from './http.ts';

export interface App {
  store: Store;
  server: Server;
}

export function createApp(token: string): App {
  const store = new Store();

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://entry');
        const path = url.pathname;

        if (path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        if (await handleGraphQL(store, token, req, res)) return;
        if (await handleMcp(store, token, req, res)) return;
        if (await handleRest(store, token, req, res)) return;

        const segments = splitPath(path);
        if (segments.length >= 3 && (segments[2] === 'info' || segments[2] === 'git-upload-pack' || segments[2] === 'git-receive-pack')) {
          if (await handleGit(store, req, res, segments, url.searchParams)) return;
        }

        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        if (res.headersSent) {
          res.end();
          return;
        }
        sendJson(res, 500, { message: err instanceof Error ? err.message : 'internal error' });
      }
    })();
  });

  return { store, server };
}
