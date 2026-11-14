// store.ts — the forge's whole state: repositories, git objects, issues, pull requests.
// In-memory only; a trial starts empty. Deterministic timestamps: MAKEFUN_TRIAL_NOW plus a
// monotonic counter, never the wall clock (the replay must see the same bytes).

import {
  buildCommit,
  buildTree,
  collectReachable,
  hashObject,
  isAncestor,
  parseCommit,
  parseTag,
  parseTree,
  ZERO_OID,
  type GitObject,
} from './gitutil.ts';

export const VIEWER = Object.freeze({
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
});

export const DEFAULT_BRANCH = 'main';

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface Comment {
  id: number;
  body: string;
  createdSeq: number;
  createdAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
  comments: Comment[];
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: Pull[];
  nextIssueNumber: number;
  nextPullNumber: number;
}

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  oldOid: string | null;
  newOid: string | null;
}

function b64encode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

export function globalId(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from([kind, ...parts].join(':'), 'utf8').toString('base64');
}

export function parseGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (kind === undefined || kind === '' || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

export class Store {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 10000;
  private nextIssueId = 100000;
  private nextPullId = 200000;
  private nextCommentId = 300000;
  private nextLabelId = 400000;
  private seq = 0;
  private readonly baseEpochSec: number;

  constructor() {
    const now = process.env.MAKEFUN_TRIAL_NOW ?? '';
    const parsed = now === '' ? NaN : Date.parse(now) / 1000;
    this.baseEpochSec = Number.isFinite(parsed) ? Math.trunc(parsed) : 1_735_689_600;
  }

  /** The next deterministic timestamp (seconds since epoch), advancing the counter. */
  nextEpochSec(): number {
    this.seq += 1;
    return this.baseEpochSec + this.seq;
  }

  iso(epochSec: number): string {
    return new Date(epochSec * 1000).toISOString().replace('.000Z', 'Z');
  }

  /** A fresh timestamp pair for a created object. */
  stamp(): { seq: number; epochSec: number; iso: string } {
    const epochSec = this.nextEpochSec();
    return { seq: this.seq, epochSec, iso: this.iso(epochSec) };
  }

  // ------------------------------------------------------------------ repos

  createRepo(name: string, options: { description?: string; private?: boolean }): Repo | null {
    if (this.repos.has(name)) return null;
    const stamp = this.stamp();
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      owner: VIEWER.login,
      description: options.description ?? '',
      private: options.private ?? false,
      defaultBranch: DEFAULT_BRANCH,
      createdSeq: stamp.seq,
      createdAt: stamp.iso,
      updatedAt: stamp.iso,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      nextIssueNumber: 1,
      nextPullNumber: 1,
    };
    this.nextRepoId += 1;
    this.repos.set(name, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    if (owner !== VIEWER.login) return undefined;
    return this.repos.get(name);
  }

  deleteRepo(name: string): boolean {
    return this.repos.delete(name);
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.createdSeq - b.createdSeq);
  }

  repoByGlobalId(id: string): Repo | undefined {
    const parsed = parseGlobalId(id);
    if (parsed === null || parsed.kind !== 'repo') return undefined;
    const dbid = Number(parsed.parts[0]);
    if (!Number.isInteger(dbid)) return undefined;
    for (const repo of this.repos.values()) if (repo.id === dbid) return repo;
    return undefined;
  }

  // ------------------------------------------------------------------ git refs

  refName(branch: string): string {
    return `refs/heads/${branch}`;
  }

  branchTip(repo: Repo, branch: string): string | null {
    return repo.refs.get(this.refName(branch)) ?? null;
  }

  defaultTip(repo: Repo): string | null {
    return this.branchTip(repo, repo.defaultBranch);
  }

  lookup(repo: Repo): (oid: string) => GitObject | undefined {
    return (oid: string) => repo.objects.get(oid);
  }

  /** The flat path -> {oid, mode} map of a tree, recursively. */
  flatTree(repo: Repo, treeOid: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, prefix: string): void => {
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** Build (and store) the nested trees for a flat path map; returns the root tree oid. */
  buildTreeFromFlat(repo: Repo, flat: Map<string, { oid: string; mode: string }>): string {
    interface Node {
      files: Map<string, { oid: string; mode: string }>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, entry] of [...flat.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const segments = path.split('/');
      let node = root;
      for (let i = 0; i < segments.length - 1; i += 1) {
        const segment = segments[i] as string;
        if (!node.dirs.has(segment)) node.dirs.set(segment, make());
        node = node.dirs.get(segment) as Node;
      }
      node.files.set(segments[segments.length - 1] as string, entry);
    }
    const build = (node: Node): string => {
      const entries: Array<{ mode: string; name: string; oid: string }> = [];
      for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      const data = buildTree(entries);
      const oid = hashObject('tree', data);
      if (!repo.objects.has(oid)) repo.objects.set(oid, { type: 'tree', data });
      return oid;
    };
    return build(root);
  }

  /** The flat file map at a commit, or an empty map for an unborn branch. */
  filesAt(repo: Repo, commitOid: string | null): Map<string, { oid: string; mode: string }> {
    if (commitOid === null) return new Map();
    const object = repo.objects.get(commitOid);
    if (object === undefined || object.type !== 'commit') return new Map();
    return this.flatTree(repo, parseCommit(object.data).tree);
  }

  commitObject(repo: Repo, commitOid: string): { tree: string; parents: string[] } | null {
    const object = repo.objects.get(commitOid);
    if (object === undefined || object.type !== 'commit') return null;
    const parsed = parseCommit(object.data);
    return { tree: parsed.tree, parents: parsed.parents };
  }

  /** The first commit reachable from both `headSha` and `baseSha` (linear histories: the branch point). */
  mergeBase(repo: Repo, headSha: string, baseSha: string): string | null {
    const baseAncestors = new Set<string>();
    const stack = [baseSha];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (baseAncestors.has(current)) continue;
      baseAncestors.add(current);
      const commit = this.commitObject(repo, current);
      if (commit === null) continue;
      for (const parent of commit.parents) stack.push(parent);
    }
    const queue = [headSha];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const current = queue.shift() as string;
      if (baseAncestors.has(current)) return current;
      if (seen.has(current)) continue;
      seen.add(current);
      const commit = this.commitObject(repo, current);
      if (commit === null) continue;
      for (const parent of commit.parents) queue.push(parent);
    }
    return null;
  }

  /** The path-level diff between two trees (merge-base -> head). */
  diffTrees(repo: Repo, baseTreeOid: string, headTreeOid: string): FileChange[] {
    const base = this.flatTree(repo, baseTreeOid);
    const head = this.flatTree(repo, headTreeOid);
    const changes: FileChange[] = [];
    const paths = new Set([...base.keys(), ...head.keys()]);
    for (const path of [...paths].sort()) {
      const oldEntry = base.get(path);
      const newEntry = head.get(path);
      if (oldEntry !== undefined && newEntry === undefined) {
        changes.push({ path, status: 'removed', oldOid: oldEntry.oid, newOid: null });
      } else if (oldEntry === undefined && newEntry !== undefined) {
        changes.push({ path, status: 'added', oldOid: null, newOid: newEntry.oid });
      } else if (oldEntry !== undefined && newEntry !== undefined && oldEntry.oid !== newEntry.oid) {
        changes.push({ path, status: 'modified', oldOid: oldEntry.oid, newOid: newEntry.oid });
      }
    }
    return changes;
  }

  /** Commits reachable from `tip`, newest first (first-parent walk, then by parent order). */
  listCommits(repo: Repo, tip: string | null): string[] {
    if (tip === null) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (seen.has(current)) continue;
      seen.add(current);
      const commit = this.commitObject(repo, current);
      if (commit === null) continue;
      out.push(current);
      for (let i = commit.parents.length - 1; i >= 0; i -= 1) stack.push(commit.parents[i] as string);
    }
    return out;
  }

  createBranch(repo: Repo, branch: string, sha: string): boolean {
    const ref = this.refName(branch);
    if (repo.refs.has(ref)) return false;
    if (!repo.objects.has(sha)) return false;
    repo.refs.set(ref, sha);
    return true;
  }

  // ------------------------------------------------------------- contents API

  commitFile(
    repo: Repo,
    options: { branch?: string; path: string; content: Buffer; message: string; sha?: string },
  ): { status: 201 | 200; commitSha: string; contentSha: string } | { status: 409; message: string } {
    const branch = options.branch ?? repo.defaultBranch;
    let tip = this.branchTip(repo, branch);
    if (tip === null && branch !== repo.defaultBranch) {
      // A write on a branch that does not exist yet starts from the default branch tip.
      tip = this.defaultTip(repo);
      if (tip !== null) repo.refs.set(this.refName(branch), tip);
    }
    const flat = this.filesAt(repo, tip);
    const existing = flat.get(options.path);
    if (options.sha !== undefined) {
      if (existing === undefined || existing.oid.toLowerCase() !== options.sha.toLowerCase()) {
        return { status: 409, message: 'sha does not match the current blob' };
      }
    }
    const contentSha = hashObject('blob', options.content);
    if (!repo.objects.has(contentSha)) repo.objects.set(contentSha, { type: 'blob', data: options.content });
    const created = existing === undefined;
    flat.set(options.path, { oid: contentSha, mode: '100644' });
    const treeOid = this.buildTreeFromFlat(repo, flat);
    const stamp = this.stamp();
    const identity = `${VIEWER.name} <${VIEWER.email}> ${stamp.epochSec} +0000`;
    const parents = tip === null ? [] : [tip];
    const commitData = buildCommit({ tree: treeOid, parents, author: identity, committer: identity, message: options.message });
    const commitSha = hashObject('commit', commitData);
    repo.objects.set(commitSha, { type: 'commit', data: commitData });
    repo.refs.set(this.refName(branch), commitSha);
    repo.updatedAt = stamp.iso;
    return { status: created ? 201 : 200, commitSha, contentSha };
  }

  deleteFile(
    repo: Repo,
    options: { branch?: string; path: string; message: string; sha?: string },
  ): { status: 200; commitSha: string } | { status: 404 | 409; message: string } {
    const branch = options.branch ?? repo.defaultBranch;
    const tip = this.branchTip(repo, branch);
    if (tip === null) return { status: 404, message: 'Not Found' };
    const flat = this.filesAt(repo, tip);
    const existing = flat.get(options.path);
    if (existing === undefined) return { status: 404, message: 'Not Found' };
    if (options.sha !== undefined && existing.oid.toLowerCase() !== options.sha.toLowerCase()) {
      return { status: 409, message: 'sha does not match the current blob' };
    }
    flat.delete(options.path);
    const treeOid = this.buildTreeFromFlat(repo, flat);
    const stamp = this.stamp();
    const identity = `${VIEWER.name} <${VIEWER.email}> ${stamp.epochSec} +0000`;
    const commitData = buildCommit({ tree: treeOid, parents: [tip], author: identity, committer: identity, message: options.message });
    const commitSha = hashObject('commit', commitData);
    repo.objects.set(commitSha, { type: 'commit', data: commitData });
    repo.refs.set(this.refName(branch), commitSha);
    repo.updatedAt = stamp.iso;
    return { status: 200, commitSha };
  }

  // ------------------------------------------------------------------- labels

  createLabel(repo: Repo, name: string, color: string): Label {
    const existing = repo.labels.get(name);
    if (existing !== undefined) return existing;
    const label: Label = { id: this.nextLabelId, name, color: color ?? 'ededed', description: '' };
    this.nextLabelId += 1;
    repo.labels.set(name, label);
    return label;
  }

  // ------------------------------------------------------------------- issues

  createIssue(repo: Repo, title: string, body: string, labelNames: string[]): Issue | { error: string } {
    for (const name of labelNames) {
      if (!repo.labels.has(name)) return { error: `label ${name} does not exist` };
    }
    const stamp = this.stamp();
    const issue: Issue = {
      id: this.nextIssueId,
      number: repo.nextIssueNumber,
      title,
      body: body ?? '',
      state: 'open',
      labels: [...labelNames],
      createdSeq: stamp.seq,
      createdAt: stamp.iso,
      updatedAt: stamp.iso,
      comments: [],
    };
    this.nextIssueId += 1;
    repo.nextIssueNumber += 1;
    repo.issues.push(issue);
    return issue;
  }

  issueByGlobalId(id: string): { repo: Repo; issue: Issue } | undefined {
    const parsed = parseGlobalId(id);
    if (parsed === null || parsed.kind !== 'issue') return undefined;
    const repoId = Number(parsed.parts[0]);
    const number = Number(parsed.parts[1]);
    if (!Number.isInteger(repoId) || !Number.isInteger(number)) return undefined;
    for (const repo of this.repos.values()) {
      if (repo.id !== repoId) continue;
      const issue = repo.issues.find((entry) => entry.number === number);
      if (issue !== undefined) return { repo, issue };
    }
    return undefined;
  }

  addComment(repo: Repo, issue: Issue, body: string): Comment {
    const stamp = this.stamp();
    const comment: Comment = { id: this.nextCommentId, body, createdSeq: stamp.seq, createdAt: stamp.iso };
    this.nextCommentId += 1;
    issue.comments.push(comment);
    issue.updatedAt = stamp.iso;
    return comment;
  }

  // --------------------------------------------------------------------- pulls

  createPull(repo: Repo, head: string, base: string, title: string, body: string): Pull | { error: string } {
    const headSha = this.branchTip(repo, head);
    const baseSha = this.branchTip(repo, base);
    if (headSha === null) return { error: `head branch ${head} does not exist` };
    if (baseSha === null) return { error: `base branch ${base} does not exist` };
    const stamp = this.stamp();
    const pull: Pull = {
      id: this.nextPullId,
      number: repo.nextPullNumber,
      title,
      body: body ?? '',
      state: 'open',
      headRef: head,
      baseRef: base,
      headSha,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      createdSeq: stamp.seq,
      createdAt: stamp.iso,
      updatedAt: stamp.iso,
    };
    this.nextPullId += 1;
    repo.nextPullNumber += 1;
    repo.pulls.push(pull);
    return pull;
  }

  pullByGlobalId(id: string): { repo: Repo; pull: Pull } | undefined {
    const parsed = parseGlobalId(id);
    if (parsed === null || parsed.kind !== 'pr') return undefined;
    const repoId = Number(parsed.parts[0]);
    const number = Number(parsed.parts[1]);
    if (!Number.isInteger(repoId) || !Number.isInteger(number)) return undefined;
    for (const repo of this.repos.values()) {
      if (repo.id !== repoId) continue;
      const pull = repo.pulls.find((entry) => entry.number === number);
      if (pull !== undefined) return { repo, pull };
    }
    return undefined;
  }

  /** MERGEABLE when the head's changes apply cleanly onto the base tip, else CONFLICTING. */
  mergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' {
    const baseSha = this.branchTip(repo, pull.baseRef) ?? pull.baseSha;
    const headSha = this.branchTip(repo, pull.headRef) ?? pull.headSha;
    const mb = this.mergeBase(repo, headSha, baseSha);
    if (mb === null) return 'CONFLICTING';
    const mbCommit = this.commitObject(repo, mb);
    const headCommit = this.commitObject(repo, headSha);
    const baseCommit = this.commitObject(repo, baseSha);
    if (mbCommit === null || headCommit === null || baseCommit === null) return 'CONFLICTING';
    const mbFlat = this.flatTree(repo, mbCommit.tree);
    const headFlat = this.flatTree(repo, headCommit.tree);
    const baseFlat = this.flatTree(repo, baseCommit.tree);
    for (const change of this.diffTrees(repo, mbCommit.tree, headCommit.tree)) {
      const baseOid = baseFlat.get(change.path)?.oid ?? null;
      const mbOid = mbFlat.get(change.path)?.oid ?? null;
      const headOid = headFlat.get(change.path)?.oid ?? null;
      if (baseOid !== mbOid && baseOid !== headOid) return 'CONFLICTING';
    }
    return 'MERGEABLE';
  }

  /** Squash-merge a pull request onto its base branch. */
  mergePull(repo: Repo, pull: Pull): { commitSha: string } | { error: string } {
    if (pull.state !== 'open') return { error: 'pull request is not open' };
    if (this.mergeable(repo, pull) !== 'MERGEABLE') return { error: 'merge conflict' };
    const baseSha = this.branchTip(repo, pull.baseRef) as string;
    const headSha = this.branchTip(repo, pull.headRef) as string;
    const mb = this.mergeBase(repo, headSha, baseSha) as string;
    const mbCommit = this.commitObject(repo, mb) as { tree: string; parents: string[] };
    const headCommit = this.commitObject(repo, headSha) as { tree: string; parents: string[] };
    const baseCommit = this.commitObject(repo, baseSha) as { tree: string; parents: string[] };
    const baseFlat = this.flatTree(repo, baseCommit.tree);
    for (const change of this.diffTrees(repo, mbCommit.tree, headCommit.tree)) {
      if (change.status === 'removed') baseFlat.delete(change.path);
      else if (change.newOid !== null) baseFlat.set(change.path, { oid: change.newOid, mode: '100644' });
    }
    const treeOid = this.buildTreeFromFlat(repo, baseFlat);
    const stamp = this.stamp();
    const identity = `${VIEWER.name} <${VIEWER.email}> ${stamp.epochSec} +0000`;
    const message = `Merge pull request #${pull.number} from ${VIEWER.login}/${pull.headRef}`;
    const commitData = buildCommit({ tree: treeOid, parents: [baseSha], author: identity, committer: identity, message });
    const commitSha = hashObject('commit', commitData);
    repo.objects.set(commitSha, { type: 'commit', data: commitData });
    repo.refs.set(this.refName(pull.baseRef), commitSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = stamp.iso;
    pull.mergeCommitSha = commitSha;
    pull.updatedAt = stamp.iso;
    repo.updatedAt = stamp.iso;
    return { commitSha };
  }

  /** The changed files of a pull request (merge-base -> head tip). */
  pullFiles(repo: Repo, pull: Pull): FileChange[] {
    const headSha = this.branchTip(repo, pull.headRef) ?? pull.headSha;
    const baseSha = this.branchTip(repo, pull.baseRef) ?? pull.baseSha;
    const mb = this.mergeBase(repo, headSha, baseSha);
    if (mb === null) return [];
    const mbCommit = this.commitObject(repo, mb);
    const headCommit = this.commitObject(repo, headSha);
    if (mbCommit === null || headCommit === null) return [];
    return this.diffTrees(repo, mbCommit.tree, headCommit.tree);
  }

  /** Objects reachable from the repo's refs (what a clone serves). */
  reachableObjects(repo: Repo): Set<string> {
    const tips = [...repo.refs.values()];
    try {
      return collectReachable(tips, this.lookup(repo));
    } catch {
      return new Set<string>();
    }
  }

  /** Whether `ancestor` is reachable from `oid` inside this repo. */
  isAncestorOf(repo: Repo, ancestor: string, oid: string): boolean {
    return isAncestor(ancestor, oid, this.lookup(repo));
  }

  /** Peel an annotated tag to its target commit (or return the oid unchanged). */
  peel(repo: Repo, oid: string): string {
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'tag') return oid;
    return this.peel(repo, parseTag(object.data).object);
  }
}

export { b64encode };
