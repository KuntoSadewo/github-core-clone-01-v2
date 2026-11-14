// gitutil.ts — model objek git, packfile, dan operasi pohon.
// Semua stdlib Node (crypto, zlib). Tidak ada dependensi luar.
//
// Desain: objek disimpan sebagai { kind, bytes } mentah. ID adalah SHA-1
// atas "<kind> <len>\0" + bytes, persis seperti git. Fungsi di sini murni:
// tidak ada I/O, tidak ada state global.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjectKind = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  kind: ObjectKind;
  bytes: Buffer;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';

/** SHA-1 git atas header "<kind> <len>\0" + isi. */
export function objectId(kind: ObjectKind, bytes: Buffer): string {
  const head = Buffer.from(`${kind} ${bytes.length}\0`, 'ascii');
  return createHash('sha1').update(head).update(bytes).digest('hex');
}

/** Apakah string ini bentuk oid hex 40 karakter? */
export function looksLikeOid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

export interface Identity {
  name: string;
  email: string;
  /** detik epoch (deterministik: diisi dari counter, bukan wall clock) */
  when: number;
}

export interface CommitFields {
  tree: string;
  parents: string[];
  author: Identity;
  committer: Identity;
  message: string;
}

function identityLine(who: Identity): string {
  return `${who.name} <${who.email}> ${who.when} +0000`;
}

/** Serialisasi commit persis format git: header, baris kosong, pesan. */
export function encodeCommit(fields: CommitFields): Buffer {
  const out: string[] = [`tree ${fields.tree}`];
  for (const p of fields.parents) out.push(`parent ${p}`);
  out.push(`author ${identityLine(fields.author)}`);
  out.push(`committer ${identityLine(fields.committer)}`);
  out.push('');
  return Buffer.from(out.join('\n') + '\n' + fields.message, 'utf8');
}

export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Pecah commit mentah menjadi field. Pesan adalah semua setelah "\n\n" pertama. */
export function decodeCommit(bytes: Buffer): ParsedCommit {
  const text = bytes.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  const found: ParsedCommit = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) found.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) found.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) found.author = line.slice(7);
    else if (line.startsWith('committer ')) found.committer = line.slice(10);
  }
  return found;
}

// ---------------------------------------------------------------------------
// Tree
// ---------------------------------------------------------------------------

export interface TreeEntry {
  mode: string; // "100644" | "100755" | "40000" | "120000"
  name: string;
  oid: string;
}

/** Urutan sort git: nama direktori dianggap berakhiran '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? entry.name + '/' : entry.name;
}

/** Serialisasi tree: entri terurut, tiap entri "mode nama\0" + oid 20 byte. */
export function encodeTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) =>
    treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0,
  );
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Pecah tree mentah menjadi entri. */
export function decodeTree(bytes: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < bytes.length) {
    const space = bytes.indexOf(0x20, off);
    if (space === -1) throw new Error('tree rusak: tidak ada spasi mode');
    const nul = bytes.indexOf(0x00, space + 1);
    if (nul === -1) throw new Error('tree rusak: tidak ada NUL nama');
    const mode = bytes.toString('utf8', off, space);
    const name = bytes.toString('utf8', space + 1, nul);
    const oid = bytes.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Tag (annotated)
// ---------------------------------------------------------------------------

export interface TagFields {
  object: string;
  type: ObjectKind;
  tag: string;
  tagger: Identity;
  message: string;
}

export function encodeTag(fields: TagFields): Buffer {
  const out = [
    `object ${fields.object}`,
    `type ${fields.type}`,
    `tag ${fields.tag}`,
    `tagger ${identityLine(fields.tagger)}`,
    '',
  ];
  return Buffer.from(out.join('\n') + '\n' + fields.message, 'utf8');
}

export interface ParsedTag {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function decodeTag(bytes: Buffer): ParsedTag {
  const text = bytes.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  const found: ParsedTag = { object: '', type: '', tag: '', tagger: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) found.object = line.slice(7).trim();
    else if (line.startsWith('type ')) found.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) found.tag = line.slice(4);
    else if (line.startsWith('tagger ')) found.tagger = line.slice(7);
  }
  return found;
}

// ---------------------------------------------------------------------------
// Packfile (tulis)
// ---------------------------------------------------------------------------

const PACK_MAGIC = Buffer.from('PACK', 'ascii');

function packKindNumber(kind: ObjectKind): number {
  switch (kind) {
    case 'commit': return 1;
    case 'tree': return 2;
    case 'blob': return 3;
    case 'tag': return 4;
  }
}

/** Tulis satu objek ke pack: header varint (kind + size) + deflate. */
function packWriteOne(kind: ObjectKind, bytes: Buffer): Buffer {
  const num = packKindNumber(kind);
  const header: number[] = [];
  let size = bytes.length;
  let first = (num << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) first |= 0x80;
  header.push(first);
  while (size > 0) {
    let b = size & 0x7f;
    size >>= 7;
    if (size > 0) b |= 0x80;
    header.push(b);
  }
  const compressed = deflateSync(bytes, { level: 6 });
  return Buffer.concat([Buffer.from(header), compressed]);
}

/**
 * Serialisasi sekumpulan objek menjadi packfile v2 lengkap dengan trailer
 * SHA-1. Objek diurutkan menurut oid agar hasil deterministik.
 */
export function buildPack(objects: Map<string, GitObject>): Buffer {
  const ids = [...objects.keys()].sort();
  const chunks: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(ids.length, 8);
  chunks.push(head);
  for (const id of ids) {
    const obj = objects.get(id)!;
    chunks.push(packWriteOne(obj.kind, obj.bytes));
  }
  const body = Buffer.concat(chunks);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------------------
// Packfile (baca)
// ---------------------------------------------------------------------------

/**
 * Inflate satu stream zlib yang dimulai di offset, mengembalikan bytes
 * hasil dan jumlah byte input yang dikonsumsi. Node tidak mengekspos
 * panjang stream yang terpakai, jadi dicari dengan binary search atas
 * panjang potongan: potongan yang terlalu pendek gagal (stream terpotong),
 * potongan yang cukup berhasil — panjang minimal yang berhasil adalah
 * tepat panjang stream.
 */
export function inflateWithLength(view: Buffer, offset: number): { bytes: Buffer; used: number } {
  const rest = view.subarray(offset);
  let lo = 1;
  let hi = rest.length;
  let best: Buffer | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    try {
      best = inflateSync(rest.subarray(0, mid));
      hi = mid - 1;
    } catch {
      lo = mid + 1;
    }
  }
  if (best === null) throw new Error('zlib: tidak bisa inflate di offset ' + offset);
  return { bytes: best, used: lo };
}

/** Terapkan delta git (copy + insert) pada basis. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readVarint = (): number => {
    let out = 0;
    let shift = 0;
    while (off < delta.length) {
      const b = delta[off++];
      out |= (b & 0x7f) << shift;
      shift += 7;
      if ((b & 0x80) === 0) break;
    }
    return out;
  };
  const baseSize = readVarint();
  const resultSize = readVarint();
  if (baseSize !== base.length) throw new Error('delta: ukuran basis tidak cocok');
  const pieces: Buffer[] = [];
  while (off < delta.length) {
    const op = delta[off++];
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i++) {
        if (op & (1 << i)) offset |= delta[off++] << (i * 8);
      }
      for (let i = 0; i < 3; i++) {
        if (op & (0x10 << i)) size |= delta[off++] << (i * 8);
      }
      if (size === 0) size = 0x10000;
      pieces.push(base.subarray(offset, offset + size));
    } else if (op !== 0) {
      pieces.push(delta.subarray(off, off + op));
      off += op;
    } else {
      throw new Error('delta: opcode 0 tidak valid');
    }
  }
  const result = Buffer.concat(pieces);
  if (result.length !== resultSize) throw new Error('delta: ukuran hasil tidak cocok');
  return result;
}

interface PendingDelta {
  baseOid: string | null;
  baseOffset: number;
  delta: Buffer;
  position: number;
}

/**
 * Baca packfile v2. Mengembalikan peta oid -> objek. Mendukung entri
 * OFS_DELTA (6) dan REF_DELTA (7); delta diterapkan setelah semua basis
 * dibaca, berulang sampai semua terpecahkan (delta boleh berantai).
 */
export function parsePack(buffer: Buffer): Map<string, GitObject> {
  if (buffer.length < 12 || !buffer.subarray(0, 4).equals(PACK_MAGIC)) {
    throw new Error('pack: magic salah');
  }
  const version = buffer.readUInt32BE(4);
  if (version !== 2) throw new Error('pack: versi bukan 2');
  const count = buffer.readUInt32BE(8);
  const out = new Map<string, GitObject>();
  const byOffset = new Map<number, { kind: ObjectKind; bytes: Buffer }>();
  const pending: PendingDelta[] = [];
  let off = 12;

  for (let i = 0; i < count; i++) {
    const entryStart = off;
    let b = buffer[off];
    const kindNum = (b >> 4) & 0x07;
    let size = b & 0x0f;
    let shift = 4;
    off += 1;
    while (b & 0x80) {
      b = buffer[off];
      off += 1;
      size |= (b & 0x7f) << shift;
      shift += 7;
    }
    let baseOid: string | null = null;
    let baseOffset = -1;
    if (kindNum === 6) {
      // OFS_DELTA: offset negatif, dikodekan varint khusus.
      let c = buffer[off++];
      let value = c & 0x7f;
      while (c & 0x80) {
        c = buffer[off++];
        value = ((value + 1) << 7) | (c & 0x7f);
      }
      baseOffset = entryStart - value;
    } else if (kindNum === 7) {
      baseOid = buffer.subarray(off, off + 20).toString('hex');
      off += 20;
    }
    const { bytes, used } = inflateWithLength(buffer, off);
    off += used;
    if (bytes.length !== size) throw new Error('pack: ukuran objek tidak cocok');
    if (kindNum >= 1 && kindNum <= 4) {
      const kind = (['', 'commit', 'tree', 'blob', 'tag'] as const)[kindNum] as ObjectKind;
      const oid = objectId(kind, bytes);
      out.set(oid, { kind, bytes });
      byOffset.set(entryStart, { kind, bytes });
    } else if (kindNum === 6 || kindNum === 7) {
      pending.push({ baseOid, baseOffset, delta: bytes, position: entryStart });
    } else {
      throw new Error('pack: jenis objek tidak dikenal: ' + kindNum);
    }
  }

  // Terapkan delta. Basis bisa berupa objek biasa atau delta lain yang
  // sudah terpecahkan. Ulangi sampai tidak ada kemajuan.
  let remaining = pending;
  for (let round = 0; round < 100 && remaining.length > 0; round++) {
    const next: PendingDelta[] = [];
    for (const item of remaining) {
      const base =
        item.baseOid !== null
          ? out.get(item.baseOid)
          : byOffset.get(item.baseOffset);
      if (base === undefined) {
        next.push(item);
        continue;
      }
      const bytes = applyDelta(base.bytes, item.delta);
      const oid = objectId(base.kind, bytes);
      out.set(oid, { kind: base.kind, bytes });
      byOffset.set(item.position, { kind: base.kind, bytes });
    }
    if (next.length === remaining.length) break;
    remaining = next;
  }
  if (remaining.length > 0) throw new Error('pack: delta basis tidak ditemukan');
  return out;
}

// ---------------------------------------------------------------------------
// Reachability & operasi pohon
// ---------------------------------------------------------------------------

export type ObjectLookup = (oid: string) => GitObject | undefined;

/**
 * Kumpulkan semua commit yang terjangkau dari roots, dibatasi kedalaman.
 * depth = jumlah generasi commit yang disertakan (1 = hanya tip).
 * depth null = tanpa batas. Mengembalikan commit dalam urutan BFS.
 */
export function walkCommits(
  roots: string[],
  lookup: ObjectLookup,
  depth: number | null,
): string[] {
  const seen = new Set<string>();
  const found: string[] = [];
  const queue: { oid: string; gen: number }[] = roots.map((oid) => ({ oid, gen: 1 }));
  while (queue.length > 0) {
    const { oid, gen } = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = lookup(oid);
    if (obj === undefined) continue;
    if (obj.kind === 'tag') {
      const tag = decodeTag(obj.bytes);
      if (!seen.has(tag.object)) queue.push({ oid: tag.object, gen });
      continue;
    }
    if (obj.kind !== 'commit') continue;
    if (depth !== null && gen > depth) continue;
    found.push(oid);
    const parsed = decodeCommit(obj.bytes);
    for (const parent of parsed.parents) {
      if (!seen.has(parent)) queue.push({ oid: parent, gen: gen + 1 });
    }
  }
  return found;
}

/** Apakah `ancestor` terjangkau dari `tip` (dipakai untuk cek fast-forward)? */
export function isAncestor(ancestor: string, tip: string, lookup: ObjectLookup): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = lookup(oid);
    if (obj === undefined) continue;
    if (obj.kind === 'tag') {
      queue.push(decodeTag(obj.bytes).object);
      continue;
    }
    if (obj.kind !== 'commit') continue;
    const parsed = decodeCommit(obj.bytes);
    if (parsed.parents.includes(ancestor)) return true;
    queue.push(...parsed.parents);
  }
  return false;
}

/**
 * Cari merge-base: leluhur bersama pertama dari dua commit (pencarian
 * breadth-first dari kedua sisi, pilih pasangan dengan jumlah generasi
 * terkecil).
 */
export function mergeBase(a: string, b: string, lookup: ObjectLookup): string | null {
  if (a === b) return a;
  const seenA = new Map<string, number>();
  const queueA: { oid: string; gen: number }[] = [{ oid: a, gen: 0 }];
  while (queueA.length > 0) {
    const { oid, gen } = queueA.shift()!;
    if (seenA.has(oid)) continue;
    seenA.set(oid, gen);
    const obj = lookup(oid);
    if (obj?.kind !== 'commit') continue;
    for (const p of decodeCommit(obj.bytes).parents) queueA.push({ oid: p, gen: gen + 1 });
  }
  const queueB: { oid: string; gen: number }[] = [{ oid: b, gen: 0 }];
  const seenB = new Set<string>();
  let best: string | null = null;
  let bestGen = Infinity;
  while (queueB.length > 0) {
    const { oid, gen } = queueB.shift()!;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    const genA = seenA.get(oid);
    if (genA !== undefined && genA + gen < bestGen) {
      best = oid;
      bestGen = genA + gen;
    }
    const obj = lookup(oid);
    if (obj?.kind !== 'commit') continue;
    for (const p of decodeCommit(obj.bytes).parents) queueB.push({ oid: p, gen: gen + 1 });
  }
  return best;
}

/**
 * Seluruh closure objek (commit + tree + blob + tag) yang terjangkau dari
 * sekumpulan commit — hanya tree/blob di bawah commit-commit itu, BUKAN
 * parent mereka. Daftar commit yang disertakan sudah ditentukan pemanggil
 * (mis. walkCommits dengan batas depth), jadi fungsi ini tidak pernah
 * berjalan melewati batas depth.
 */
export function closureObjects(
  commitOids: string[],
  lookup: ObjectLookup,
  sink: Map<string, GitObject>,
): void {
  const stack = [...commitOids];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = lookup(oid);
    if (obj === undefined) continue;
    sink.set(oid, obj);
    if (obj.kind === 'commit') {
      const parsed = decodeCommit(obj.bytes);
      stack.push(parsed.tree);
    } else if (obj.kind === 'tree') {
      for (const entry of decodeTree(obj.bytes)) stack.push(entry.oid);
    } else if (obj.kind === 'tag') {
      stack.push(decodeTag(obj.bytes).object);
    }
  }
}

/** Baca isi satu path dari tree (rekursif). Null bila tidak ada. */
export function treeGetPath(
  treeOid: string,
  path: string,
  lookup: ObjectLookup,
): { mode: string; oid: string } | null {
  const parts = path.split('/').filter((p) => p !== '');
  let current = treeOid;
  for (let i = 0; i < parts.length; i++) {
    const obj = lookup(current);
    if (obj === undefined || obj.kind !== 'tree') return null;
    const entry = decodeTree(obj.bytes).find((e) => e.name === parts[i]);
    if (entry === undefined) return null;
    if (i === parts.length - 1) return { mode: entry.mode, oid: entry.oid };
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

/**
 * Hasilkan tree baru dengan satu path diganti/ditambah. Mengembalikan oid
 * tree baru; objek tree/blob baru ditulis ke `store` (peta oid -> objek).
 */
export function treeSetPath(
  treeOid: string | null,
  path: string,
  blobOid: string,
  mode: string,
  lookup: ObjectLookup,
  store: Map<string, GitObject>,
): string {
  const parts = path.split('/').filter((p) => p !== '');
  const setIn = (currentOid: string | null, depth: number): string => {
    const entries: TreeEntry[] =
      currentOid === null ? [] : decodeTree(lookup(currentOid)!.bytes);
    const name = parts[depth];
    if (depth === parts.length - 1) {
      const next = entries.filter((e) => e.name !== name);
      next.push({ mode, name, oid: blobOid });
      const bytes = encodeTree(next);
      const oid = objectId('tree', bytes);
      store.set(oid, { kind: 'tree', bytes });
      return oid;
    }
    const existing = entries.find((e) => e.name === name);
    const childOid = setIn(existing && existing.mode === '40000' ? existing.oid : null, depth + 1);
    const next = entries.filter((e) => e.name !== name);
    next.push({ mode: '40000', name, oid: childOid });
    const bytes = encodeTree(next);
    const oid = objectId('tree', bytes);
    store.set(oid, { kind: 'tree', bytes });
    return oid;
  };
  return setIn(treeOid, 0);
}

/** Hasilkan tree baru dengan satu path dihapus. Null bila path tidak ada. */
export function treeRemovePath(
  treeOid: string,
  path: string,
  lookup: ObjectLookup,
  store: Map<string, GitObject>,
): string | null {
  const parts = path.split('/').filter((p) => p !== '');
  const removeIn = (currentOid: string, depth: number): string | null => {
    const entries = decodeTree(lookup(currentOid)!.bytes);
    const name = parts[depth];
    const idx = entries.findIndex((e) => e.name === name);
    if (idx === -1) return null;
    if (depth === parts.length - 1) {
      const next = entries.filter((_, i) => i !== idx);
      const bytes = encodeTree(next);
      const oid = objectId('tree', bytes);
      store.set(oid, { kind: 'tree', bytes });
      return oid;
    }
    const entry = entries[idx];
    if (entry.mode !== '40000') return null;
    const childOid = removeIn(entry.oid, depth + 1);
    if (childOid === null) return null;
    const next = entries.map((e, i) => (i === idx ? { ...e, oid: childOid } : e));
    const bytes = encodeTree(next);
    const oid = objectId('tree', bytes);
    store.set(oid, { kind: 'tree', bytes });
    return oid;
  };
  return removeIn(treeOid, 0);
}

/** Daftar isi satu direktori di dalam tree. Null bila bukan direktori. */
export function treeListDir(
  treeOid: string,
  path: string,
  lookup: ObjectLookup,
): TreeEntry[] | null {
  if (path === '' || path === '/') {
    const obj = lookup(treeOid);
    if (obj === undefined || obj.kind !== 'tree') return null;
    return decodeTree(obj.bytes);
  }
  const found = treeGetPath(treeOid, path, lookup);
  if (found === null || found.mode !== '40000') return null;
  const obj = lookup(found.oid);
  if (obj === undefined || obj.kind !== 'tree') return null;
  return decodeTree(obj.bytes);
}
