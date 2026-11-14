// mcp.ts — endpoint MCP (Model Context Protocol) JSON-RPC 2.0 di POST /mcp.
//
// Mendukung era modern (server/discover, revision 2026-07-28) dan era lama
// (initialize + notifications/initialized, 2025-11-25) dengan 6 tools yang
// beroperasi di atas store yang sama dengan REST/GraphQL.

import type { RepoRecord, IssueRecord, PullRecord } from './store.ts';
import {
  ForgeStore,
  ForgeStoreIssues,
  ForgeStoreMerge,
} from './store.ts';

const SERVER_NAME = 'pocket-forge';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_2026 = '2026-07-28';
const PROTOCOL_2025 = '2025-11-25';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'open, closed, or all', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
        body: { type: 'string', description: 'Pull request body' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function serverInfo(): Record<string, unknown> {
  return { name: SERVER_NAME, version: SERVER_VERSION };
}

/** Serializer JSON untuk objek repo/issue/PR (dipakai tools + REST parity). */
export function repoJson(repo: RepoRecord): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: true,
  };
}

export function issueJson(repo: RepoRecord, issue: IssueRecord): Record<string, unknown> {
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
  };
}

export function pullJson(repo: RepoRecord, pull: PullRecord): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha },
    base: { ref: pull.baseRef, sha: pull.baseSha },
  };
}

interface ToolOutcome {
  isError: boolean;
  text: string;
  structured: unknown;
}

function toolResult(structured: unknown, text?: string): ToolOutcome {
  return {
    isError: false,
    text: text ?? JSON.stringify(structured),
    structured,
  };
}

function toolError(message: string): ToolOutcome {
  return { isError: true, text: message, structured: { error: message } };
}

export class McpDispatcher {
  private issues: ForgeStoreIssues;
  private merge: ForgeStoreMerge;

  private store: ForgeStore;
  constructor(store: ForgeStore) {
    this.store = store;
    this.issues = new ForgeStoreIssues(store);
    this.merge = new ForgeStoreMerge(store);
  }

  /** Jalankan satu request JSON-RPC; null = notifikasi tanpa respons. */
  dispatch(request: unknown): Record<string, unknown> | null {
    if (request === null || typeof request !== 'object' || Array.isArray(request)) {
      return {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'Invalid Request' },
      };
    }
    const req = request as Record<string, unknown>;
    const id = req.id === undefined ? null : req.id;
    const method = req.method;

    // Notifikasi (tanpa id): tidak ada respons JSON-RPC.
    if (id === null && typeof method === 'string' && method.startsWith('notifications/')) {
      return null;
    }
    if (typeof method !== 'string') {
      return { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request' } };
    }

    if (method === 'server/discover') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          supportedVersions: [PROTOCOL_2026],
          capabilities: { tools: {} },
          serverInfo: serverInfo(),
        },
      };
    }
    if (method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: PROTOCOL_2025,
          capabilities: { tools: {} },
          serverInfo: serverInfo(),
        },
      };
    }
    if (method === 'ping') {
      return { jsonrpc: '2.0', id, result: {} };
    }
    if (method === 'tools/list') {
      return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
    }
    if (method === 'tools/call') {
      const params = (req.params ?? {}) as Record<string, unknown>;
      const name = params.name;
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      if (typeof name !== 'string') {
        return { jsonrpc: '2.0', id, error: { code: -32602, message: 'Invalid params: name wajib string' } };
      }
      const tool = TOOLS.find((t) => t.name === name);
      if (tool === undefined) {
        return { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${name}` } };
      }
      const required = (tool.inputSchema.required as string[] | undefined) ?? [];
      for (const key of required) {
        if (args[key] === undefined || args[key] === null || args[key] === '') {
          return {
            jsonrpc: '2.0',
            id,
            error: { code: -32602, message: `Missing required argument: ${key}` },
          };
        }
      }
      const outcome = this.callTool(name, args);
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: outcome.text }],
          structuredContent: outcome.structured,
          isError: outcome.isError,
        },
      };
    }
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
  }

  private callTool(name: string, args: Record<string, unknown>): ToolOutcome {
    switch (name) {
      case 'create_repo': {
        const repoName = String(args.name ?? '');
        const { repo, created } = this.store.createRepo(repoName, {
          description: typeof args.description === 'string' ? args.description : undefined,
          isPrivate: args.private === true,
        });
        if (!created) return toolError('Repository already exists');
        return toolResult(repoJson(repo));
      }
      case 'get_repo': {
        const repo = this.store.getRepo(String(args.owner ?? ''), String(args.repo ?? ''));
        if (repo === undefined) return toolError('Repository not found');
        return toolResult(repoJson(repo));
      }
      case 'create_issue': {
        const repo = this.store.getRepo(String(args.owner ?? ''), String(args.repo ?? ''));
        if (repo === undefined) return toolError('Repository not found');
        const result = this.issues.createIssue(
          repo,
          String(args.title ?? ''),
          typeof args.body === 'string' ? args.body : '',
          [],
        );
        if ('error' in result) return toolError(result.error);
        return toolResult(issueJson(repo, result.issue));
      }
      case 'list_issues': {
        const repo = this.store.getRepo(String(args.owner ?? ''), String(args.repo ?? ''));
        if (repo === undefined) return toolError('Repository not found');
        const state = typeof args.state === 'string' ? args.state : 'open';
        let list = [...repo.issues];
        if (state !== 'all') list = list.filter((i) => i.state === state);
        list.sort((a, b) => a.seq - b.seq);
        const json = list.map((i) => issueJson(repo, i));
        return toolResult({ issues: json }, JSON.stringify(json));
      }
      case 'create_pull_request': {
        const repo = this.store.getRepo(String(args.owner ?? ''), String(args.repo ?? ''));
        if (repo === undefined) return toolError('Repository not found');
        const result = this.issues.createPull(
          repo,
          String(args.title ?? ''),
          typeof args.body === 'string' ? args.body : '',
          String(args.head ?? ''),
          String(args.base ?? ''),
        );
        if ('error' in result) return toolError(result.error);
        return toolResult(pullJson(repo, result.pull));
      }
      case 'merge_pull_request': {
        const repo = this.store.getRepo(String(args.owner ?? ''), String(args.repo ?? ''));
        if (repo === undefined) return toolError('Repository not found');
        const number = Number(args.pull_number ?? 0);
        const pull = repo.pulls.find((p) => p.number === number);
        if (pull === undefined) return toolError('Pull request not found');
        if (pull.merged) return toolError('Pull request is already merged');
        const outcome = this.merge.merge(repo, pull);
        if (outcome.conflict) return toolError('Merge conflict');
        if (!outcome.ok || outcome.sha === null) return toolError('Merge failed');
        return toolResult({ merged: true, sha: outcome.sha, number: pull.number });
      }
      default:
        return toolError(`Unknown tool: ${name}`);
    }
  }
}

/** Titik masuk HTTP: terima body mentah, kembalikan status + body JSON. */
export function handleMcp(store: ForgeStore, rawBody: Buffer): { status: number; body: string } {
  const dispatcher = new McpDispatcher(store);
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return {
      status: 400,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      }),
    };
  }
  if (Array.isArray(parsed)) {
    const out: (Record<string, unknown> | null)[] = parsed.map((item) => dispatcher.dispatch(item));
    const filtered = out.filter((x) => x !== null);
    return { status: 200, body: JSON.stringify(filtered) };
  }
  const result = dispatcher.dispatch(parsed);
  if (result === null) {
    return { status: 200, body: '' };
  }
  return { status: 200, body: JSON.stringify(result) };
}
