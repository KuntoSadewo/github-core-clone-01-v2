// rest.ts — handler GitHub REST API v3 (di bawah /api/v3).
//
// Semua handler adalah fungsi murni atas ForgeStore: menerima method,
// segmen path (sudah di-decode), query, dan body JSON; mengembalikan
// status + body + header tambahan. Serialisasi JSON dilakukan app.ts.

import type { RepoRecord, IssueRecord, PullRecord, CommentRecord } from './store.ts';
import {
  ForgeStore,
  ForgeStoreContents,
  ForgeStoreIssues,
  ForgeStoreMerge,
} from './store.ts';
import { decodeCommit, looksLikeOid } from './gitutil.ts';

export interface RestOutcome {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export class RestHandlers {
  private contents: ForgeStoreContents;
  private issues: ForgeStoreIssues;
  private merge: ForgeStoreMerge;

  private store: ForgeStore;
  constructor(store: ForgeStore) {
    this.store = store;
    this.contents = new ForgeStoreContents(store);
    this.issues = new ForgeStoreIssues(store);
    this.merge = new ForgeStoreMerge(store);
  }

  // -- helpers ---------------------------------------------------------------

  private notFound(message = 'Not Found'): RestOutcome {
    return { status: 404, body: { message } };
  }

  private unprocessable(message: string): RestOutcome {
    return { status: 422, body: { message } };
  }

  private conflict(message: string): RestOutcome {
    return { status: 409, body: { message } };
  }

  private bad(message: string): RestOutcome {
    return { status: 400, body: { message } };
  }

  private ok(body: unknown, status = 200, headers?: Record<string, string>): RestOutcome {
    return { status, body, headers };
  }

  /** Ambil repo dari segmen [repos, owner, name]; null bila tidak ada. */
  private repoAt(segments: string[]): RepoRecord | null {
    const owner = segments[1];
    const name = segments[2];
    if (owner === undefined || name === undefined) return null;
    return this.store.getRepo(owner, name) ?? null;
  }

  /** Pagination standar GitHub + header Link absolut. */
  private page<T>(
    items: T[],
    query: URLSearchParams,
    baseUrl: string,
  ): { items: T[]; headers: Record<string, string> } {
    const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
    const pageNum = Math.max(1, Number(query.get('page') ?? '1') || 1);
    const total = items.length;
    const totalPages = Math.max(1, Math.ceil(total / perPage));
    const start = (pageNum - 1) * perPage;
    const slice = items.slice(start, start + perPage);
    const links: string[] = [];
    const urlFor = (p: number) => {
      const q = new URLSearchParams(query);
      q.set('page', String(p));
      q.set('per_page', String(perPage));
      return `<${baseUrl}?${q.toString()}>`;
    };
    if (pageNum < totalPages) {
      links.push(`${urlFor(pageNum + 1)}; rel="next"`);
      links.push(`${urlFor(totalPages)}; rel="last"`);
    }
    if (pageNum > 1) {
      links.push(`${urlFor(1)}; rel="first"`);
      links.push(`${urlFor(pageNum - 1)}; rel="prev"`);
    }
    const headers: Record<string, string> = {};
    if (links.length > 0) headers.link = links.join(', ');
    return { items: slice, headers };
  }

  // -- serializer --------------------------------------------------------------

  private repoJson(repo: RepoRecord): Record<string, unknown> {
    const who = repo.owner;
    return {
      id: repo.id,
      name: repo.name,
      full_name: `${repo.owner}/${repo.name}`,
      owner: { login: who, id: repo.id, type: 'User' },
      private: repo.isPrivate,
      description: repo.description,
      default_branch: repo.defaultBranch,
      has_issues: true,
      has_projects: true,
      has_wiki: true,
      html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
      url: `/repos/${repo.owner}/${repo.name}`,
      created_at: new Date(1735689600 * 1000).toISOString(),
      updated_at: new Date(1735689600 * 1000).toISOString(),
    };
  }

  private issueJson(repo: RepoRecord, issue: IssueRecord): Record<string, unknown> {
    return {
      id: issue.id,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      labels: issue.labels.map((name) => {
        const label = repo.labels.get(name);
        return { name, color: label?.color ?? 'ededed' };
      }),
      user: { login: repo.owner, type: 'User' },
      created_at: new Date(1735689600 * 1000).toISOString(),
      updated_at: new Date(1735689600 * 1000).toISOString(),
      comments: issue.comments.length,
    };
  }

  private pullJson(repo: RepoRecord, pull: PullRecord): Record<string, unknown> {
    return {
      id: pull.id,
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: pull.state,
      merged: pull.merged,
      merged_at: pull.mergedAt,
      merge_commit_sha: pull.mergeCommitSha,
      head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
      base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
      user: { login: repo.owner, type: 'User' },
      created_at: new Date(1735689600 * 1000).toISOString(),
      updated_at: new Date(1735689600 * 1000).toISOString(),
    };
  }

  private commentJson(comment: CommentRecord): Record<string, unknown> {
    return {
      id: comment.id,
      body: comment.body,
      user: { login: this.store.viewerLogin(), type: 'User' },
      created_at: new Date(1735689600 * 1000).toISOString(),
      updated_at: new Date(1735689600 * 1000).toISOString(),
    };
  }

  private identityJson(line: string): { name: string; email: string; date: string } {
    const match = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(line);
    if (match === null) return { name: line, email: '', date: new Date(0).toISOString() };
    return {
      name: match[1],
      email: match[2],
      date: new Date(Number(match[3]) * 1000).toISOString(),
    };
  }

  private commitJson(repo: RepoRecord, oid: string): Record<string, unknown> | null {
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.kind !== 'commit') return null;
    const parsed = decodeCommit(obj.bytes);
    return {
      sha: oid,
      commit: {
        message: parsed.message,
        author: this.identityJson(parsed.author),
        committer: this.identityJson(parsed.committer),
        tree: { sha: parsed.tree },
      },
      author: { login: repo.owner },
      committer: { login: repo.owner },
      parents: parsed.parents.map((p) => ({ sha: p })),
    };
  }

  // -- router ------------------------------------------------------------------

  route(
    method: string,
    segments: string[],
    query: URLSearchParams,
    body: unknown,
    baseUrl: string,
  ): RestOutcome {
    const b = (body ?? {}) as Record<string, unknown>;
    const first = segments[0] ?? '';

    // Root & meta.
    if (first === '' && method === 'GET') {
      return this.ok(
        {
          current_user_url: '/user',
          repository_url: '/repos/{owner}/{repo}',
          user_url: '/users/{user}',
        },
        200,
        { 'x-oauth-scopes': 'repo, user' },
      );
    }
    if (first === 'meta' && method === 'GET') {
      return this.ok({ installed_version: '1.0.0', verifiable_password_authentication: false });
    }
    if (first === 'user' && segments.length === 1 && method === 'GET') {
      return this.ok({
        login: this.store.viewerLogin(),
        id: 1000,
        type: 'User',
        site_admin: false,
      });
    }

    // /user/repos
    if (first === 'user' && segments[1] === 'repos') {
      if (method === 'GET') {
        const repos = this.store.listReposByOwner(this.store.viewerLogin());
        const { items, headers } = this.page(repos, query, baseUrl);
        return this.ok(items.map((r) => this.repoJson(r)), 200, headers);
      }
      if (method === 'POST') {
        const name = b.name;
        if (typeof name !== 'string' || name.trim() === '') {
          return this.unprocessable('name wajib diisi');
        }
        const { repo, created } = this.store.createRepo(name.trim(), {
          description: typeof b.description === 'string' ? b.description : undefined,
          isPrivate: b.private === true,
        });
        if (!created) return this.unprocessable('Repository already exists');
        return this.ok(this.repoJson(repo), 201);
      }
    }

    // /repos/{owner}/{name}[/...]
    if (first === 'repos') {
      const repo = this.repoAt(segments);
      if (repo === null) return this.notFound('Repository not found');
      const rest = segments.slice(3);

      // /repos/{o}/{r}
      if (rest.length === 0) {
        if (method === 'GET') return this.ok(this.repoJson(repo));
        if (method === 'PATCH') {
          if (typeof b.description === 'string') repo.description = b.description;
          return this.ok(this.repoJson(repo));
        }
        if (method === 'DELETE') {
          this.store.deleteRepo(repo.owner, repo.name);
          return { status: 204, body: null };
        }
      }

      // /branches
      if (rest[0] === 'branches') {
        if (rest.length === 1 && method === 'GET') {
          const branches = this.store.listBranches(repo);
          return this.ok(branches.map((br) => ({ name: br.name, commit: { sha: br.sha } })));
        }
        if (rest.length === 2 && method === 'GET') {
          const tip = this.store.branchTip(repo, rest[1]);
          if (tip === null) return this.notFound('Branch not found');
          return this.ok({ name: rest[1], commit: { sha: tip } });
        }
      }

      // /commits
      if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
        const ref = query.get('sha') ?? repo.defaultBranch;
        const tip = this.store.resolveRef(repo, ref);
        if (tip === null) return this.notFound('Commit not found');
        const oids = this.store.listCommits(repo, tip);
        const { items, headers } = this.page(oids, query, baseUrl);
        const out: Record<string, unknown>[] = [];
        for (const oid of items) {
          const json = this.commitJson(repo, oid);
          if (json !== null) out.push(json);
        }
        return this.ok(out, 200, headers);
      }

      // /git/refs
      if (rest[0] === 'git' && rest[1] === 'refs') {
        if (method === 'POST' && rest.length === 2) {
          const ref = b.ref;
          const sha = b.sha;
          if (typeof ref !== 'string' || !ref.startsWith('refs/')) {
            return this.unprocessable('ref harus diawali refs/');
          }
          if (typeof sha !== 'string' || !looksLikeOid(sha)) {
            return this.unprocessable('sha tidak valid');
          }
          if (repo.refs.has(ref)) return this.unprocessable('Reference already exists');
          if (repo.objects.get(sha) === undefined) {
            return this.unprocessable('Object does not exist');
          }
          repo.refs.set(ref, sha);
          return this.ok({ ref, object: { sha } }, 201);
        }
        if (method === 'GET') {
          if (rest.length === 2) {
            const out: { ref: string; object: { sha: string } }[] = [];
            for (const [ref, sha] of [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
              out.push({ ref, object: { sha } });
            }
            return this.ok(out);
          }
          const refName = 'refs/' + rest.slice(2).join('/');
          const sha = repo.refs.get(refName);
          if (sha === undefined) return this.notFound('Reference not found');
          return this.ok({ ref: refName, object: { sha } });
        }
      }

      // /contents/...
      if (rest[0] === 'contents') {
        const filePath = rest.slice(1).join('/');
        const ref = query.get('ref') ?? repo.defaultBranch;
        if (method === 'GET') {
          const file = this.contents.readPath(repo, ref, filePath);
          if (file !== null) {
            const name = filePath.split('/').pop() ?? filePath;
            return this.ok({
              type: 'file',
              encoding: 'base64',
              size: file.bytes.length,
              name,
              path: filePath,
              sha: file.oid,
              content: file.bytes.toString('base64'),
            });
          }
          const dir = this.contents.listDir(repo, ref, filePath);
          if (dir !== null) {
            return this.ok(
              dir.map((e) => {
                const isDir = e.mode === '40000';
                const blob = isDir ? null : repo.objects.get(e.oid);
                return {
                  type: isDir ? 'dir' : 'file',
                  name: e.name,
                  path: e.path,
                  sha: e.oid,
                  size: blob?.bytes.length ?? 0,
                };
              }),
            );
          }
          return this.notFound('Content not found');
        }
        if (method === 'PUT') {
          const message = b.message;
          const content = b.content;
          if (typeof message !== 'string' || message === '') {
            return this.unprocessable('message wajib diisi');
          }
          if (typeof content !== 'string') {
            return this.unprocessable('content wajib base64');
          }
          let bytes: Buffer;
          try {
            bytes = Buffer.from(content, 'base64');
          } catch {
            return this.unprocessable('content bukan base64 valid');
          }
          const branch = typeof b.branch === 'string' && b.branch !== '' ? b.branch : repo.defaultBranch;
          const existing = this.contents.readPath(repo, branch, filePath);
          if (existing !== null) {
            if (typeof b.sha === 'string' && b.sha !== existing.oid) {
              return this.conflict('sha tidak cocok dengan isi saat ini');
            }
            const result = this.contents.putFile(repo, branch, filePath, bytes, message);
            return this.ok(
              {
                content: {
                  name: filePath.split('/').pop() ?? filePath,
                  path: filePath,
                  sha: result.blobOid,
                  size: bytes.length,
                  type: 'file',
                  encoding: 'base64',
                },
                commit: { sha: result.commitOid, message },
              },
              200,
            );
          }
          const result = this.contents.putFile(repo, branch, filePath, bytes, message);
          return this.ok(
            {
              content: {
                name: filePath.split('/').pop() ?? filePath,
                path: filePath,
                sha: result.blobOid,
                size: bytes.length,
                type: 'file',
                encoding: 'base64',
              },
              commit: { sha: result.commitOid, message },
            },
            201,
          );
        }
        if (method === 'DELETE') {
          const message = typeof b.message === 'string' ? b.message : 'Delete file';
          const branch = typeof b.branch === 'string' && b.branch !== '' ? b.branch : repo.defaultBranch;
          const existing = this.contents.readPath(repo, branch, filePath);
          if (existing === null) return this.notFound('Content not found');
          if (typeof b.sha === 'string' && b.sha !== existing.oid) {
            return this.conflict('sha tidak cocok dengan isi saat ini');
          }
          const result = this.contents.deleteFile(repo, branch, filePath, message);
          if (result === null) return this.notFound('Content not found');
          return this.ok({ commit: { sha: result.commitOid, message } });
        }
      }

      // /labels
      if (rest[0] === 'labels') {
        if (method === 'POST' && rest.length === 1) {
          const name = b.name;
          if (typeof name !== 'string' || name.trim() === '') {
            return this.unprocessable('name wajib diisi');
          }
          const color = typeof b.color === 'string' ? b.color : 'ededed';
          const existing = repo.labels.get(name);
          if (existing) return this.ok({ name: existing.name, color: existing.color }, 201);
          repo.labels.set(name, { name, color });
          return this.ok({ name, color }, 201);
        }
        if (method === 'GET' && rest.length === 1) {
          return this.ok([...repo.labels.values()].map((l) => ({ name: l.name, color: l.color })));
        }
      }

      // /issues...
      if (rest[0] === 'issues') {
        return this.routeIssues(repo, method, rest.slice(1), query, b, baseUrl);
      }

      // /pulls...
      if (rest[0] === 'pulls') {
        return this.routePulls(repo, method, rest.slice(1), query, b, baseUrl);
      }
    }

    return this.notFound('Not Found');
  }

  // -- issues ------------------------------------------------------------------

  private routeIssues(
    repo: RepoRecord,
    method: string,
    rest: string[],
    query: URLSearchParams,
    b: Record<string, unknown>,
    baseUrl: string,
  ): RestOutcome {
    // POST /issues — buat issue baru
    if (rest.length === 0 && method === 'POST') {
      const title = b.title;
      if (typeof title !== 'string' || title.trim() === '') {
        return this.unprocessable('title wajib diisi');
      }
      const labelNames: string[] = Array.isArray(b.labels)
        ? (b.labels as unknown[]).filter((x): x is string => typeof x === 'string')
        : [];
      const result = this.issues.createIssue(
        repo,
        title,
        typeof b.body === 'string' ? b.body : '',
        labelNames,
      );
      if ('error' in result) return this.unprocessable(result.error);
      return this.ok(this.issueJson(repo, result.issue), 201);
    }

    // GET /issues — daftar dengan filter state + sort
    if (rest.length === 0 && method === 'GET') {
      const state = query.get('state') ?? 'open';
      const sort = query.get('sort') ?? 'created';
      const direction = query.get('direction') ?? 'desc';
      let list = [...repo.issues];
      if (state !== 'all') list = list.filter((i) => i.state === state);
      if (sort === 'created') {
        list.sort((a, c) => (direction === 'asc' ? a.seq - c.seq : c.seq - a.seq));
      }
      const { items, headers } = this.page(list, query, baseUrl);
      return this.ok(items.map((i) => this.issueJson(repo, i)), 200, headers);
    }

    const number = Number(rest[0]);
    if (!Number.isInteger(number) || number < 1) return this.notFound('Issue not found');
    const issue = repo.issues.find((i) => i.number === number);
    if (issue === undefined) return this.notFound('Issue not found');

    // GET /issues/{n}
    if (rest.length === 1 && method === 'GET') {
      return this.ok(this.issueJson(repo, issue));
    }
    // PATCH /issues/{n}
    if (rest.length === 1 && method === 'PATCH') {
      if (typeof b.state === 'string') {
        if (b.state !== 'open' && b.state !== 'closed') {
          return this.unprocessable('state harus open atau closed');
        }
        issue.state = b.state;
      }
      if (typeof b.title === 'string') issue.title = b.title;
      if (typeof b.body === 'string') issue.body = b.body;
      return this.ok(this.issueJson(repo, issue));
    }
    // /issues/{n}/comments
    if (rest[1] === 'comments') {
      if (method === 'POST' && rest.length === 2) {
        if (typeof b.body !== 'string' || b.body === '') {
          return this.unprocessable('body wajib diisi');
        }
        const comment = this.issues.addComment(repo, issue, b.body);
        return this.ok(this.commentJson(comment), 201);
      }
      if (method === 'GET' && rest.length === 2) {
        const { items, headers } = this.page(issue.comments, query, baseUrl);
        return this.ok(items.map((c) => this.commentJson(c)), 200, headers);
      }
    }
    return this.notFound('Not Found');
  }

  // -- pulls -------------------------------------------------------------------

  private routePulls(
    repo: RepoRecord,
    method: string,
    rest: string[],
    query: URLSearchParams,
    b: Record<string, unknown>,
    baseUrl: string,
  ): RestOutcome {
    // POST /pulls — buat PR baru
    if (rest.length === 0 && method === 'POST') {
      const title = b.title;
      const head = b.head;
      const base = b.base;
      if (typeof title !== 'string' || title.trim() === '') {
        return this.unprocessable('title wajib diisi');
      }
      if (typeof head !== 'string' || head === '') {
        return this.unprocessable('head wajib diisi');
      }
      if (typeof base !== 'string' || base === '') {
        return this.unprocessable('base wajib diisi');
      }
      const result = this.issues.createPull(
        repo,
        title,
        typeof b.body === 'string' ? b.body : '',
        head,
        base,
      );
      if ('error' in result) return this.unprocessable(result.error);
      return this.ok(this.pullJson(repo, result.pull), 201);
    }

    // GET /pulls — daftar
    if (rest.length === 0 && method === 'GET') {
      const state = query.get('state') ?? 'open';
      let list = [...repo.pulls];
      if (state !== 'all') list = list.filter((p) => p.state === state);
      list.sort((a, c) => a.seq - c.seq);
      const { items, headers } = this.page(list, query, baseUrl);
      return this.ok(items.map((p) => this.pullJson(repo, p)), 200, headers);
    }

    const number = Number(rest[0]);
    if (!Number.isInteger(number) || number < 1) return this.notFound('Pull request not found');
    const pull = repo.pulls.find((p) => p.number === number);
    if (pull === undefined) return this.notFound('Pull request not found');

    // GET /pulls/{n}
    if (rest.length === 1 && method === 'GET') {
      return this.ok(this.pullJson(repo, pull));
    }
    // GET /pulls/{n}/files
    if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
      const files = this.merge.filesOf(repo, pull);
      return this.ok(
        files.map((f) => ({
          filename: f.path,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          changes: f.additions + f.deletions,
        })),
      );
    }
    // PUT /pulls/{n}/merge
    if (rest.length === 2 && rest[1] === 'merge' && method === 'PUT') {
      if (pull.merged) {
        return { status: 405, body: { message: 'Pull request is already merged' } };
      }
      if (pull.state !== 'open') {
        return { status: 405, body: { message: 'Pull request is closed' } };
      }
      const outcome = this.merge.merge(repo, pull);
      if (outcome.conflict) {
        return { status: 405, body: { message: 'Merge conflict' } };
      }
      if (!outcome.ok || outcome.sha === null) {
        return { status: 405, body: { message: 'Merge failed' } };
      }
      return this.ok({
        sha: outcome.sha,
        merged: true,
        message: 'Pull request successfully merged',
      });
    }
    return this.notFound('Not Found');
  }
}
