// http.ts — small shared helpers for the HTTP surface: JSON answers, body
// reading, bearer auth and the request-id header every reply carries.

import type { IncomingMessage, ServerResponse } from 'node:http';

export const JSON_TYPE = 'application/json; charset=utf-8';

let requestCounter = 0;

/** A fresh non-empty request id for the X-GitHub-Request-Id header. */
export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${Date.now().toString(36)}-${requestCounter.toString(36)}`;
}

/** Answer with a JSON body. `status` 204 sends headers only, no body. */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const base: Record<string, string> = {
    'content-type': JSON_TYPE,
    'x-github-request-id': nextRequestId(),
    ...headers,
  };
  if (status === 204) {
    res.writeHead(204, base);
    res.end();
    return;
  }
  const text = `${JSON.stringify(body)}\n`;
  base['content-length'] = String(Buffer.byteLength(text));
  res.writeHead(status, base);
  res.end(text);
}

/** Answer with raw bytes (git smart HTTP). */
export function sendBytes(
  res: ServerResponse,
  status: number,
  body: Buffer,
  contentType: string,
  headers: Readonly<Record<string, string>> = {},
): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(body);
}

/** The path of a request URL, or '/' when it does not parse (never throws). */
export function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/** The parsed query of a request URL, or an empty map when it does not parse. */
export function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/** Read the whole request body, capped at `maxBytes` (0 = unlimited). */
export function readBody(req: IncomingMessage, maxBytes = 64 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export interface JsonRead {
  ok: true;
  value: unknown;
  raw: Buffer;
  empty: boolean;
}

export interface JsonReadFail {
  ok: false;
  error: string;
}

/**
 * Read a request body as JSON. An empty body is `empty: true` (not an error);
 * malformed JSON is an error the caller answers 400 for.
 */
export async function readJsonBody(req: IncomingMessage): Promise<JsonRead | JsonReadFail> {
  let raw: Buffer;
  try {
    raw = await readBody(req);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'could not read body' };
  }
  if (raw.length === 0) return { ok: true, value: undefined, raw, empty: true };
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')) as unknown, raw, empty: false };
  } catch {
    return { ok: false, error: 'malformed JSON body' };
  }
}

/** The bearer token a request presents, or null when it presents none. */
export function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/.exec(header.trim());
  return match === null ? null : (match[1] as string).trim();
}

/** Whether a value is a plain JSON object (not null, not an array). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Decode a path segment that may be percent-encoded; returns null on failure. */
export function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/** Split a pathname into decoded segments, dropping empty ones. */
export function splitPath(path: string): string[] {
  return path
    .split('/')
    .filter((piece) => piece !== '')
    .map((piece) => decodeSegment(piece) ?? piece);
}
