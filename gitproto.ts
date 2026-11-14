// gitproto.ts — protokol git smart HTTP (pkt-line, v0/v2, fetch, push).
//
// Satu-satunya permukaan git di forge ini. Semua fungsi menerima record
// repo dan mengembalikan respons HTTP mentah (status + content-type + body).

import type { GitObject } from './gitutil.ts';
import {
  ZERO_OID,
  objectId,
  decodeCommit,
  decodeTag,
  decodeTree,
  buildPack,
  parsePack,
  walkCommits,
  closureObjects,
  isAncestor,
} from './gitutil.ts';
import type { RepoRecord } from './store.ts';

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

const AGENT_NAME = 'pocket-forge/1.0';

// ---------------------------------------------------------------------------
// Pkt-line
// ---------------------------------------------------------------------------

/** Satu baris pkt-line: 4 hex panjang (termasuk header) + payload. */
export function pkt(data: string | Buffer): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const head = (payload.length + 4).toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(head, 'ascii'), payload]);
}

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');

export type PktKind = 'data' | 'flush' | 'delim' | 'end';

export interface PktItem {
  kind: PktKind;
  payload: Buffer;
}

/** Pembaca pkt-line yang berjalan di atas buffer; berhenti di flush. */
export class PktReader {
  offset = 0;

  private buffer: Buffer;
  constructor(buffer: Buffer) {
    this.buffer = buffer;
  }

  get remaining(): Buffer {
    return this.buffer.subarray(this.offset);
  }

  get atEnd(): boolean {
    return this.offset >= this.buffer.length;
  }

  next(): PktItem | null {
    if (this.offset + 4 > this.buffer.length) {
      throw new Error('pkt-line: terpotong di header');
    }
    const head = this.buffer.toString('ascii', this.offset, this.offset + 4);
    if (head === '0000') {
      this.offset += 4;
      return { kind: 'flush', payload: Buffer.alloc(0) };
    }
    if (head === '0001') {
      this.offset += 4;
      return { kind: 'delim', payload: Buffer.alloc(0) };
    }
    if (head === '0002') {
      this.offset += 4;
      return { kind: 'end', payload: Buffer.alloc(0) };
    }
    const len = Number.parseInt(head, 16);
    if (!Number.isFinite(len) || len < 4 || len > 65520) {
      throw new Error('pkt-line: panjang tidak valid: ' + head);
    }
    if (this.offset + len > this.buffer.length) {
      throw new Error('pkt-line: terpotong di payload');
    }
    const payload = this.buffer.subarray(this.offset + 4, this.offset + len);
    this.offset += len;
    return { kind: 'data', payload: Buffer.from(payload) };
  }

  /** Baca semua paket sampai flush (atau akhir buffer). */
  readUntilFlush(): PktItem[] {
    const items: PktItem[] = [];
    while (!this.atEnd) {
      const item = this.next();
      if (item === null) break;
      items.push(item);
      if (item.kind === 'flush') break;
    }
    return items;
  }
}

/** Pecah isi pkt-line "kunci=nilai kunci2" menjadi peta. */
export function parseCaps(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const token of text.trim().split(/\s+/)) {
    if (token === '') continue;
    const eq = token.indexOf('=');
    if (eq === -1) out.set(token, '');
    else out.set(token.slice(0, eq), token.slice(eq + 1));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Advertisement
// ---------------------------------------------------------------------------

interface RefLine {
  name: string;
  oid: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

/** Semua ref repo dalam bentuk baris, HEAD dulu, lalu terurut. */
function collectRefLines(repo: RepoRecord): RefLine[] {
  const lines: RefLine[] = [];
  const defaultRef = `refs/heads/${repo.defaultBranch}`;
  const defaultTip = repo.refs.get(defaultRef);
  if (defaultTip !== undefined) {
    lines.push({ name: 'HEAD', oid: defaultTip, symrefTarget: defaultRef });
  } else if (repo.refs.size === 0) {
    lines.push({ name: 'HEAD', oid: ZERO_OID, symrefTarget: defaultRef, unborn: true });
  }
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const line: RefLine = { name, oid };
    const obj = repo.objects.get(oid);
    if (obj !== undefined && obj.kind === 'tag') {
      line.peeled = decodeTag(obj.bytes).object;
    }
    lines.push(line);
  }
  return lines;
}

function renderRefLine(line: RefLine, caps: string | null): Buffer {
  let text = `${line.oid} ${line.name}`;
  if (line.peeled !== undefined) text += ` peeled:${line.peeled}`;
  if (line.symrefTarget !== undefined) text += ` symref-target:${line.symrefTarget}`;
  if (caps !== null) text += `\0${caps}`;
  return pkt(text + '\n');
}

/** Advertisement upload-pack v2. */
export function advertiseV2(): Buffer {
  const parts: Buffer[] = [
    pkt('# service=git-upload-pack\n'),
    pkt('version 2\n'),
    pkt('ls-refs=unborn\n'),
    pkt('fetch=shallow filter\n'),
    pkt('object-format=sha1\n'),
    pkt(`agent=${AGENT_NAME}\n`),
    FLUSH,
  ];
  return Buffer.concat(parts);
}

/** Advertisement v0 (upload atau receive). */
function advertiseV0(repo: RepoRecord, service: 'upload-pack' | 'receive-pack'): Buffer {
  const caps =
    service === 'upload-pack'
      ? `symref=HEAD:refs/heads/${repo.defaultBranch} side-band-64k ofs-delta thin-pack multi_ack_detailed shallow agent=${AGENT_NAME} object-format=sha1`
      : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT_NAME} object-format=sha1`;
  const parts: Buffer[] = [pkt(`# service=git-${service}\n`)];
  const lines = collectRefLines(repo);
  if (lines.length === 0) {
    parts.push(pkt(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    // Baris pertama membawa capabilities; HEAD (bila ada) jadi yang pertama.
    parts.push(renderRefLine(lines[0], caps));
    for (const line of lines.slice(1)) parts.push(renderRefLine(line, null));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

export function infoRefsUpload(repo: RepoRecord, v2: boolean): GitResponse {
  const body = v2 ? advertiseV2() : advertiseV0(repo, 'upload-pack');
  return {
    status: 200,
    contentType: 'application/x-git-upload-pack-advertisement',
    body,
  };
}

export function infoRefsReceive(repo: RepoRecord): GitResponse {
  return {
    status: 200,
    contentType: 'application/x-git-receive-pack-advertisement',
    body: advertiseV0(repo, 'receive-pack'),
  };
}

// ---------------------------------------------------------------------------
// ls-refs (v2)
// ---------------------------------------------------------------------------

export function handleLsRefs(repo: RepoRecord, body: Buffer): GitResponse {
  const reader = new PktReader(body);
  const items = reader.readUntilFlush();
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  let seenDelim = false;
  for (const item of items) {
    if (item.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (item.kind !== 'data') continue;
    const text = item.payload.toString('utf8').trim();
    if (!seenDelim) continue; // baris perintah + agent dilewati
    if (text === 'peel') peel = true;
    else if (text === 'symrefs') symrefs = true;
    else if (text === 'unborn') unborn = true;
    else if (text.startsWith('ref-prefix ')) prefixes.push(text.slice('ref-prefix '.length));
  }
  const out: Buffer[] = [];
  const all = collectRefLines(repo);
  const wanted = all.filter((line) => {
    if (line.unborn) return unborn;
    if (prefixes.length === 0) return true;
    return prefixes.some((p) => line.name.startsWith(p));
  });
  for (const line of wanted) {
    let text = `${line.oid} ${line.name}`;
    if (peel && line.peeled !== undefined) text += ` peeled:${line.peeled}`;
    if (symrefs && line.symrefTarget !== undefined) text += ` symref-target:${line.symrefTarget}`;
    if (line.unborn) {
      // Baris unborn: oid diganti kata "unborn".
      text = `unborn ${line.name}`;
      if (symrefs && line.symrefTarget !== undefined) text += ` symref-target:${line.symrefTarget}`;
    }
    out.push(pkt(text + '\n'));
  }
  out.push(FLUSH);
  return {
    status: 200,
    contentType: 'application/x-git-upload-pack-result',
    body: Buffer.concat(out),
  };
}

// ---------------------------------------------------------------------------
// Fetch (upload-pack v2 & v0)
// ---------------------------------------------------------------------------

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallows: string[];
  depth: number | null;
}

/** Pecah permintaan fetch v2 menjadi wants/haves/shallow/depth. */
function parseFetchV2(body: Buffer): FetchRequest {
  const reader = new PktReader(body);
  const items = reader.readUntilFlush();
  const out: FetchRequest = { wants: [], haves: [], shallows: [], depth: null };
  let seenDelim = false;
  for (const item of items) {
    if (item.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (item.kind !== 'data') continue;
    const text = item.payload.toString('utf8').trim();
    if (!seenDelim) continue;
    if (text.startsWith('want ')) out.wants.push(text.slice(5).trim());
    else if (text.startsWith('have ')) out.haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) out.shallows.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) out.depth = Number(text.slice(7).trim());
  }
  return out;
}

/** Pecah permintaan fetch v0: bagian wants, lalu flush, lalu bagian haves. */
function parseFetchV0(body: Buffer): FetchRequest {
  const reader = new PktReader(body);
  const out: FetchRequest = { wants: [], haves: [], shallows: [], depth: null };
  let section = 0; // 0 = wants, 1 = haves
  while (!reader.atEnd) {
    const item = reader.next();
    if (item === null) break;
    if (item.kind === 'flush') {
      section = 1;
      continue;
    }
    if (item.kind !== 'data') continue;
    let text = item.payload.toString('utf8').trim();
    // Baris want pertama membawa capabilities setelah NUL.
    const nul = text.indexOf('\0');
    if (nul !== -1) text = text.slice(0, nul);
    if (text.startsWith('want ')) out.wants.push(text.slice(5).trim());
    else if (text.startsWith('have ')) out.haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) out.shallows.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) out.depth = Number(text.slice(7).trim());
  }
  return out;
}

/**
 * Hitung objek yang harus dikirim untuk sebuah fetch.
 *
 * - Kandidat: closure penuh dari semua want (dengan batas depth bila ada),
 *   termasuk objek tag yang diminta langsung.
 * - Yang sudah dimiliki klien dikurangi: untuk fetch biasa, closure penuh
 *   dari haves; untuk fetch dangkal, hanya commit have itu sendiri beserta
 *   tree-nya (riwayat di atasnya belum dimiliki klien).
 * - Batas dangkal baru: daun dari jalan want (commit yang parent-nya tidak
 *   ikut terambil); batas lama yang riwayatnya belum terambil tetap dibawa.
 */
function computeFetch(
  repo: RepoRecord,
  req: FetchRequest,
): { objects: Map<string, GitObject>; shallow: string[]; unshallow: string[] } {
  const lookup = (oid: string) => repo.objects.get(oid);
  const shallowMode = req.depth !== null || req.shallows.length > 0;

  // Commit yang diminta (dengan batas depth) + objek tag langsung.
  const tagObjects = new Map<string, GitObject>();
  const commitRoots: string[] = [];
  for (const want of req.wants) {
    const obj = repo.objects.get(want);
    if (obj === undefined) continue;
    if (obj.kind === 'tag') {
      tagObjects.set(want, obj);
      commitRoots.push(decodeTag(obj.bytes).object);
    } else if (obj.kind === 'commit') {
      commitRoots.push(want);
    } else {
      // Tree/blob yang diminta langsung: kirim apa adanya.
      tagObjects.set(want, obj);
    }
  }
  const wantCommits = walkCommits(commitRoots, lookup, req.depth);

  // Closure kandidat.
  const candidates = new Map<string, GitObject>();
  closureObjects(wantCommits, lookup, candidates);
  for (const [oid, obj] of tagObjects) candidates.set(oid, obj);

  // Objek yang sudah dimiliki klien.
  const held = new Map<string, GitObject>();
  if (shallowMode) {
    const heldCommits: string[] = [];
    for (const have of req.haves) {
      const obj = repo.objects.get(have);
      if (obj === undefined) continue;
      if (obj.kind === 'tag') {
        held.set(have, obj);
        heldCommits.push(decodeTag(obj.bytes).object);
      } else if (obj.kind === 'commit') {
        heldCommits.push(have);
      }
    }
    // Hanya commit have + closure tree-nya, tanpa parent.
    for (const oid of heldCommits) {
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.kind !== 'commit') continue;
      held.set(oid, obj);
      const tree = decodeCommit(obj.bytes).tree;
      const tmp = new Map<string, GitObject>();
      closureObjects([oid], lookup, tmp);
      // Buang parent commit dari closure: hanya tree + blob yang ditahan.
      for (const [key, value] of tmp) {
        if (value.kind !== 'commit') held.set(key, value);
      }
      void tree;
    }
    for (const s of req.shallows) {
      const obj = repo.objects.get(s);
      if (obj !== undefined && obj.kind === 'commit' && !held.has(s)) {
        held.set(s, obj);
        const tmp = new Map<string, GitObject>();
        closureObjects([s], lookup, tmp);
        for (const [key, value] of tmp) {
          if (value.kind !== 'commit') held.set(key, value);
        }
      }
    }
  } else {
    const haveCommits = walkCommits(req.haves, lookup, null);
    closureObjects(haveCommits, lookup, held);
  }

  const send = new Map<string, GitObject>();
  for (const [oid, obj] of candidates) {
    if (!held.has(oid)) send.set(oid, obj);
  }

  // Batas dangkal.
  let shallow: string[] = [];
  let unshallow: string[] = [];
  if (shallowMode) {
    const inWant = new Set(wantCommits);
    const leaves: string[] = [];
    for (const oid of wantCommits) {
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.kind !== 'commit') continue;
      const parents = decodeCommit(obj.bytes).parents;
      if (parents.every((p) => !inWant.has(p))) leaves.push(oid);
    }
    const leafSet = new Set(leaves);
    shallow = [...leaves];
    for (const s of req.shallows) {
      if (!inWant.has(s) && !leafSet.has(s)) shallow.push(s);
    }
    unshallow = req.shallows.filter((s) => inWant.has(s) && !leafSet.has(s));
  }
  return { objects: send, shallow, unshallow };
}

/** Bungkus pack ke paket sideband band 1 (maks 65500 byte per baris). */
function sidebandPack(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 65500;
  for (let off = 0; off < pack.length; off += CHUNK) {
    const slice = pack.subarray(off, Math.min(off + CHUNK, pack.length));
    out.push(pkt(Buffer.concat([Buffer.from([1]), slice])));
  }
  if (pack.length === 0) {
    // Pack kosong tetap dikirim sebagai satu paket band 1 kosong? Tidak:
    // pack 0 objek punya header+trailer 32 byte, jadi tidak pernah kosong.
  }
  return out;
}

export function handleUploadPack(repo: RepoRecord, body: Buffer, v2: boolean): GitResponse {
  const req = v2 ? parseFetchV2(body) : parseFetchV0(body);
  const { objects, shallow, unshallow } = computeFetch(repo, req);
  const pack = buildPack(objects);
  const lookup = (oid: string) => repo.objects.get(oid);
  const allHavesKnown = req.haves.length > 0 && req.haves.every((h) => lookup(h) !== undefined);

  if (v2) {
    const parts: Buffer[] = [];
    parts.push(pkt('acknowledgments\n'));
    if (allHavesKnown) {
      parts.push(pkt(`ACK ${req.haves[0]}\n`));
      parts.push(pkt('ready\n'));
    } else {
      parts.push(pkt('NAK\n'));
    }
    parts.push(DELIM);
    if (shallow.length > 0 || unshallow.length > 0) {
      parts.push(pkt('shallow-info\n'));
      for (const oid of shallow) parts.push(pkt(`shallow ${oid}\n`));
      for (const oid of unshallow) parts.push(pkt(`unshallow ${oid}\n`));
      parts.push(DELIM);
    }
    parts.push(pkt('packfile\n'));
    parts.push(...sidebandPack(pack));
    parts.push(FLUSH);
    return {
      status: 200,
      contentType: 'application/x-git-upload-pack-result',
      body: Buffer.concat(parts),
    };
  }

  const parts: Buffer[] = [];
  parts.push(pkt('NAK\n'));
  for (const oid of shallow) parts.push(pkt(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(pkt(`unshallow ${oid}\n`));
  parts.push(...sidebandPack(pack));
  parts.push(FLUSH);
  return {
    status: 200,
    contentType: 'application/x-git-upload-pack-result',
    body: Buffer.concat(parts),
  };
}

// ---------------------------------------------------------------------------
// Receive-pack (push v0)
// ---------------------------------------------------------------------------

interface RefUpdate {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(repo: RepoRecord, body: Buffer): GitResponse {
  const reader = new PktReader(body);
  const commands: RefUpdate[] = [];
  let clientCaps = new Map<string, string>();
  let first = true;
  while (!reader.atEnd) {
    const item = reader.next();
    if (item === null) break;
    if (item.kind === 'flush') break;
    if (item.kind !== 'data') continue;
    let text = item.payload.toString('utf8');
    if (first) {
      const nul = text.indexOf('\0');
      if (nul !== -1) {
        clientCaps = parseCaps(text.slice(nul + 1));
        text = text.slice(0, nul);
      }
      first = false;
    }
    const line = text.trim();
    if (line === '') continue;
    const parts = line.split(/\s+/);
    if (parts.length < 3) continue;
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
  }
  const packBytes = reader.remaining;

  const reportLines: string[] = [];
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      const parsed = parsePack(packBytes);
      for (const [oid, obj] of parsed) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : String(err);
    }
  }

  const lookup = (oid: string) => repo.objects.get(oid);
  const results: { ref: string; ok: boolean; reason: string }[] = [];
  for (const cmd of commands) {
    if (!unpackOk) {
      results.push({ ref: cmd.ref, ok: false, reason: 'unpack failed' });
      continue;
    }
    if (cmd.newOid === ZERO_OID) {
      // Hapus ref.
      const current = repo.refs.get(cmd.ref);
      if (current === undefined) {
        results.push({ ref: cmd.ref, ok: false, reason: 'no such ref' });
      } else if (cmd.oldOid !== ZERO_OID && current !== cmd.oldOid) {
        results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        repo.refs.delete(cmd.ref);
        results.push({ ref: cmd.ref, ok: true, reason: '' });
      }
      continue;
    }
    const current = repo.refs.get(cmd.ref);
    if (cmd.oldOid === ZERO_OID) {
      // Buat ref baru.
      if (current !== undefined) {
        results.push({ ref: cmd.ref, ok: false, reason: 'already exists' });
      } else if (repo.objects.get(cmd.newOid) === undefined) {
        results.push({ ref: cmd.ref, ok: false, reason: 'missing object' });
      } else {
        repo.refs.set(cmd.ref, cmd.newOid);
        results.push({ ref: cmd.ref, ok: true, reason: '' });
      }
      continue;
    }
    // Update ref yang ada.
    if (current === undefined) {
      results.push({ ref: cmd.ref, ok: false, reason: 'no such ref' });
    } else if (current !== cmd.oldOid) {
      results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
    } else if (cmd.newOid === current) {
      results.push({ ref: cmd.ref, ok: true, reason: '' });
    } else if (repo.objects.get(cmd.newOid) === undefined) {
      results.push({ ref: cmd.ref, ok: false, reason: 'missing object' });
    } else if (!isAncestor(current, cmd.newOid, lookup)) {
      results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
    } else {
      repo.refs.set(cmd.ref, cmd.newOid);
      results.push({ ref: cmd.ref, ok: true, reason: '' });
    }
  }

  if (unpackOk) reportLines.push('unpack ok');
  else reportLines.push(`unpack ${unpackDetail}`);
  for (const r of results) {
    reportLines.push(r.ok ? `ok ${r.ref}` : `ng ${r.ref} ${r.reason}`);
  }

  const useSideband = clientCaps.has('side-band-64k');
  const parts: Buffer[] = [];
  for (const line of reportLines) {
    if (useSideband) {
      parts.push(pkt(Buffer.concat([Buffer.from([1]), Buffer.from(line + '\n', 'utf8')])));
    } else {
      parts.push(pkt(line + '\n'));
    }
  }
  parts.push(FLUSH);
  return {
    status: 200,
    contentType: 'application/x-git-receive-pack-result',
    body: Buffer.concat(parts),
  };
}
