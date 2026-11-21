// gitproto.ts — the git wire format, by hand: pkt-lines, packfiles (build and
// parse, including OFS_DELTA / REF_DELTA), and the reachability walk a fetch
// needs, with shallow boundaries and haves handled the way a real server
// does (a shallow boundary's parents are not held by the client).

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { parseCommit, parseTree, sha1Object, type Repo, type Store } from './store.ts';

// ---------------------------------------------------------------------------
// pkt-line
// ---------------------------------------------------------------------------

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.alloc(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
export const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');

export function pktLines(items: readonly (string | Buffer | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktFlush());
    else if (item === 'delim') parts.push(pktDelim());
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

export type PktPacket =
  | { kind: 'data'; data: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/**
 * Decode pkt-lines from the start of a buffer. Returns the packets and the
 * byte offset where the framed section ends (the rest is raw pack data).
 * Throws on a malformed header.
 */
export function decodePktLines(buffer: Buffer, start = 0): { packets: PktPacket[]; offset: number } {
  const packets: PktPacket[] = [];
  let offset = start;
  while (offset + 4 <= buffer.length) {
    const head = buffer.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(head)) break;
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length === 3 || offset + length > buffer.length) break;
    packets.push({ kind: 'data', data: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, offset };
}

/** Split sideband data packets into bands (1 = pack data, 2 = progress, 3 = error). */
export function sidebandChunks(pack: Buffer, chunkSize = 32768): Buffer[] {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < pack.length; offset += chunkSize) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + chunkSize));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  return parts;
}

// ---------------------------------------------------------------------------
// packfile: build
// ---------------------------------------------------------------------------

const TYPE_CODES: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** Encode one object's varint type/size header (the pack entry header). */
function entryHeader(typeCode: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = (typeCode << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let next = size & 0x7f;
    size >>= 7;
    if (size > 0) next |= 0x80;
    bytes.push(next);
  }
  return Buffer.from(bytes);
}

/**
 * Build a PACK v2 file with full (undeltified) entries. The suite's repos are
 * small, so deltas are unnecessary; every object is one complete entry.
 */
export function buildPack(entries: readonly { type: string; content: Buffer }[]): Buffer {
  const parts: Buffer[] = [Buffer.from('PACK', 'ascii')];
  const version = Buffer.alloc(4);
  version.writeUInt32BE(2, 0);
  parts.push(version);
  const count = Buffer.alloc(4);
  count.writeUInt32BE(entries.length, 0);
  parts.push(count);
  for (const entry of entries) {
    const typeCode = TYPE_CODES[entry.type] ?? 3;
    parts.push(entryHeader(typeCode, entry.content.length));
    parts.push(deflateSync(entry.content));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------------------
// packfile: parse (with deltas)
// ---------------------------------------------------------------------------

export interface ParsedPackEntry {
  type: string;
  content: Buffer;
  sha: string;
}

interface PackEntryRaw {
  typeCode: number;
  offset: number;
  data: Buffer;
  baseOffset?: number;
  baseSha?: string;
}

function readSizeVarint(buffer: Buffer, offset: number): { size: number; typeCode: number; next: number } {
  let byte = buffer[offset] as number;
  const typeCode = (byte >> 4) & 0x07;
  let size = byte & 0x0f;
  let shift = 4;
  let next = offset + 1;
  while ((byte & 0x80) !== 0) {
    byte = buffer[next] as number;
    next += 1;
    size |= (byte & 0x7f) << shift;
    shift += 7;
  }
  return { size, typeCode, next };
}

function readOffsetVarint(buffer: Buffer, offset: number): { value: number; next: number } {
  let byte = buffer[offset] as number;
  let value = byte & 0x7f;
  let next = offset + 1;
  while ((byte & 0x80) !== 0) {
    byte = buffer[next] as number;
    next += 1;
    value = ((value + 1) << 7) | (byte & 0x7f);
  }
  return { value, next };
}

/** Apply a git delta to a base object, returning the reconstructed bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] as number;
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) throw new Error(`delta source size ${sourceSize} does not match base ${base.length}`);
  const out: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if ((op & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if ((op & (1 << bit)) !== 0) {
          copyOffset |= (delta[offset] as number) << (bit * 8);
          offset += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if ((op & (0x10 << bit)) !== 0) {
          copySize |= (delta[offset] as number) << (bit * 8);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op > 0) {
      out.push(delta.subarray(offset, offset + op));
      offset += op;
      produced += op;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize || produced !== targetSize) {
    throw new Error(`delta produced ${result.length} bytes, expected ${targetSize}`);
  }
  return result;
}

/**
 * Parse a PACK v2 file into objects. Delta entries are resolved against
 * their base (by offset, or by sha against the repo when the base is outside
 * the pack). Throws on a corrupt pack.
 */
export function parsePack(pack: Buffer, repo: Repo): ParsedPackEntry[] {
  if (pack.length < 12 || pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a PACK file');
  const version = pack.readUInt32BE(4);
  if (version !== 2) throw new Error(`unsupported PACK version ${version}`);
  const count = pack.readUInt32BE(8);
  const raw: PackEntryRaw[] = [];
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    const { size, typeCode, next } = readSizeVarint(pack, offset);
    offset = next;
    if (typeCode === 6) {
      const { value, next: after } = readOffsetVarint(pack, offset);
      offset = after;
      const inflated = inflateSync(pack.subarray(offset));
      offset += packedLength(pack, offset);
      if (inflated.length !== size) throw new Error(`pack delta size mismatch: ${inflated.length} vs ${size}`);
      raw.push({ typeCode, offset: entryOffset, data: inflated, baseOffset: entryOffset - value });
    } else if (typeCode === 7) {
      const baseSha = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const inflated = inflateSync(pack.subarray(offset));
      offset += packedLength(pack, offset);
      if (inflated.length !== size) throw new Error(`pack delta size mismatch: ${inflated.length} vs ${size}`);
      raw.push({ typeCode, offset: entryOffset, data: inflated, baseSha });
    } else {
      const inflated = inflateSync(pack.subarray(offset));
      offset += packedLength(pack, offset);
      raw.push({ typeCode, offset: entryOffset, data: inflated });
      if (inflated.length !== size) throw new Error(`pack entry size mismatch: ${inflated.length} vs ${size}`);
    }
  }
  const byOffset = new Map<number, ParsedPackEntry>();
  const bySha = new Map<string, ParsedPackEntry>();
  const resolve = (entry: PackEntryRaw): ParsedPackEntry => {
    const cached = byOffset.get(entry.offset);
    if (cached !== undefined) return cached;
    if (entry.typeCode === 6 || entry.typeCode === 7) {
      let base: ParsedPackEntry | null = null;
      if (entry.typeCode === 6 && entry.baseOffset !== undefined) {
        const baseRaw = raw.find((item) => item.offset === entry.baseOffset);
        if (baseRaw === undefined) throw new Error('OFS_DELTA base not in pack');
        base = resolve(baseRaw);
      } else if (entry.typeCode === 7 && entry.baseSha !== undefined) {
        const fromPack = bySha.get(entry.baseSha);
        if (fromPack !== undefined) base = fromPack;
        else {
          const obj = repo.objects.get(entry.baseSha);
          if (obj === undefined) throw new Error(`REF_DELTA base ${entry.baseSha} is unknown`);
          base = { type: obj.type, content: obj.content, sha: entry.baseSha };
        }
      }
      if (base === null) throw new Error('delta without a base');
      const content = applyDelta(base.content, entry.data);
      const parsed: ParsedPackEntry = { type: base.type, content, sha: sha1Object(base.type as never, content) };
      byOffset.set(entry.offset, parsed);
      bySha.set(parsed.sha, parsed);
      return parsed;
    }
    const type = (Object.keys(TYPE_CODES).find((key) => TYPE_CODES[key] === entry.typeCode) ?? 'blob') as string;
    const parsed: ParsedPackEntry = { type, content: entry.data, sha: sha1Object(type as never, entry.data) };
    byOffset.set(entry.offset, parsed);
    bySha.set(parsed.sha, parsed);
    return parsed;
  };
  return raw.map((entry) => resolve(entry));
}

/**
 * The byte length of the deflate stream starting at `offset` in `buffer`.
 * inflateSync on a subarray consumes exactly the stream, so measure by
 * inflating slices: walk forward until inflateSync stops complaining about
 * truncation... simpler: use zlib's raw inflate via a single pass over a
 * growing window is expensive; instead find the stream end by trying
 * inflateSync on progressively larger slices is O(n^2). The practical way:
 * node:zlib's inflateSync throws on truncated input; binary-search the
 * smallest prefix that inflates. Packs here are small (suite scale).
 */
function packedLength(buffer: Buffer, offset: number): number {
  let low = 1;
  let high = buffer.length - offset;
  // A deflate stream is at least 2 bytes; binary search the first working prefix.
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    try {
      inflateSync(buffer.subarray(offset, offset + mid));
      high = mid;
    } catch {
      low = mid + 1;
    }
  }
  return low;
}

// ---------------------------------------------------------------------------
// reachability: what a fetch must send
// ---------------------------------------------------------------------------

export interface FetchPlan {
  /** Object shas to send, in pack order (commits, then trees, then blobs). */
  objects: string[];
  /** New shallow boundaries (commits at the depth limit). */
  shallow: string[];
  /** Former shallow boundaries that are now fully included. */
  unshallow: string[];
}

/**
 * The objects a fetch must deliver: reachable from `wants` within `depth`
 * commit generations (undefined = unlimited), minus what the client already
 * holds (reachable from `haves`, without crossing the client's shallow
 * boundaries). `clientShallow` is the set of the client's current shallow
 * commits.
 */
export function planFetch(
  store: Store,
  repo: Repo,
  wants: string[],
  haves: string[],
  clientShallow: string[],
  depth: number | undefined,
): FetchPlan {
  const shallowSet = new Set(clientShallow);
  // What the client already holds: closure from haves, stopping at shallow
  // boundaries (their parents are not held).
  const held = new Set<string>();
  const heldQueue: string[] = [...haves];
  const heldSeen = new Set<string>();
  while (heldQueue.length > 0) {
    const sha = heldQueue.pop() as string;
    if (heldSeen.has(sha)) continue;
    heldSeen.add(sha);
    collectObjectClosure(store, repo, sha, held);
    const obj = store.getObject(repo, sha);
    if (obj !== null && obj.type === 'commit' && !shallowSet.has(sha)) {
      for (const parent of parseCommit(obj.content).parents) heldQueue.push(parent);
    }
  }
  // What the wants need, within the depth limit.
  const wanted = new Set<string>();
  const boundary = new Set<string>();
  const queue: { sha: string; generation: number }[] = wants.map((sha) => ({ sha, generation: 1 }));
  const seenCommits = new Set<string>();
  while (queue.length > 0) {
    const { sha, generation } = queue.shift() as { sha: string; generation: number };
    if (seenCommits.has(sha)) continue;
    seenCommits.add(sha);
    collectObjectClosure(store, repo, sha, wanted);
    const obj = store.getObject(repo, sha);
    if (obj === null || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.content).parents;
    if (depth !== undefined && generation >= depth) {
      if (parents.length > 0) boundary.add(sha);
      continue;
    }
    for (const parent of parents) queue.push({ sha: parent, generation: generation + 1 });
  }
  // Former shallow boundaries now fully included: a boundary commit whose
  // parents are all inside the wanted set (they are, when depth > its depth).
  const unshallow: string[] = [];
  for (const sha of shallowSet) {
    if (!seenCommits.has(sha)) continue;
    const obj = store.getObject(repo, sha);
    if (obj === null || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.content).parents;
    const fullyIncluded = parents.every((parent) => seenCommits.has(parent));
    if (fullyIncluded && parents.length > 0) unshallow.push(sha);
  }
  const toSend = [...wanted].filter((sha) => !held.has(sha));
  // Pack order: commits, then trees, then blobs (and tags with commits).
  const order = (sha: string): number => {
    const obj = store.getObject(repo, sha);
    if (obj === undefined) return 9;
    if (obj.type === 'commit' || obj.type === 'tag') return 0;
    if (obj.type === 'tree') return 1;
    return 2;
  };
  toSend.sort((a, b) => order(a) - order(b) || (a < b ? -1 : 1));
  return { objects: toSend, shallow: [...boundary].sort(), unshallow: unshallow.sort() };
}

/** Add one object and, for commits/trees, its reachable closure to `out`. */
function collectObjectClosure(store: Store, repo: Repo, sha: string, out: Set<string>): void {
  const stack = [sha];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (out.has(current)) continue;
    const obj = store.getObject(repo, current);
    if (obj === null) continue;
    out.add(current);
    if (obj.type === 'commit') {
      const parsed = parseCommit(obj.content);
      stack.push(parsed.tree);
      // Parents are handled by the caller's generation walk, not here: this
      // closure is per-object (tree + blobs), so do not follow parents.
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.content)) stack.push(entry.oid);
    } else if (obj.type === 'tag') {
      const text = obj.content.toString('utf8');
      const match = /^object ([0-9a-f]{40})$/m.exec(text);
      if (match !== null) stack.push(match[1] as string);
    }
  }
}
