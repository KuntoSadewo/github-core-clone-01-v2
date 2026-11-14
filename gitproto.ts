// gitproto.ts — git smart HTTP: pkt-lines, v0/v2 advertisements, ls-refs, fetch, receive-pack.
// The only client is the suite's git-client.ts; this mirrors its exact wire expectations.

import {
  collectReachable,
  hashObject,
  isAncestor,
  parseCommit,
  parseTag,
  parseTree,
  readPack,
  verifyPackChecksum,
  writePack,
  ZERO_OID,
  type GitObject,
} from './gitutil.ts';
import { DEFAULT_BRANCH, VIEWER, type Repo, type Store } from './store.ts';

export const AGENT = 'pocket-forge/1.0.0';

// ---------------------------------------------------------------------------
// pkt-line framing
// ---------------------------------------------------------------------------

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export type PktLine =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

export function encodePktLines(lines: Array<string | Buffer | 'flush' | 'delim' | 'response-end'>): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(pktFlush());
    else if (line === 'delim') parts.push(pktDelim());
    else if (line === 'response-end') parts.push(Buffer.from('0002', 'ascii'));
    else parts.push(pktLine(line));
  }
  return Buffer.concat(parts);
}

/** Decode a whole pkt-line stream. Throws on malformed framing. */
export function decodePktLines(buffer: Buffer): PktLine[] {
  const out: PktLine[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line header');
    const length = parseInt(buffer.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(length)) throw new Error('pkt-line length is not hex');
    if (length === 0) {
      out.push({ kind: 'flush' });
      offset += 4;
    } else if (length === 1) {
      out.push({ kind: 'delim' });
      offset += 4;
    } else if (length === 2) {
      out.push({ kind: 'response-end' });
      offset += 4;
    } else {
      if (offset + length > buffer.length) throw new Error('truncated pkt-line payload');
      out.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
      offset += length;
    }
  }
  return out;
}

/** Split a receive-pack/upload-pack body into pkt-lines and the trailing raw bytes (a pack). */
export function splitBody(buffer: Buffer): { packets: PktLine[]; rest: Buffer } {
  let offset = 0;
  const packets: PktLine[] = [];
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) break;
    const length = parseInt(buffer.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(length)) break;
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      break;
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
    if (offset + length > buffer.length) break;
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, rest: buffer.subarray(offset) };
}

// ---------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------

function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  return [...repo.refs.entries()]
    .map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function uploadPackCaps(): string {
  return `side-band-64k thin-pack ofs-delta multi_ack symref=HEAD:refs/heads/${DEFAULT_BRANCH} agent=${AGENT}`;
}

function receivePackCaps(): string {
  return `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
}

/** A v0 ref advertisement, with the `# service=` preamble. */
export function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? uploadPackCaps() : receivePackCaps();
  const lines: Array<string | 'flush'> = [`# service=${service}\n`, 'flush'];
  const refs = sortedRefs(repo);
  const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`, 'flush');
    return encodePktLines(lines);
  }
  let first = true;
  const emit = (oid: string, name: string): void => {
    if (first) {
      lines.push(`${oid} ${name}\0${caps}\n`);
      first = false;
    } else {
      lines.push(`${oid} ${name}\n`);
    }
  };
  if (tip !== undefined) emit(tip, 'HEAD');
  for (const ref of refs) {
    emit(ref.oid, ref.name);
    const object = repo.objects.get(ref.oid);
    if (object !== undefined && object.type === 'tag') {
      const peeled = store_peel(repo, ref.oid);
      lines.push(`${peeled} ${ref.name}^{}\n`);
    }
  }
  lines.push('flush');
  return encodePktLines(lines);
}

function store_peel(repo: Repo, oid: string): string {
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'tag') return oid;
  return store_peel(repo, parseTag(object.data).object);
}

/** A protocol v2 capability advertisement. */
export function v2Advertisement(): Buffer {
  return encodePktLines([
    'version 2\n',
    `agent=${AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow wait-for-done\n',
    'object-format=sha1\n',
    'flush',
  ]);
}

// ---------------------------------------------------------------------------
// ls-refs (v2)
// ---------------------------------------------------------------------------

export interface LsRefsRequest {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

export function handleLsRefs(repo: Repo, body: Buffer): Buffer {
  const { packets } = splitBody(body);
  const request: LsRefsRequest = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  let seenCommand = false;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line === 'command=ls-refs') {
      seenCommand = true;
      continue;
    }
    if (line === 'peel') request.peel = true;
    else if (line === 'symrefs') request.symrefs = true;
    else if (line === 'unborn') request.unborn = true;
    else if (line.startsWith('ref-prefix ')) request.prefixes.push(line.slice('ref-prefix '.length));
  }
  void seenCommand;
  const lines: Array<string | 'flush'> = [];
  const refs = sortedRefs(repo);
  const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const keep = (name: string): boolean =>
    request.prefixes.length === 0 || request.prefixes.some((prefix) => name.startsWith(prefix));
  if (refs.length === 0) {
    if (request.unborn) {
      lines.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
    }
    lines.push('flush');
    return encodePktLines(lines);
  }
  if (keep('HEAD') && request.prefixes.length === 0 && defaultTip !== undefined) {
    lines.push(`${defaultTip} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
  }
  for (const ref of refs) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    const object = repo.objects.get(ref.oid);
    if (request.peel && object !== undefined && object.type === 'tag') {
      line += ` peeled:${store_peel(repo, ref.oid)}`;
    }
    lines.push(`${line}\n`);
  }
  lines.push('flush');
  return encodePktLines(lines);
}

// ---------------------------------------------------------------------------
// fetch (v2 and v0 share the object selection)
// ---------------------------------------------------------------------------

export interface FetchRequest {
  wants: string[];
  haves: string[];
  shallowBoundaries: string[];
  deepen: number | null;
}

export interface FetchSelection {
  objects: Map<string, GitObject>;
  shallow: string[];
  unshallow: string[];
}

/** Objects reachable from `roots`, stopping the walk at shallow boundaries (their parents are not held). */
function reachableBounded(repo: Repo, roots: Iterable<string>, boundaries: ReadonlySet<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid) || oid === ZERO_OID) continue;
    const object = lookup(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (boundaries.has(oid)) continue;
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

export function selectFetchObjects(repo: Repo, request: FetchRequest): FetchSelection {
  const boundarySet = new Set(request.shallowBoundaries);
  const haveReachable = reachableBounded(repo, request.haves, boundarySet);
  const haveCommits = new Set<string>();
  for (const oid of haveReachable) {
    const object = repo.objects.get(oid);
    if (object !== undefined && object.type === 'commit') haveCommits.add(oid);
  }
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);

  // Peel wanted tags to their commits for the depth walk, but keep the tag objects themselves.
  const wantedTagObjects = new Map<string, string>();
  const wantCommits: string[] = [];
  for (const want of request.wants) {
    const object = repo.objects.get(want);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      wantedTagObjects.set(want, store_peel(repo, want));
      wantCommits.push(store_peel(repo, want));
    } else if (object.type === 'commit') {
      wantCommits.push(want);
    }
  }

  let includedCommits: Set<string>;
  if (request.deepen !== null) {
    // Depth-limited: commits closer than `deepen` from a want, minus what the client holds.
    const depth = new Map<string, number>();
    const queue: Array<{ oid: string; d: number }> = wantCommits.map((oid) => ({ oid, d: 0 }));
    while (queue.length > 0) {
      const { oid, d } = queue.shift() as { oid: string; d: number };
      if (d >= (request.deepen as number)) continue;
      if (depth.has(oid)) continue;
      depth.set(oid, d);
      const commit = repo.objects.get(oid);
      if (commit === undefined || commit.type !== 'commit') continue;
      for (const parent of parseCommit(commit.data).parents) queue.push({ oid: parent, d: d + 1 });
    }
    includedCommits = new Set([...depth.keys()].filter((oid) => !haveCommits.has(oid)));
  } else {
    const all = new Set<string>();
    for (const want of wantCommits) {
      try {
        for (const oid of collectReachable([want], lookup)) all.add(oid);
      } catch {
        // A want the store does not hold contributes nothing.
      }
    }
    includedCommits = new Set([...all].filter((oid) => !haveReachable.has(oid)));
  }

  // The objects to send, minus what the client holds. A full fetch sends the included
  // commits' whole closure. A depth-limited fetch sends only the included commits plus
  // the trees and blobs reachable from their trees — never a parent commit.
  const objects = new Map<string, GitObject>();
  if (request.deepen !== null) {
    for (const oid of includedCommits) {
      const commit = repo.objects.get(oid);
      if (commit === undefined || commit.type !== 'commit') continue;
      if (!haveReachable.has(oid)) objects.set(oid, commit);
      const tree = parseCommit(commit.data).tree;
      try {
        for (const treeOid of collectReachable([tree], lookup)) {
          if (haveReachable.has(treeOid)) continue;
          const object = repo.objects.get(treeOid);
          if (object !== undefined) objects.set(treeOid, object);
        }
      } catch {
        // A missing tree contributes nothing.
      }
    }
  } else {
    const closure = collectReachable([...includedCommits], lookup);
    for (const oid of closure) {
      if (haveReachable.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (object !== undefined) objects.set(oid, object);
    }
  }
  // Wanted tag objects whose target is included ride along.
  for (const [tagOid, target] of wantedTagObjects) {
    if (includedCommits.has(target) || request.deepen === null) {
      const object = repo.objects.get(tagOid);
      if (object !== undefined && !haveReachable.has(tagOid)) objects.set(tagOid, object);
    }
  }

  let shallow: string[] = [];
  let unshallow: string[] = [];
  if (request.deepen !== null) {
    for (const oid of includedCommits) {
      const commit = repo.objects.get(oid);
      if (commit === undefined || commit.type !== 'commit') continue;
      const parents = parseCommit(commit.data).parents;
      if (parents.some((parent) => !includedCommits.has(parent))) shallow.push(oid);
    }
    for (const boundary of request.shallowBoundaries) {
      const commit = repo.objects.get(boundary);
      if (commit === undefined || commit.type !== 'commit') continue;
      const parents = parseCommit(commit.data).parents;
      if (parents.some((parent) => includedCommits.has(parent))) unshallow.push(boundary);
    }
  }
  return { objects, shallow, unshallow };
}

const SIDEBAND_CHUNK = 32768;

function sidebandPackets(pack: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  for (let offset = 0; offset < pack.length; offset += SIDEBAND_CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + SIDEBAND_CHUNK));
    packets.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (pack.length === 0) packets.push(pktLine(Buffer.from([1])));
  return packets;
}

export function handleFetchV2(repo: Repo, body: Buffer): Buffer {
  const { packets } = splitBody(body);
  const request: FetchRequest = { wants: [], haves: [], shallowBoundaries: [], deepen: null };
  let inArgs = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!inArgs) continue;
    if (line.startsWith('want ')) request.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) request.shallowBoundaries.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) request.deepen = Number.parseInt(line.slice(7).trim(), 10);
  }
  const selection = selectFetchObjects(repo, request);
  const pack = writePack(selection.objects.values());
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  parts.push(pktLine('NAK\n'));
  parts.push(pktDelim());
  if (request.deepen !== null && (selection.shallow.length > 0 || selection.unshallow.length > 0)) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  parts.push(pktLine('packfile\n'));
  for (const packet of sidebandPackets(pack)) parts.push(packet);
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

export function handleFetchV0(repo: Repo, body: Buffer): Buffer {
  const { packets } = splitBody(body);
  const request: FetchRequest = { wants: [], haves: [], shallowBoundaries: [], deepen: null };
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) request.wants.push(line.slice(5).split(' ')[0] as string);
    else if (line.startsWith('shallow ')) request.shallowBoundaries.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) request.deepen = Number.parseInt(line.slice(7).trim(), 10);
    else if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
  }
  void section;
  const selection = selectFetchObjects(repo, request);
  const pack = writePack(selection.objects.values());
  const parts: Buffer[] = [];
  parts.push(pktLine('NAK\n'));
  for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  for (const packet of sidebandPackets(pack)) parts.push(packet);
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// receive-pack (v0)
// ---------------------------------------------------------------------------

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export interface PushReportLine {
  ref: string;
  ok: boolean;
  reason: string;
}

export function handleReceivePack(repo: Repo, store: Store, body: Buffer): Buffer {
  const { packets, rest } = splitBody(body);
  const commands: PushCommand[] = [];
  let sideband = false;
  let malformed = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8');
    const nul = text.indexOf('\0');
    const line = (nul >= 0 ? text.slice(0, nul) : text).replace(/\n$/, '');
    if (nul >= 0) {
      const caps = text.slice(nul + 1).replace(/\n$/, '');
      if (caps.split(' ').includes('side-band-64k')) sideband = true;
    }
    const parts = line.split(' ');
    if (parts.length !== 3) {
      malformed = true;
      continue;
    }
    const [oldOid, newOid, ref] = parts as [string, string, string];
    commands.push({ oldOid, newOid, ref });
  }
  if (commands.length === 0) malformed = true;

  const reportLines: string[] = [];
  let unpackOk = true;
  let unpackDetail = 'ok';
  const updatesRef = commands.some((command) => command.newOid !== ZERO_OID);
  if (!malformed && updatesRef && rest.length > 0) {
    const checksum = verifyPackChecksum(rest);
    if (!checksum.ok) {
      unpackOk = false;
      unpackDetail = 'pack checksum mismatch';
    } else {
      try {
        const { objects } = readPack(rest, { resolveBase: (oid) => repo.objects.get(oid) });
        for (const [oid, object] of objects) {
          if (!repo.objects.has(oid)) repo.objects.set(oid, object);
        }
      } catch (err) {
        unpackOk = false;
        unpackDetail = err instanceof Error ? err.message : 'unpack failed';
      }
    }
  } else if (!malformed && updatesRef && rest.length === 0) {
    unpackOk = false;
    unpackDetail = 'missing pack';
  }

  const results: PushReportLine[] = [];
  for (const command of commands) {
    if (!unpackOk) {
      results.push({ ref: command.ref, ok: false, reason: 'unpacker error' });
      continue;
    }
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === ZERO_OID) {
        results.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        repo.refs.delete(command.ref);
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (!repo.objects.has(command.newOid)) {
      results.push({ ref: command.ref, ok: false, reason: 'missing object' });
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      // Create.
      if (current !== ZERO_OID) {
        results.push({ ref: command.ref, ok: false, reason: 'already exists' });
      } else {
        repo.refs.set(command.ref, command.newOid);
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    // Update: old must match, and the new tip must descend from the current one.
    if (command.oldOid !== current) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
    } else if (!isAncestor(current, command.newOid, (oid) => repo.objects.get(oid))) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
    } else {
      repo.refs.set(command.ref, command.newOid);
      results.push({ ref: command.ref, ok: true, reason: '' });
    }
  }
  void store;
  void reportLines;

  const lines: string[] = [`unpack ${unpackDetail}\n`];
  for (const result of results) {
    lines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`);
  }
  const report = encodePktLines(lines);
  if (sideband) {
    const parts: Buffer[] = [];
    for (let offset = 0; offset < report.length; offset += SIDEBAND_CHUNK) {
      const chunk = report.subarray(offset, Math.min(report.length, offset + SIDEBAND_CHUNK));
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
    }
    parts.push(pktFlush());
    return Buffer.concat(parts);
  }
  return Buffer.concat([report, pktFlush()]);
}

/** Parse an upload-pack command body: returns 'ls-refs', 'fetch' or null. */
export function uploadPackCommand(body: Buffer): string | null {
  const { packets } = splitBody(body);
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('command=')) return line.slice('command='.length);
  }
  return null;
}
