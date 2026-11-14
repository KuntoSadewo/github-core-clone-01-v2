// gitutil.ts — git object model, packfile read/write, reachability. Stdlib only.
// Every id is the SHA-1 of "<type> <len>\0" + bytes, exactly as git computes it.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export const ZERO_OID = '0'.repeat(40);

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function isObjectId(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

export function hashObject(type: ObjType, data: Uint8Array): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTree(data: Uint8Array): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  const buf = Buffer.from(data);
  while (offset < buf.length) {
    const space = buf.indexOf(0x20, offset);
    if (space < 0) break;
    const mode = buf.subarray(offset, space).toString('ascii');
    const nul = buf.indexOf(0x00, space + 1);
    if (nul < 0) break;
    const name = buf.subarray(space + 1, nul).toString('utf8');
    const oid = buf.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree sort: entries compare by name, directories as if the name ended with '/'. */
export function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const an = a.mode === '40000' ? `${a.name}/` : a.name;
  const bn = b.mode === '40000' ? `${b.name}/` : b.name;
  return an < bn ? -1 : an > bn ? 1 : 0;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseCommit(data: Uint8Array): CommitView {
  const text = Buffer.from(data).toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function parseTag(data: Uint8Array): TagView {
  const text = Buffer.from(data).toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

export function buildCommit(fields: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines: string[] = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author}`, `committer ${fields.committer}`);
  const message = fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8');
}

export type ObjectLookup = (oid: string) => GitObject | undefined;

/**
 * Every object reachable from `roots` (commits walk parents and trees; trees walk entries;
 * tags walk their target). Throws when a referenced object is missing.
 */
export function collectReachable(roots: Iterable<string>, lookup: ObjectLookup): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid) || oid === ZERO_OID) continue;
    const object = lookup(oid);
    if (object === undefined) throw new Error(`missing object ${oid}`);
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree);
      for (const parent of commit.parents) stack.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return seen;
}

/** True when `ancestor` is reachable from `oid` (or equal), following commits and tags. */
export function isAncestor(ancestor: string, oid: string, lookup: ObjectLookup): boolean {
  if (ancestor === oid) return true;
  if (ancestor === ZERO_OID) return true;
  const seen = new Set<string>();
  const stack = [oid];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (current === ancestor) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    const object = lookup(current);
    if (object === undefined) continue;
    if (object.type === 'commit') {
      for (const parent of parseCommit(object.data).parents) stack.push(parent);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Packfiles (v2, no deltas on write; deltas resolved on read).
// ---------------------------------------------------------------------------

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number } {
  let byte = buffer[start] as number;
  let size = byte & 0x0f;
  let shift = 4;
  let next = start + 1;
  while ((byte & 0x80) !== 0) {
    byte = buffer[next] as number;
    size |= (byte & 0x7f) << shift;
    shift += 7;
    next += 1;
  }
  return { size, next };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start] as number;
  let baseOffset = byte & 0x7f;
  let next = start + 1;
  while ((byte & 0x80) !== 0) {
    byte = buffer[next] as number;
    baseOffset = ((baseOffset + 1) << 7) | (byte & 0x7f);
    next += 1;
  }
  return { baseOffset, next };
}

// Decompress one zlib stream starting at `offset` and report the bytes it consumed.
// inflateSync ignores trailing bytes, so the stream's exact end is found by binary search:
// the smallest prefix that inflates without "unexpected end of file" is the whole stream.
function inflateEntry(pack: Buffer, offset: number): { data: Buffer; next: number } {
  const tail = pack.subarray(offset);
  let lo = 1;
  let hi = tail.length;
  let data: Buffer | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    try {
      data = inflateSync(tail.subarray(0, mid));
      hi = mid - 1;
    } catch {
      lo = mid + 1;
    }
  }
  if (data === null) throw new Error('could not inflate pack entry');
  return { data, next: offset + lo };
}

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
  const baseSize = readVarint();
  const resultSize = readVarint();
  if (baseSize !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  let written = 0;
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
      written += copySize;
    } else if (op !== 0) {
      out.push(delta.subarray(offset, offset + op));
      offset += op;
      written += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== resultSize || written !== resultSize) throw new Error('delta result size mismatch');
  return result;
}

export interface PackReadResult {
  objects: Map<string, GitObject>;
  deltaCount: number;
}

/**
 * Parse a packfile. Full objects are inflated in place; OFS/REF deltas are resolved against
 * bases already in the pack (or `resolveBase` for thin packs). Returns the resolved objects.
 */
export function readPack(pack: Buffer, options: { resolveBase?: ObjectLookup } = {}): PackReadResult {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  const deltas: Array<{ offset: number; type: number; data: Buffer; baseOid?: string; baseOffset?: number }> = [];
  let offset = 12;
  let deltaCount = 0;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    const first = pack[offset] as number;
    const typeCode = (first >> 4) & 0x07;
    const { next } = readVarintSize(pack, offset);
    offset = next;
    if (typeCode === 6) {
      // OFS_DELTA
      const { baseOffset, next: afterBase } = readOfsDeltaBase(pack, offset);
      offset = afterBase;
      const { data, next: afterData } = inflateEntry(pack, offset);
      deltas.push({ offset: entryOffset, type: 6, data, baseOffset: entryOffset - baseOffset });
      offset = afterData;
      deltaCount += 1;
    } else if (typeCode === 7) {
      // REF_DELTA
      const baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const { data, next: afterData } = inflateEntry(pack, offset);
      deltas.push({ offset: entryOffset, type: 7, data, baseOid });
      offset = afterData;
      deltaCount += 1;
    } else {
      const type = CODE_TYPE[typeCode];
      if (type === undefined) throw new Error(`unknown pack object type ${typeCode}`);
      const { data, next: afterData } = inflateEntry(pack, offset);
      const oid = hashObject(type, data);
      const object: GitObject = { type, data };
      objects.set(oid, object);
      byOffset.set(entryOffset, object);
      offset = afterData;
    }
  }
  // Resolve deltas in offset order (a delta's base precedes it in a well-formed pack).
  for (const delta of deltas) {
    let base: GitObject | undefined;
    if (delta.type === 6 && delta.baseOffset !== undefined) base = byOffset.get(delta.baseOffset);
    else if (delta.type === 7 && delta.baseOid !== undefined) base = objects.get(delta.baseOid) ?? options.resolveBase?.(delta.baseOid);
    if (base === undefined) throw new Error('delta base not found in pack');
    const data = applyDelta(base.data, delta.data);
    const oid = hashObject(base.type, data);
    const object: GitObject = { type: base.type, data };
    objects.set(oid, object);
    byOffset.set(delta.offset, object);
  }
  return { objects, deltaCount };
}

export function packChecksum(pack: Uint8Array): string {
  const buffer = Buffer.from(pack);
  return createHash('sha1').update(buffer.subarray(0, buffer.length - 20)).digest('hex');
}

export function verifyPackChecksum(pack: Uint8Array): { ok: boolean; expected: string; actual: string } {
  const buffer = Buffer.from(pack);
  const actual = buffer.subarray(buffer.length - 20).toString('hex');
  const expected = packChecksum(buffer);
  return { ok: actual === expected, expected, actual };
}

function writePackObjectHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (no deltas), version 2, SHA-1 trailer. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}
