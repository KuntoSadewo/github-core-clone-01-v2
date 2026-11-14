// store.ts — state in-memory forge: repository, objek git, issue, PR.
//
// Semua data hidup di memori proses. Tidak ada persistensi: setiap trial
// dimulai dari store kosong. Timestamp deterministik (counter dari epoch
// tetap) supaya commit SHA stabil antar run dengan urutan request sama.

import type { GitObject, ObjectKind } from './gitutil.ts';
import {
  ZERO_OID,
  objectId,
  encodeCommit,
  decodeCommit,
  encodeTree,
  decodeTree,
  encodeTag,
  decodeTag,
  mergeBase,
  isAncestor,
  walkCommits,
  closureObjects,
  treeGetPath,
  treeSetPath,
  treeRemovePath,
  treeListDir,
} from './gitutil.ts';

export const DEFAULT_BRANCH = 'main';
const EPOCH_BASE = 1735689600; // 2025-01-01T00:00:00Z — awal counter waktu

// ---------------------------------------------------------------------------
// Tipe record
// ---------------------------------------------------------------------------

export interface LabelRecord {
  name: string;
  color: string;
}

export interface CommentRecord {
  id: number;
  body: string;
  seq: number;
}

export type IssueState = 'open' | 'closed';

export interface IssueRecord {
  id: number;
  number: number;
  title: string;
  body: string;
  state: IssueState;
  labels: string[];
  seq: number;
  comments: CommentRecord[];
}

export type PullState = 'open' | 'closed';

export interface PullRecord {
  id: number;
  number: number;
  title: string;
  body: string;
  state: PullState;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  seq: number;
}

export interface RepoRecord {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  seq: number;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  labels: Map<string, LabelRecord>;
  issues: IssueRecord[];
  pulls: PullRecord[];
  /** nomor bersama issue + PR, mulai dari 1 */
  nextNumber: number;
  nextCommentId: number;
}

export interface FileChange {
  path: string;
  status: 'added' | 'removed' | 'modified';
  oldOid: string | null;
  newOid: string | null;
  additions: number;
  deletions: number;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class ForgeStore {
  private repos = new Map<string, RepoRecord>();
  private repoSeq = 0;
  private nextRepoId = 1;
  private nextIssueId = 1;
  private nextPullId = 1;
  private tickCount = 0;
  private requestSeq = 0;
  /** login pemilik token; dipelajari dari request pertama, default skenario */
  private knownViewer: string | null = null;

  /** Nomor urut request (untuk X-GitHub-Request-Id yang deterministik). */
  nextRequestId(): string {
    this.requestSeq += 1;
    return `req-${this.requestSeq}`;
  }

  /** Detik epoch deterministik berikutnya (dipakai commit + created_at). */
  tick(): number {
    this.tickCount += 1;
    return EPOCH_BASE + this.tickCount;
  }

  isoNow(): string {
    return new Date(this.tick() * 1000).toISOString();
  }

  /** Alokasi id numerik unik untuk issue / PR. */
  allocIssueId(): number {
    return this.nextIssueId++;
  }

  allocPullId(): number {
    return this.nextPullId++;
  }

  /** Catat owner yang terlihat di path; yang pertama menang. */
  noteOwner(owner: string): void {
    if (this.knownViewer === null && owner !== '') this.knownViewer = owner;
  }

  /** Login pemilik token saat ini. */
  viewerLogin(): string {
    return this.knownViewer ?? 'adaiversen';
  }

  private repoKey(owner: string, name: string): string {
    return `${owner.toLowerCase()}\0${name.toLowerCase()}`;
  }

  // -- repository -----------------------------------------------------------

  createRepo(
    name: string,
    opts: { description?: string; isPrivate?: boolean },
  ): { repo: RepoRecord; created: boolean } {
    const owner = this.viewerLogin();
    const key = this.repoKey(owner, name);
    const existing = this.repos.get(key);
    if (existing) return { repo: existing, created: false };
    this.repoSeq += 1;
    const repo: RepoRecord = {
      id: this.nextRepoId++,
      owner,
      name,
      description: opts.description ?? '',
      isPrivate: opts.isPrivate ?? false,
      defaultBranch: DEFAULT_BRANCH,
      seq: this.repoSeq,
      refs: new Map(),
      objects: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      nextNumber: 1,
      nextCommentId: 1,
    };
    this.repos.set(key, repo);
    return { repo, created: true };
  }

  getRepo(owner: string, name: string): RepoRecord | undefined {
    this.noteOwner(owner);
    return this.repos.get(this.repoKey(owner, name));
  }

  /** Semua repo milik satu owner, urutan pembuatan. */
  listReposByOwner(owner: string): RepoRecord[] {
    this.noteOwner(owner);
    const out: RepoRecord[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner.toLowerCase() === owner.toLowerCase()) out.push(repo);
    }
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  // -- global id (opaque, base64) -------------------------------------------

  repoGlobalId(repo: RepoRecord): string {
    return Buffer.from(`repo:${repo.owner}/${repo.name}`, 'utf8').toString('base64');
  }

  issueGlobalId(repo: RepoRecord, issue: IssueRecord): string {
    return Buffer.from(`issue:${repo.owner}/${repo.name}#${issue.number}`, 'utf8').toString('base64');
  }

  pullGlobalId(repo: RepoRecord, pull: PullRecord): string {
    return Buffer.from(`pr:${repo.owner}/${repo.name}#${pull.number}`, 'utf8').toString('base64');
  }

  commentGlobalId(repo: RepoRecord, issue: IssueRecord, comment: CommentRecord): string {
    return Buffer.from(
      `comment:${repo.owner}/${repo.name}#${issue.number}:${comment.id}`,
      'utf8',
    ).toString('base64');
  }

  /** Uraikan global id; mengembalikan jenis + repo + nomor bila cocok. */
  decodeGlobalId(
    gid: string,
  ): { kind: 'repo' | 'issue' | 'pr' | 'comment'; owner: string; name: string; number: number; commentId: number } | null {
    try {
      const text = Buffer.from(gid, 'base64').toString('utf8');
      const match = /^(repo|issue|pr|comment):([^/]+)\/([^#]+)(?:#(\d+))?(?::(\d+))?$/.exec(text);
      if (match === null) return null;
      return {
        kind: match[1] as 'repo' | 'issue' | 'pr' | 'comment',
        owner: match[2],
        name: match[3],
        number: match[4] === undefined ? 0 : Number(match[4]),
        commentId: match[5] === undefined ? 0 : Number(match[5]),
      };
    } catch {
      return null;
    }
  }

  // -- objek git --------------------------------------------------------------

  lookup(repo: RepoRecord): (oid: string) => GitObject | undefined {
    return (oid) => repo.objects.get(oid);
  }

  storeObject(repo: RepoRecord, kind: ObjectKind, bytes: Buffer): string {
    const oid = objectId(kind, bytes);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { kind, bytes });
    return oid;
  }

  /** Commit baru di atas parent tertentu; menyimpan objek, mengembalikan oid. */
  makeCommit(
    repo: RepoRecord,
    treeOid: string,
    parents: string[],
    message: string,
  ): string {
    const who = this.viewerLogin();
    const when = this.tick();
    const bytes = encodeCommit({
      tree: treeOid,
      parents,
      author: { name: who, email: `${who}@example.invalid`, when },
      committer: { name: who, email: `${who}@example.invalid`, when },
      message,
    });
    return this.storeObject(repo, 'commit', bytes);
  }

  /** Tip sebuah branch (atau null bila branch belum ada). */
  branchTip(repo: RepoRecord, branch: string): string | null {
    return repo.refs.get(`refs/heads/${branch}`) ?? null;
  }

  /** Semua branch: nama pendek -> tip. */
  listBranches(repo: RepoRecord): { name: string; sha: string }[] {
    const out: { name: string; sha: string }[] = [];
    for (const [ref, sha] of repo.refs) {
      if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), sha });
    }
    out.sort((a, b) => (a.name < b.name ? -1 : 1));
    return out;
  }

  /** Semua tag: nama pendek -> { oid, target }. */
  listTags(repo: RepoRecord): { name: string; oid: string; target: string | null }[] {
    const out: { name: string; oid: string; target: string | null }[] = [];
    for (const [ref, oid] of repo.refs) {
      if (!ref.startsWith('refs/tags/')) continue;
      const obj = repo.objects.get(oid);
      let target: string | null = null;
      if (obj !== undefined && obj.kind === 'tag') target = decodeTag(obj.bytes).object;
      else if (obj !== undefined) target = oid;
      out.push({ name: ref.slice('refs/tags/'.length), oid, target });
    }
    out.sort((a, b) => (a.name < b.name ? -1 : 1));
    return out;
  }

  /**
   * Selesaikan sebuah ref: nama branch, oid penuh, atau nama ref lengkap.
   * Mengembalikan oid commit atau null.
   */
  resolveRef(repo: RepoRecord, ref: string): string | null {
    if (/^[0-9a-f]{40}$/.test(ref)) {
      const obj = repo.objects.get(ref);
      if (obj === undefined) return null;
      if (obj.kind === 'commit') return ref;
      if (obj.kind === 'tag') return decodeTag(obj.bytes).object;
      return null;
    }
    if (ref.startsWith('refs/')) {
      const oid = repo.refs.get(ref);
      if (oid === undefined) return null;
      const obj = repo.objects.get(oid);
      if (obj?.kind === 'tag') return decodeTag(obj.bytes).object;
      return oid;
    }
    const tip = this.branchTip(repo, ref);
    if (tip !== null) return tip;
    return null;
  }

  /** Pesan commit (persis seperti tersimpan). */
  commitMessage(repo: RepoRecord, oid: string): string | null {
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.kind !== 'commit') return null;
    return decodeCommit(obj.bytes).message;
  }

  /** Daftar commit dari tip, terbaru dulu (urutan jalan parent pertama). */
  listCommits(repo: RepoRecord, tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length > 0) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (obj === undefined) continue;
      if (obj.kind === 'tag') {
        queue.push(decodeTag(obj.bytes).object);
        continue;
      }
      if (obj.kind !== 'commit') continue;
      out.push(oid);
      queue.push(...decodeCommit(obj.bytes).parents);
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Operasi file (contents API) — di atas objek git yang sama
// ---------------------------------------------------------------------------

export interface PutFileResult {
  commitOid: string;
  blobOid: string;
  created: boolean;
  branch: string;
}

export class ForgeStoreContents {
  private store: ForgeStore;
  constructor(store: ForgeStore) {
    this.store = store;
  }

  private lookup(repo: RepoRecord) {
    return this.store.lookup(repo);
  }

  /** Tree tip sebuah branch, atau null bila branch belum ada. */
  branchTree(repo: RepoRecord, branch: string): string | null {
    const tip = this.store.branchTip(repo, branch);
    if (tip === null) return null;
    const obj = repo.objects.get(tip);
    if (obj === undefined || obj.kind !== 'commit') return null;
    return decodeCommit(obj.bytes).tree;
  }

  /**
   * Tulis file. Bila branch belum ada, dibuat dari tip default (atau dari
   * nol bila repo masih kosong). Mengembalikan commit + blob baru.
   */
  putFile(
    repo: RepoRecord,
    branch: string,
    path: string,
    content: Buffer,
    message: string,
  ): PutFileResult {
    const lookup = this.lookup(repo);
    const existingTip = this.store.branchTip(repo, branch);
    const baseTree =
      existingTip !== null
        ? this.branchTree(repo, branch)
        : this.branchTree(repo, repo.defaultBranch);
    const wasPresent =
      baseTree !== null && treeGetPath(baseTree, path, lookup) !== null;
    const blobOid = this.store.storeObject(repo, 'blob', content);
    const newTree = treeSetPath(baseTree, path, blobOid, '100644', lookup, repo.objects);
    const parents = existingTip !== null ? [existingTip] : [];
    const commitOid = this.store.makeCommit(repo, newTree, parents, message);
    repo.refs.set(`refs/heads/${branch}`, commitOid);
    return { commitOid, blobOid, created: !wasPresent, branch };
  }

  /** Hapus file. Null bila file/branch tidak ada. */
  deleteFile(
    repo: RepoRecord,
    branch: string,
    path: string,
    message: string,
  ): { commitOid: string } | null {
    const lookup = this.lookup(repo);
    const tip = this.store.branchTip(repo, branch);
    if (tip === null) return null;
    const tree = this.branchTree(repo, branch);
    if (tree === null) return null;
    const nextTree = treeRemovePath(tree, path, lookup, repo.objects);
    if (nextTree === null) return null;
    const commitOid = this.store.makeCommit(repo, nextTree, [tip], message);
    repo.refs.set(`refs/heads/${branch}`, commitOid);
    return { commitOid };
  }

  /** Baca blob di sebuah path pada ref tertentu. */
  readPath(
    repo: RepoRecord,
    ref: string,
    path: string,
  ): { mode: string; oid: string; bytes: Buffer } | null {
    const commitOid = this.store.resolveRef(repo, ref);
    if (commitOid === null) return null;
    const obj = repo.objects.get(commitOid);
    if (obj === undefined || obj.kind !== 'commit') return null;
    const tree = decodeCommit(obj.bytes).tree;
    const found = treeGetPath(tree, path, this.lookup(repo));
    if (found === null || found.mode === '40000') return null;
    const blob = repo.objects.get(found.oid);
    if (blob === undefined || blob.kind !== 'blob') return null;
    return { mode: found.mode, oid: found.oid, bytes: blob.bytes };
  }

  /** Daftar direktori pada ref tertentu. */
  listDir(
    repo: RepoRecord,
    ref: string,
    path: string,
  ): { name: string; path: string; mode: string; oid: string }[] | null {
    const commitOid = this.store.resolveRef(repo, ref);
    if (commitOid === null) return null;
    const obj = repo.objects.get(commitOid);
    if (obj === undefined || obj.kind !== 'commit') return null;
    const tree = decodeCommit(obj.bytes).tree;
    const entries = treeListDir(tree, path, this.lookup(repo));
    if (entries === null) return null;
    const prefix = path === '' ? '' : path.replace(/\/$/, '') + '/';
    return entries.map((e) => ({
      name: e.name,
      path: prefix + e.name,
      mode: e.mode,
      oid: e.oid,
    }));
  }
}

// ---------------------------------------------------------------------------
// Diff & merge
// ---------------------------------------------------------------------------

function countLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/** Hitung tambahan/hapusan baris antara dua isi (perbedaan multiset baris). */
function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = countLines(oldText);
  const newLines = countLines(newText);
  const oldCount = new Map<string, number>();
  for (const line of oldLines) oldCount.set(line, (oldCount.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of newLines) {
    const left = oldCount.get(line) ?? 0;
    if (left > 0) oldCount.set(line, left - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const left of oldCount.values()) deletions += left;
  return { additions, deletions };
}

function flattenTree(
  repo: RepoRecord,
  treeOid: string,
  prefix: string,
  out: Map<string, { mode: string; oid: string }>,
): void {
  const obj = repo.objects.get(treeOid);
  if (obj === undefined || obj.kind !== 'tree') return;
  for (const entry of decodeTree(obj.bytes)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(repo, entry.oid, path, out);
    else out.set(path, { mode: entry.mode, oid: entry.oid });
  }
}

/** Diff dua tree: daftar perubahan per path. */
export function diffTrees(
  repo: RepoRecord,
  baseTreeOid: string | null,
  headTreeOid: string | null,
): FileChange[] {
  const base = new Map<string, { mode: string; oid: string }>();
  const head = new Map<string, { mode: string; oid: string }>();
  if (baseTreeOid !== null) flattenTree(repo, baseTreeOid, '', base);
  if (headTreeOid !== null) flattenTree(repo, headTreeOid, '', head);
  const paths = new Set([...base.keys(), ...head.keys()]);
  const changes: FileChange[] = [];
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b !== undefined && h === undefined) {
      changes.push({ path, status: 'removed', oldOid: b.oid, newOid: null, additions: 0, deletions: countLines(repo.objects.get(b.oid)?.bytes.toString('utf8') ?? '').length });
    } else if (b === undefined && h !== undefined) {
      const text = repo.objects.get(h.oid)?.bytes.toString('utf8') ?? '';
      changes.push({ path, status: 'added', oldOid: null, newOid: h.oid, additions: countLines(text).length, deletions: 0 });
    } else if (b !== undefined && h !== undefined && b.oid !== h.oid) {
      const oldText = repo.objects.get(b.oid)?.bytes.toString('utf8') ?? '';
      const newText = repo.objects.get(h.oid)?.bytes.toString('utf8') ?? '';
      const { additions, deletions } = lineDiff(oldText, newText);
      changes.push({ path, status: 'modified', oldOid: b.oid, newOid: h.oid, additions, deletions });
    }
  }
  return changes;
}

export interface MergeOutcome {
  ok: boolean;
  sha: string | null;
  conflict: boolean;
}

export class ForgeStoreMerge {
  private store: ForgeStore;
  constructor(store: ForgeStore) {
    this.store = store;
  }

  private treeOf(repo: RepoRecord, commitOid: string): string | null {
    const obj = repo.objects.get(commitOid);
    if (obj === undefined || obj.kind !== 'commit') return null;
    return decodeCommit(obj.bytes).tree;
  }

  /** Apakah merge squash PR ini akan konflik? */
  mergeable(repo: RepoRecord, pull: PullRecord): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    if (pull.state !== 'open') return 'UNKNOWN';
    const baseTip = this.store.branchTip(repo, pull.baseRef);
    if (baseTip === null) return 'UNKNOWN';
    const headObj = repo.objects.get(pull.headSha);
    if (headObj === undefined || headObj.kind !== 'commit') return 'UNKNOWN';
    const base = mergeBase(pull.headSha, baseTip, this.store.lookup(repo));
    const baseTree = base === null ? null : this.treeOf(repo, base);
    const headTree = this.treeOf(repo, pull.headSha);
    const tipTree = this.treeOf(repo, baseTip);
    const headChanges = diffTrees(repo, baseTree, headTree);
    const baseChanges = diffTrees(repo, baseTree, tipTree);
    const baseByPath = new Map(baseChanges.map((c) => [c.path, c]));
    for (const change of headChanges) {
      const other = baseByPath.get(change.path);
      if (other === undefined) continue;
      if (change.newOid !== other.newOid) return 'CONFLICTING';
    }
    return 'MERGEABLE';
  }

  /**
   * Lakukan squash merge: terapkan perubahan head ke atas tip base,
   * commit baru ber-parent tunggal (tip base), geser branch base.
   */
  merge(repo: RepoRecord, pull: PullRecord): MergeOutcome {
    if (pull.state !== 'open' || pull.merged) {
      return { ok: false, sha: null, conflict: false };
    }
    const baseTip = this.store.branchTip(repo, pull.baseRef);
    if (baseTip === null) return { ok: false, sha: null, conflict: false };
    const state = this.mergeable(repo, pull);
    if (state === 'CONFLICTING') return { ok: false, sha: null, conflict: true };
    if (state === 'UNKNOWN') return { ok: false, sha: null, conflict: false };
    const base = mergeBase(pull.headSha, baseTip, this.store.lookup(repo));
    const baseTree = base === null ? null : this.treeOf(repo, base);
    const headTree = this.treeOf(repo, pull.headSha);
    const tipTree = this.treeOf(repo, baseTip);
    const headChanges = diffTrees(repo, baseTree, headTree);
    // Terapkan perubahan head ke tree tip base, satu per satu.
    let resultTree = tipTree;
    const lookup = this.store.lookup(repo);
    for (const change of headChanges) {
      if (change.newOid === null) {
        if (resultTree !== null) {
          const next = treeRemovePath(resultTree, change.path, lookup, repo.objects);
          if (next !== null) resultTree = next;
        }
      } else {
        resultTree = treeSetPath(resultTree, change.path, change.newOid, '100644', lookup, repo.objects);
      }
    }
    if (resultTree === null) {
      const empty = encodeTree([]);
      resultTree = objectId('tree', empty);
      repo.objects.set(resultTree, { kind: 'tree', bytes: empty });
    }
    const message = pull.title;
    const sha = this.store.makeCommit(repo, resultTree, [baseTip], message);
    repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = new Date(this.store.tick() * 1000).toISOString();
    pull.mergeCommitSha = sha;
    return { ok: true, sha, conflict: false };
  }

  /** File yang diubah PR: diff merge-base -> head. */
  filesOf(repo: RepoRecord, pull: PullRecord): FileChange[] {
    const baseTip = this.store.branchTip(repo, pull.baseRef);
    const base = baseTip === null ? null : mergeBase(pull.headSha, baseTip, this.store.lookup(repo));
    const baseTree = base === null ? null : this.treeOf(repo, base);
    const headTree = this.treeOf(repo, pull.headSha);
    return diffTrees(repo, baseTree, headTree);
  }
}

// ---------------------------------------------------------------------------
// Issue & PR helpers (dipakai REST, GraphQL, MCP)
// ---------------------------------------------------------------------------

export class ForgeStoreIssues {
  private store: ForgeStore;
  constructor(store: ForgeStore) {
    this.store = store;
  }

  createIssue(
    repo: RepoRecord,
    title: string,
    body: string,
    labelNames: string[],
  ): { issue: IssueRecord } | { error: string } {
    for (const name of labelNames) {
      if (!repo.labels.has(name)) return { error: `label tidak dikenal: ${name}` };
    }
    const number = repo.nextNumber++;
    const issue: IssueRecord = {
      id: this.store.allocIssueId(),
      number,
      title,
      body,
      state: 'open',
      labels: [...labelNames],
      seq: number,
      comments: [],
    };
    repo.issues.push(issue);
    return { issue };
  }

  createPull(
    repo: RepoRecord,
    title: string,
    body: string,
    headRef: string,
    baseRef: string,
  ): { pull: PullRecord } | { error: string } {
    const headSha = this.store.branchTip(repo, headRef);
    if (headSha === null) return { error: `head tidak ada: ${headRef}` };
    const baseSha = this.store.branchTip(repo, baseRef);
    if (baseSha === null) return { error: `base tidak ada: ${baseRef}` };
    const dup = repo.pulls.find(
      (p) => p.state === 'open' && p.headRef === headRef && p.baseRef === baseRef,
    );
    if (dup) return { error: 'pull request sudah terbuka untuk branch ini' };
    const number = repo.nextNumber++;
    const pull: PullRecord = {
      id: this.store.allocPullId(),
      number,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef,
      headSha,
      baseRef,
      baseSha,
      seq: number,
    };
    repo.pulls.push(pull);
    return { pull };
  }

  addComment(repo: RepoRecord, issue: IssueRecord, body: string): CommentRecord {
    const comment: CommentRecord = {
      id: repo.nextCommentId++,
      body,
      seq: repo.nextCommentId,
    };
    issue.comments.push(comment);
    return comment;
  }
}
