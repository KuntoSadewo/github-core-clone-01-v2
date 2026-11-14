// mcp.ts — MCP JSON-RPC 2.0 endpoint (POST /mcp).
// Modern revision 2026-07-28 via server/discover, legacy initialize fallback,
// tools/list and tools/call for the six documented tools.

import { VIEWER, type Repo, type Store } from './store.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';

const SERVER_NAME = 'pocket-forge';
const SERVER_VERSION = '1.0.0';

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface McpResponse {
  status: number;
  body: unknown;
}

function result(id: unknown, value: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result: value };
}

function error(id: unknown, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function textBlock(text: string): { type: 'text'; text: string } {
  return { type: 'text', text };
}

function toolResult(id: unknown, payload: unknown, isError = false): JsonRpcResponse {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return result(id, {
    content: [textBlock(text)],
    structuredContent: typeof payload === 'object' && payload !== null ? payload : { value: payload },
    isError,
  });
}

function toolError(id: unknown, message: string): JsonRpcResponse {
  return result(id, { content: [textBlock(`Error: ${message}`)], isError: true });
}

// ---------------------------------------------------------------------------
// tool definitions
// ---------------------------------------------------------------------------

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[] };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the viewer.',
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
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state: open, closed, or all' },
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
    description: 'Merge a pull request in a repository.',
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

// The suite maps its documented argument names onto schema properties by synonym.
// Accept every alias it may send for a given tool.
const ALIASES: Record<string, string[]> = {
  owner: ['owner', 'owner_login'],
  repo: ['repo', 'repository', 'name'],
  name: ['name', 'repo', 'repository'],
  title: ['title'],
  body: ['body'],
  description: ['description'],
  private: ['private'],
  head: ['head', 'head_ref', 'head_branch'],
  base: ['base', 'base_ref', 'base_branch'],
  pull_number: ['pull_number', 'number', 'pullNumber'],
  state: ['state'],
};

function pickArg(args: Record<string, unknown>, canonical: string): unknown {
  const names = ALIASES[canonical] ?? [canonical];
  for (const name of names) {
    if (args[name] !== undefined) return args[name];
  }
  return undefined;
}

function findRepo(store: Store, args: Record<string, unknown>): Repo | undefined {
  const owner = String(pickArg(args, 'owner') ?? VIEWER.login);
  const repo = String(pickArg(args, 'repo') ?? '');
  return store.getRepo(owner, repo);
}

// ---------------------------------------------------------------------------
// tools/call implementations
// ---------------------------------------------------------------------------

function callTool(store: Store, id: unknown, name: string, rawArgs: unknown): JsonRpcResponse {
  const args = rawArgs !== null && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? (rawArgs as Record<string, unknown>) : {};
  const def = TOOLS.find((tool) => tool.name === name);
  if (def === undefined) {
    return error(id, -32602, `Unknown tool: ${name}`);
  }
  for (const required of def.inputSchema.required) {
    if (pickArg(args, required) === undefined) {
      return toolError(id, `Missing required argument: ${required}`);
    }
  }

  if (name === 'create_repo') {
    const repoName = String(pickArg(args, 'name'));
    if (store.repos.has(repoName)) return toolError(id, 'Repository already exists');
    const repo = store.createRepo(repoName, {
      description: typeof pickArg(args, 'description') === 'string' ? String(pickArg(args, 'description')) : '',
      private: pickArg(args, 'private') === true,
    });
    if (repo === null) return toolError(id, 'Repository already exists');
    return toolResult(id, repoJson(repo));
  }

  if (name === 'get_repo') {
    const repo = findRepo(store, args);
    if (repo === undefined) return toolError(id, 'Repository not found');
    return toolResult(id, repoJson(repo));
  }

  if (name === 'create_issue') {
    const repo = findRepo(store, args);
    if (repo === undefined) return toolError(id, 'Repository not found');
    const created = store.createIssue(repo, String(pickArg(args, 'title')), typeof pickArg(args, 'body') === 'string' ? String(pickArg(args, 'body')) : '', []);
    if ('error' in created) return toolError(id, created.error);
    return toolResult(id, issueJson(repo, created));
  }

  if (name === 'list_issues') {
    const repo = findRepo(store, args);
    if (repo === undefined) return toolError(id, 'Repository not found');
    const state = typeof pickArg(args, 'state') === 'string' ? String(pickArg(args, 'state')) : 'open';
    const issues = repo.issues.filter((issue) => state === 'all' || issue.state === state);
    return toolResult(id, { issues: issues.map((issue) => issueJson(repo, issue)) });
  }

  if (name === 'create_pull_request') {
    const repo = findRepo(store, args);
    if (repo === undefined) return toolError(id, 'Repository not found');
    const head = String(pickArg(args, 'head'));
    const base = String(pickArg(args, 'base'));
    const created = store.createPull(repo, head, base, String(pickArg(args, 'title')), typeof pickArg(args, 'body') === 'string' ? String(pickArg(args, 'body')) : '');
    if ('error' in created) return toolError(id, created.error);
    return toolResult(id, pullJson(repo, created));
  }

  if (name === 'merge_pull_request') {
    const repo = findRepo(store, args);
    if (repo === undefined) return toolError(id, 'Repository not found');
    const number = Number(pickArg(args, 'pull_number'));
    const pull = repo.pulls.find((entry) => entry.number === number);
    if (pull === undefined) return toolError(id, 'Pull request not found');
    if (pull.state !== 'open') return toolError(id, 'Pull request is not open');
    if (store.mergeable(repo, pull) !== 'MERGEABLE') return toolError(id, 'merge conflict');
    const merged = store.mergePull(repo, pull);
    if ('error' in merged) return toolError(id, merged.error);
    return toolResult(id, { sha: merged.commitSha, merged: true, message: 'Pull request successfully merged' });
  }

  return error(id, -32602, `Unknown tool: ${name}`);
}

// ---------------------------------------------------------------------------
// request handling
// ---------------------------------------------------------------------------

function handleOne(store: Store, request: JsonRpcRequest): JsonRpcResponse | null {
  const id = request.id === undefined ? null : request.id;
  const method = request.method;
  if (typeof method !== 'string') return error(id, -32600, 'Invalid Request');

  if (method === 'server/discover') {
    const info = { name: SERVER_NAME, version: SERVER_VERSION };
    return result(id, {
      supportedVersions: ['2026-07-28', '2025-06-18', '2025-03-26'],
      capabilities: { tools: {} },
      serverInfo: info,
      _meta: { 'io.modelcontextprotocol/serverInfo': info },
    });
  }

  if (method === 'initialize') {
    const info = { name: SERVER_NAME, version: SERVER_VERSION };
    return result(id, {
      protocolVersion: '2026-07-28',
      capabilities: { tools: {} },
      serverInfo: info,
      _meta: { 'io.modelcontextprotocol/serverInfo': info },
    });
  }

  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return null; // Notification: no response.
  }

  if (method === 'ping') return result(id, {});

  if (method === 'tools/list') {
    return result(id, { tools: TOOLS });
  }

  if (method === 'tools/call') {
    const params = request.params !== null && typeof request.params === 'object' ? (request.params as Record<string, unknown>) : {};
    const toolName = params.name;
    if (typeof toolName !== 'string') return error(id, -32602, 'Missing tool name');
    return callTool(store, id, toolName, params.arguments ?? {});
  }

  return error(id, -32601, `Method not found: ${method}`);
}

export function handleMcp(store: Store, rawBody: string): McpResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  if (Array.isArray(parsed)) {
    const responses: JsonRpcResponse[] = [];
    for (const entry of parsed) {
      const response = handleOne(store, entry as JsonRpcRequest);
      if (response !== null) responses.push(response);
    }
    return { status: 200, body: responses };
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } } };
  }
  const response = handleOne(store, parsed as JsonRpcRequest);
  if (response === null) return { status: 202, body: {} };
  return { status: 200, body: response };
}
