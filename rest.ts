// rest.ts — GitHub REST v3 handlers. Pure functions over the Store: each returns a response
// object and app.ts does the HTTP plumbing. Every reply is JSON; errors carry {message}.

import { parseCommit } from './gitutil.ts';
import {
  VIEWER,
  globalId,
  type Issue,
  type Label,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

export interface ApiResponse {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
}

export interface RestRequest {
  method: string;
  segments: string[];
  query: URLSearchParams;
  body: unknown;
  baseUrl: string;
}

function ok(status: number, body: unknown, headers?: Record<string, string>): ApiResponse {
  return { status, headers, body };
}

function err(status: number, message: string): ApiResponse {
  return { status, body: { message } };
}

function notFound(what = 'Not Found'): ApiResponse {
  return err(404, what);
}

// ---------------------------------------------------------------------------
// JSON shapes
// ---------------------------------------------------------------------------

export function userJson(): Record<string, unknown> {
  return {
    login: VIEWER.login,
    id: VIEWER.id,
    node_id: globalId('user', VIEWER.id),
    avatar_url: `https://avatars.githubusercontent.com/u/${VIEWER.id}?v=4`,
    gravatar_id: '',
    url: `/api/v3/users/${VIEWER.login}`,
    html_url: `https://github.com/${VIEWER.login}`,
    type: 'User',
    site_admin: false,
    name: VIEWER.name,
    email: VIEWER.email,
    public_repos: 0,
    followers: 0,
    following: 0,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
  };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  const fullName = `${repo.owner}/${repo.name}`;
  return {
    id: repo.id,
    node_id: globalId('repo', repo.id),
    name: repo.name,
    full_name: fullName,
    private: repo.private,
    owner: userJson(),
    html_url: `https://github.com/${fullName}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${fullName}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    forks_count: 0,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    default_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

export function labelJson(label: Label, repo: Repo): Record<string, unknown> {
  return {
    id: label.id,
    node_id: globalId('label', repo.id, label.name),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('issue', repo.id, issue.number),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    labels_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/labels{/name}`,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    title: issue.title,
    user: userJson(),
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label !== undefined ? labelJson(label, repo) : { name, color: 'ededed', description: '' };
    }),
    state: issue.state,
    locked: false,
    assignee: null,
    assignees: [],
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    body: issue.body,
  };
}

export function commentJson(repo: Repo, issue: Issue, comment: { id: number; body: string; createdAt: string }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: globalId('comment', repo.id, issue.number, comment.id),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    user: userJson(),
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
    body: comment.body,
  };
}

export function pullJson(repo: Repo, pull: Pull, mergeable?: 'MERGEABLE' | 'CONFLICTING'): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  return {
    id: pull.id,
    node_id: globalId('pr', repo.id, pull.number),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    user: userJson(),
    body: pull.body,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    merged: pull.merged,
    mergeable: mergeable === undefined ? null : mergeable === 'MERGEABLE',
    head: {
      label: `${repo.owner}:${pull.headRef}`,
      ref: pull.headRef,
      sha: headSha,
      user: userJson(),
      repo: repoJson(repo),
    },
    base: {
      label: `${repo.owner}:${pull.baseRef}`,
      ref: pull.baseRef,
      sha: baseSha,
      user: userJson(),
      repo: repoJson(repo),
    },
  };
}

function branchJson(name: string, sha: string): Record<string, unknown> {
  return {
    name,
    commit: { sha, url: `/api/v3/repos/commits/${sha}` },
    protected: false,
  };
}

function parseIdentity(line: string): { name: string; email: string; date: string } {
  const match = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(line);
  if (match === null) return { name: line, email: '', date: '2025-01-01T00:00:00Z' };
  const epochSec = Number(match[3]);
  return {
    name: match[1] as string,
    email: match[2] as string,
    date: new Date(epochSec * 1000).toISOString().replace('.000Z', 'Z'),
  };
}

function commitJson(repo: Repo, sha: string): Record<string, unknown> | null {
  const object = repo.objects.get(sha);
  if (object === undefined || object.type !== 'commit') return null;
  const parsed = parseCommit(object.data);
  const author = parseIdentity(parsed.author);
  const committer = parseIdentity(parsed.committer);
  return {
    sha,
    node_id: globalId('commit', repo.id, sha),
    commit: {
      author,
      committer,
      message: parsed.message.replace(/\n+$/, ''),
      tree: { sha: parsed.tree },
      url: `/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha}`,
    },
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${sha}`,
    author: userJson(),
    committer: userJson(),
    parents: parsed.parents.map((parent) => ({ sha: parent, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${parent}` })),
  };
}

// ---------------------------------------------------------------------------
// pagination
// ---------------------------------------------------------------------------

function linkHeader(baseUrl: string, path: string, query: URLSearchParams, page: number, perPage: number, hasNext: boolean): string | null {
  if (!hasNext) return null;
  const next = new URLSearchParams(query);
  next.set('page', String(page + 1));
  next.set('per_page', String(perPage));
  return `<${baseUrl}${path}?${next.toString()}>; rel="next"`;
}

function pagedResponse<T>(items: readonly T[], req: RestRequest, path: string): ApiResponse {
  const perPage = Math.max(1, Math.min(100, Number(req.query.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(req.query.get('page') ?? '1') || 1);
  const start = (page - 1) * perPage;
  const pageItems = items.slice(start, start + perPage);
  const hasNext = start + perPage < items.length;
  const headers: Record<string, string> = {};
  const link = linkHeader(req.baseUrl, path, req.query, page, perPage, hasNext);
  if (link !== null) headers.link = link;
  return ok(200, pageItems, headers);
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function bodyObject(body: unknown): Record<string, unknown> {
  return body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function labelNamesOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') names.push(entry);
    else if (entry !== null && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string') {
      names.push((entry as { name: string }).name);
    }
  }
  return names;
}

function resolveRefTip(repo: Repo, ref: string | null): string | null {
  if (ref === null) return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  const direct = repo.refs.get(`refs/heads/${ref}`);
  if (direct !== undefined) return direct;
  if (repo.objects.has(ref)) return ref;
  return null;
}

// ---------------------------------------------------------------------------
// the router
// ---------------------------------------------------------------------------

export function handleRest(store: Store, req: RestRequest): ApiResponse {
  const seg = req.segments;
  // seg[0] is 'api', seg[1] is 'v3' (app.ts routes here only for /api/v3/*).
  const rest = seg.slice(2);

  if (rest.length === 0) {
    return ok(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
  }
  if (rest[0] === 'meta' && rest.length === 1 && req.method === 'GET') {
    return ok(200, { installed_version: '1.0.0', verifiable_password_authentication: true });
  }
  if (rest[0] === 'user' && rest.length === 1 && req.method === 'GET') {
    return ok(200, userJson());
  }
  if (rest[0] === 'user' && rest[1] === 'repos') {
    if (req.method === 'GET') {
      const repos = store.listRepos().map((repo) => repoJson(repo));
      return pagedResponse(repos, req, '/api/v3/user/repos');
    }
    if (req.method === 'POST') {
      const body = bodyObject(req.body);
      const name = asString(body.name);
      if (name === '') return err(422, 'name is required');
      if (store.repos.has(name)) return err(422, 'Repository already exists');
      const repo = store.createRepo(name, { description: asString(body.description), private: body.private === true });
      if (repo === null) return err(422, 'Repository already exists');
      return ok(201, repoJson(repo));
    }
    return notFound();
  }
  if (rest[0] === 'repos' && rest.length >= 3) {
    return handleRepo(store, req, rest);
  }
  return notFound();
}

function handleRepo(store: Store, req: RestRequest, rest: string[]): ApiResponse {
  const owner = decodeURIComponent(rest[1] as string);
  const name = decodeURIComponent(rest[2] as string);
  const repo = store.getRepo(owner, name);
  const tail = rest.slice(3);

  if (tail.length === 0) {
    if (repo === undefined) return notFound();
    if (req.method === 'GET') return ok(200, repoJson(repo));
    if (req.method === 'PATCH') {
      const body = bodyObject(req.body);
      if (typeof body.description === 'string') repo.description = body.description;
      return ok(200, repoJson(repo));
    }
    if (req.method === 'DELETE') {
      store.deleteRepo(name);
      return { status: 204, body: null };
    }
    return notFound();
  }
  if (repo === undefined) return notFound();

  // /branches
  if (tail[0] === 'branches') {
    if (tail.length === 1 && req.method === 'GET') {
      const branches = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ref.slice('refs/heads/'.length))
        .sort()
        .map((branch) => branchJson(branch, repo.refs.get(`refs/heads/${branch}`) as string));
      return ok(200, branches);
    }
    if (tail.length === 2 && req.method === 'GET') {
      const branch = decodeURIComponent(tail[1] as string);
      const tip = repo.refs.get(`refs/heads/${branch}`);
      if (tip === undefined) return notFound();
      return ok(200, branchJson(branch, tip));
    }
    return notFound();
  }

  // /commits
  if (tail[0] === 'commits' && tail.length === 1 && req.method === 'GET') {
    const ref = req.query.get('sha');
    const tip = resolveRefTip(repo, ref);
    if (tip === null) return ok(200, []);
    const commits = store.listCommits(repo, tip);
    const items = commits.map((sha) => commitJson(repo, sha)).filter((entry): entry is Record<string, unknown> => entry !== null);
    return pagedResponse(items, req, `/api/v3/repos/${owner}/${name}/commits`);
  }

  // /contents/*
  if (tail[0] === 'contents') {
    const path = tail.slice(1).map((segment) => decodeURIComponent(segment)).join('/');
    return handleContents(store, req, repo, path);
  }

  // /git/refs
  if (tail[0] === 'git' && tail[1] === 'refs') {
    if (req.method === 'POST' && tail.length === 2) {
      const body = bodyObject(req.body);
      const ref = asString(body.ref);
      const sha = asString(body.sha);
      if (!ref.startsWith('refs/heads/') || sha === '') return err(422, 'invalid ref or sha');
      if (!repo.objects.has(sha)) return err(422, 'sha does not exist');
      const branch = ref.slice('refs/heads/'.length);
      if (repo.refs.has(ref)) return err(422, 'ref already exists');
      if (!store.createBranch(repo, branch, sha)) return err(422, 'could not create ref');
      return ok(201, { ref, object: { sha, type: 'commit', url: `/api/v3/repos/${owner}/${name}/git/commits/${sha}` } });
    }
    if (req.method === 'GET' && tail.length === 4 && tail[2] === 'heads') {
      const branch = decodeURIComponent(tail[3] as string);
      const tip = repo.refs.get(`refs/heads/${branch}`);
      if (tip === undefined) return notFound();
      return ok(200, { ref: `refs/heads/${branch}`, object: { sha: tip, type: 'commit', url: `/api/v3/repos/${owner}/${name}/git/commits/${tip}` } });
    }
    return notFound();
  }

  // /labels
  if (tail[0] === 'labels') {
    if (req.method === 'GET' && tail.length === 1) {
      return ok(200, [...repo.labels.values()].map((label) => labelJson(label, repo)));
    }
    if (req.method === 'POST' && tail.length === 1) {
      const body = bodyObject(req.body);
      const labelName = asString(body.name);
      if (labelName === '') return err(422, 'name is required');
      const label = store.createLabel(repo, labelName, asString(body.color) || 'ededed');
      return ok(201, labelJson(label, repo));
    }
    return notFound();
  }

  // /issues
  if (tail[0] === 'issues') {
    return handleIssues(store, req, repo, tail.slice(1));
  }

  // /pulls
  if (tail[0] === 'pulls') {
    return handlePulls(store, req, repo, tail.slice(1));
  }

  return notFound();
}

function handleContents(store: Store, req: RestRequest, repo: Repo, path: string): ApiResponse {
  const ref = req.query.get('ref');
  const tip = resolveRefTip(repo, ref);
  if (req.method === 'GET') {
    if (tip === null) return notFound();
    const flat = store.filesAt(repo, tip);
    const entry = flat.get(path);
    if (entry !== undefined) {
      const blob = repo.objects.get(entry.oid);
      if (blob === undefined) return notFound();
      return ok(200, {
        type: 'file',
        encoding: 'base64',
        size: blob.data.length,
        name: path.split('/').pop() ?? path,
        path,
        content: blob.data.toString('base64'),
        sha: entry.oid,
        url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
        html_url: `https://github.com/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${path}`,
        git_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${entry.oid}`,
        download_url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}?raw=1`,
      });
    }
    // A directory: immediate children of the path prefix.
    const prefix = path === '' ? '' : `${path}/`;
    const children = new Map<string, { type: 'file' | 'dir'; name: string; path: string; sha: string; size?: number }>();
    for (const [filePath, fileEntry] of flat) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) {
        const blob = repo.objects.get(fileEntry.oid);
        children.set(rest, { type: 'file', name: rest, path: filePath, sha: fileEntry.oid, size: blob?.data.length ?? 0 });
      } else {
        const dirName = rest.slice(0, slash);
        if (!children.has(dirName)) {
          children.set(dirName, { type: 'dir', name: dirName, path: `${prefix}${dirName}`, sha: '' });
        }
      }
    }
    if (children.size === 0) return notFound();
    const items = [...children.values()].sort((a, b) => (a.name < b.name ? -1 : 1)).map((child) => ({
      ...child,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${child.path}`,
      html_url: `https://github.com/${repo.owner}/${repo.name}/tree/${repo.defaultBranch}/${child.path}`,
    }));
    return ok(200, items);
  }
  if (req.method === 'PUT') {
    const body = bodyObject(req.body);
    const message = asString(body.message) || 'update';
    const contentB64 = asString(body.content);
    if (contentB64 === '') return err(422, 'content is required');
    const content = Buffer.from(contentB64, 'base64');
    const result = store.commitFile(repo, {
      branch: typeof body.branch === 'string' ? body.branch : undefined,
      path,
      content,
      message,
      sha: typeof body.sha === 'string' ? body.sha : undefined,
    });
    if ('message' in result && result.status === 409) return err(409, result.message);
    if (result.status === 201 || result.status === 200) {
      return ok(result.status, {
        content: {
          name: path.split('/').pop() ?? path,
          path,
          sha: result.contentSha,
          size: content.length,
          encoding: 'base64',
          url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
        },
        commit: { sha: result.commitSha, message },
      });
    }
    return err(409, 'conflict');
  }
  if (req.method === 'DELETE') {
    const body = bodyObject(req.body);
    const result = store.deleteFile(repo, {
      branch: typeof body.branch === 'string' ? body.branch : undefined,
      path,
      message: asString(body.message) || 'delete',
      sha: typeof body.sha === 'string' ? body.sha : undefined,
    });
    if (result.status === 200) return ok(200, { commit: { sha: result.commitSha } });
    if (result.status === 404) return notFound();
    return err(409, result.message);
  }
  return notFound();
}

function handleIssues(store: Store, req: RestRequest, repo: Repo, tail: string[]): ApiResponse {
  if (tail.length === 0) {
    if (req.method === 'POST') {
      const body = bodyObject(req.body);
      const title = asString(body.title);
      if (title === '') return err(422, 'title is required');
      const labels = labelNamesOf(body.labels);
      const created = store.createIssue(repo, title, asString(body.body), labels);
      if ('error' in created) return err(422, created.error);
      return ok(201, issueJson(repo, created));
    }
    if (req.method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      const sort = req.query.get('sort') ?? 'created';
      const direction = req.query.get('direction') ?? 'desc';
      let issues = [...repo.issues];
      if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
      if (sort === 'created') {
        issues.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
      }
      return pagedResponse(issues.map((issue) => issueJson(repo, issue)), req, `/api/v3/repos/${repo.owner}/${repo.name}/issues`);
    }
    return notFound();
  }
  const number = Number(tail[0]);
  if (!Number.isInteger(number) || number < 1) return notFound();
  const issue = repo.issues.find((entry) => entry.number === number);
  if (issue === undefined) return notFound();
  if (tail.length === 1) {
    if (req.method === 'GET') return ok(200, issueJson(repo, issue));
    if (req.method === 'PATCH') {
      const body = bodyObject(req.body);
      if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      return ok(200, issueJson(repo, issue));
    }
    return notFound();
  }
  if (tail[0] !== undefined && tail[1] === 'comments') {
    if (req.method === 'POST') {
      const body = bodyObject(req.body);
      const commentBody = asString(body.body);
      if (commentBody === '') return err(422, 'body is required');
      const comment = store.addComment(repo, issue, commentBody);
      return ok(201, commentJson(repo, issue, comment));
    }
    if (req.method === 'GET') {
      return ok(200, issue.comments.map((comment) => commentJson(repo, issue, comment)));
    }
    return notFound();
  }
  return notFound();
}

function stripOwnerPrefix(ref: string): string {
  const colon = ref.indexOf(':');
  return colon >= 0 ? ref.slice(colon + 1) : ref;
}

function countLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function handlePulls(store: Store, req: RestRequest, repo: Repo, tail: string[]): ApiResponse {
  if (tail.length === 0) {
    if (req.method === 'POST') {
      const body = bodyObject(req.body);
      const head = stripOwnerPrefix(asString(body.head));
      const base = stripOwnerPrefix(asString(body.base));
      const title = asString(body.title);
      if (head === '' || base === '' || title === '') return err(422, 'head, base and title are required');
      const created = store.createPull(repo, head, base, title, asString(body.body));
      if ('error' in created) return err(422, created.error);
      return ok(201, pullJson(repo, created));
    }
    if (req.method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      let pulls = [...repo.pulls];
      if (state === 'open' || state === 'closed') pulls = pulls.filter((pull) => pull.state === state);
      pulls.sort((a, b) => b.createdSeq - a.createdSeq);
      return pagedResponse(pulls.map((pull) => pullJson(repo, pull)), req, `/api/v3/repos/${repo.owner}/${repo.name}/pulls`);
    }
    return notFound();
  }
  const number = Number(tail[0]);
  if (!Number.isInteger(number) || number < 1) return notFound();
  const pull = repo.pulls.find((entry) => entry.number === number);
  if (pull === undefined) return notFound();
  if (tail.length === 1) {
    if (req.method === 'GET') return ok(200, pullJson(repo, pull));
    return notFound();
  }
  if (tail[1] === 'files' && tail.length === 2 && req.method === 'GET') {
    const changes = store.pullFiles(repo, pull);
    const files = changes.map((change) => {
      let additions = 0;
      let deletions = 0;
      const oldText = change.oldOid === null ? '' : (repo.objects.get(change.oldOid)?.data.toString('utf8') ?? '');
      const newText = change.newOid === null ? '' : (repo.objects.get(change.newOid)?.data.toString('utf8') ?? '');
      if (change.status === 'added') additions = countLines(newText).length;
      else if (change.status === 'removed') deletions = countLines(oldText).length;
      else {
        const oldLines = countLines(oldText);
        const newLines = countLines(newText);
        const oldCount = new Map<string, number>();
        for (const line of oldLines) oldCount.set(line, (oldCount.get(line) ?? 0) + 1);
        let common = 0;
        for (const line of newLines) {
          const remaining = oldCount.get(line) ?? 0;
          if (remaining > 0) {
            oldCount.set(line, remaining - 1);
            common += 1;
          }
        }
        additions = newLines.length - common;
        deletions = oldLines.length - common;
      }
      return {
        sha: change.newOid ?? change.oldOid ?? '',
        filename: change.path,
        status: change.status,
        additions,
        deletions,
        changes: additions + deletions,
        patch: '',
      };
    });
    return ok(200, files);
  }
  if (tail[1] === 'merge' && tail.length === 2 && req.method === 'PUT') {
    if (pull.state !== 'open') return err(405, 'pull request is not open');
    if (store.mergeable(repo, pull) !== 'MERGEABLE') return err(405, 'merge conflict');
    const merged = store.mergePull(repo, pull);
    if ('error' in merged) return err(405, merged.error);
    return ok(200, { sha: merged.commitSha, merged: true, message: 'Pull request successfully merged' });
  }
  return notFound();
}
