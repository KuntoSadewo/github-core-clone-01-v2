// graphql.ts — a small, strict-enough GraphQL executor over the Store.
// Supports queries, mutations, variables, aliases, inline/named fragments,
// enums, input objects, batch arrays, and __type introspection.

import { VIEWER, globalId, type Issue, type Pull, type Repo, type Store } from './store.ts';

// ---------------------------------------------------------------------------
// lexer
// ---------------------------------------------------------------------------

interface Token {
  kind: 'name' | 'string' | 'int' | 'float' | 'punct' | 'spread';
  value: string;
}

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < input.length) {
    const c = input[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():!@$=[]'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let value = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1] as string;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === '"' ? '"' : esc === '\\' ? '\\' : esc;
          j += 2;
        } else {
          value += input[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (isNameStart(c)) {
      let j = i + 1;
      while (j < input.length && isNameChar(input[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i + 1;
      let isFloat = false;
      while (j < input.length && /[0-9.]/.test(input[j] as string)) {
        if (input[j] === '.') isFloat = true;
        j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`Unexpected character ${c}`);
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

interface DirectiveNode {
  name: string;
  args: Record<string, ValueNode>;
}

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Record<string, ValueNode>;
  directives: DirectiveNode[];
  selection: SelectionNode[] | null;
}

interface InlineFragmentNode {
  kind: 'inlineFragment';
  typeCondition: string | null;
  selection: SelectionNode[];
}

interface FragmentSpreadNode {
  kind: 'spread';
  name: string;
}

type SelectionNode = FieldNode | InlineFragmentNode | FragmentSpreadNode;

interface VariableDef {
  name: string;
  default: ValueNode | null;
}

interface OperationNode {
  kind: 'operation';
  operation: 'query' | 'mutation';
  name: string | null;
  variables: VariableDef[];
  selection: SelectionNode[];
}

interface FragmentNode {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  selection: SelectionNode[];
}

interface Document {
  operations: OperationNode[];
  fragments: Map<string, FragmentNode>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`Expected ${value}, got ${token.value}`);
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name' || (value !== undefined && token.value !== value)) {
      throw new Error(`Expected name ${value ?? ''}, got ${token.value}`);
    }
    return token.value;
  }

  parseDocument(): Document {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.peek() !== undefined) {
      const token = this.peek() as Token;
      if (token.kind === 'name' && token.value === 'fragment') {
        const fragment = this.parseFragment();
        fragments.set(fragment.name, fragment);
      } else {
        operations.push(this.parseOperation());
      }
    }
    return { operations, fragments };
  }

  private parseFragment(): FragmentNode {
    this.expectName('fragment');
    const name = this.expectName();
    this.expectName('on');
    const typeCondition = this.expectName();
    const selection = this.parseSelectionSet();
    return { kind: 'fragment', name, typeCondition, selection };
  }

  private parseOperation(): OperationNode {
    let operation: 'query' | 'mutation' = 'query';
    const token = this.peek() as Token;
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      operation = this.next().value as 'query' | 'mutation';
    }
    let name: string | null = null;
    const nameToken = this.peek();
    if (nameToken !== undefined && nameToken.kind === 'name') {
      name = this.next().value;
    }
    const variables: VariableDef[] = [];
    if (this.peek()?.value === '(') {
      this.expectPunct('(');
      while (this.peek() !== undefined && this.peek()?.value !== ')') {
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        // Type: a name, possibly wrapped in [ ] and suffixed with !.
        this.skipType();
        let defaultValue: ValueNode | null = null;
        if (this.peek()?.value === '=') {
          this.expectPunct('=');
          defaultValue = this.parseValue();
        }
        variables.push({ name: varName, default: defaultValue });
      }
      this.expectPunct(')');
    }
    const selection = this.parseSelectionSet();
    return { kind: 'operation', operation, name, variables, selection };
  }

  private skipType(): void {
    const token = this.peek();
    if (token === undefined) return;
    if (token.value === '[') {
      this.expectPunct('[');
      this.skipType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek()?.value === '!') this.expectPunct('!');
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (this.peek() !== undefined && this.peek()?.value !== '}') {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek() as Token;
    if (token.kind === 'spread') {
      this.next();
      const next = this.peek() as Token;
      if (next.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        const selection = this.parseSelectionSet();
        return { kind: 'inlineFragment', typeCondition, selection };
      }
      const name = this.expectName();
      return { kind: 'spread', name };
    }
    let name = this.expectName();
    let alias: string | null = null;
    if (this.peek()?.value === ':') {
      this.expectPunct(':');
      alias = name;
      name = this.expectName();
    }
    const args: Record<string, ValueNode> = {};
    if (this.peek()?.value === '(') {
      this.expectPunct('(');
      while (this.peek() !== undefined && this.peek()?.value !== ')') {
        const argName = this.expectName();
        this.expectPunct(':');
        args[argName] = this.parseValue();
      }
      this.expectPunct(')');
    }
    const directives: DirectiveNode[] = [];
    while (this.peek()?.value === '@') {
      this.expectPunct('@');
      const directiveName = this.expectName();
      const directiveArgs: Record<string, ValueNode> = {};
      if (this.peek()?.value === '(') {
        this.expectPunct('(');
        while (this.peek() !== undefined && this.peek()?.value !== ')') {
          const argName = this.expectName();
          this.expectPunct(':');
          directiveArgs[argName] = this.parseValue();
        }
        this.expectPunct(')');
      }
      directives.push({ name: directiveName, args: directiveArgs });
    }
    let selection: SelectionNode[] | null = null;
    if (this.peek()?.value === '{') selection = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, directives, selection };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number(token.value) };
    if (token.kind === 'float') return { kind: 'float', value: Number(token.value) };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (this.peek() !== undefined && this.peek()?.value !== ']') values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Record<string, ValueNode> = {};
      while (this.peek() !== undefined && this.peek()?.value !== '}') {
        const fieldName = this.expectName();
        this.expectPunct(':');
        fields[fieldName] = this.parseValue();
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`Unexpected value token ${token.value}`);
  }
}

// ---------------------------------------------------------------------------
// value resolution
// ---------------------------------------------------------------------------

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((value) => resolveValue(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node.fields)) out[key] = resolveValue(value, variables);
      return out;
    }
  }
}

function resolveArgs(args: Record<string, ValueNode>, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) out[key] = resolveValue(value, variables);
  return out;
}

// ---------------------------------------------------------------------------
// object model: every value the executor hands out carries __typename
// ---------------------------------------------------------------------------

interface GqlObject {
  __typename: string;
  [key: string]: unknown;
}

function viewerObject(): GqlObject {
  return { __typename: 'User', login: VIEWER.login, id: VIEWER.id, databaseId: VIEWER.id, name: VIEWER.name };
}

function repoObject(repo: Repo): GqlObject {
  return { __typename: 'Repository', repo };
}

function issueObject(repo: Repo, issue: Issue): GqlObject {
  return { __typename: 'Issue', repo, issue };
}

function pullObject(repo: Repo, pull: Pull): GqlObject {
  return { __typename: 'PullRequest', repo, pull };
}

function refObject(name: string): GqlObject {
  return { __typename: 'Ref', name };
}

function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const decoded = Buffer.from(id, 'base64').toString('utf8');
    const parts = decoded.split(':');
    const kind = parts[0] as string;
    if (kind === undefined) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

function nodeFromId(store: Store, id: string): GqlObject | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null) return null;
  const { kind, parts } = decoded;
  if (kind === 'repo') {
    const repo = store.listRepos().find((entry) => entry.id === Number(parts[1]));
    return repo === undefined ? null : repoObject(repo);
  }
  if (kind === 'issue') {
    const repo = store.listRepos().find((entry) => entry.id === Number(parts[1]));
    const issue = repo?.issues.find((entry) => entry.number === Number(parts[2]));
    return repo === undefined || issue === undefined ? null : issueObject(repo, issue);
  }
  if (kind === 'pr') {
    const repo = store.listRepos().find((entry) => entry.id === Number(parts[1]));
    const pull = repo?.pulls.find((entry) => entry.number === Number(parts[2]));
    return repo === undefined || pull === undefined ? null : pullObject(repo, pull);
  }
  if (kind === 'user') return viewerObject();
  return null;
}

// ---------------------------------------------------------------------------
// introspection schema
// ---------------------------------------------------------------------------

const SCHEMA: Record<string, { kind: 'OBJECT' | 'ENUM'; fields?: string[]; enumValues?: string[] }> = {
  Query: { kind: 'OBJECT', fields: ['viewer', 'repository', 'node', '__type', '__schema'] },
  Mutation: { kind: 'OBJECT', fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'] },
  Repository: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  },
  Issue: { kind: 'OBJECT', fields: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'url', 'author', 'comments'] },
  PullRequest: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files', 'title', 'body', 'createdAt', 'closedAt', 'mergedAt', 'url'],
  },
  User: { kind: 'OBJECT', fields: ['id', 'login', 'name', 'databaseId'] },
  Ref: { kind: 'OBJECT', fields: ['name'] },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'REPOSITORY', 'USER'] },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
};

function typeObject(name: string): GqlObject {
  const entry = SCHEMA[name];
  if (entry === undefined) return { __typename: '__Type', name, kind: 'OBJECT', fields: [], enumValues: [] };
  return {
    __typename: '__Type',
    name,
    kind: entry.kind,
    description: null,
    fields: (entry.fields ?? []).map((field) => ({ __typename: '__Field', name: field, description: null })),
    enumValues: (entry.enumValues ?? []).map((value) => ({ __typename: '__EnumValue', name: value, description: null })),
  };
}

// ---------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------

interface ExecContext {
  store: Store;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentNode>;
  errors: { message: string }[];
}

function directivesSkip(directives: DirectiveNode[], variables: Record<string, unknown>): boolean {
  for (const directive of directives) {
    const args = resolveArgs(directive.args, variables);
    if (directive.name === 'skip' && args.if === true) return true;
    if (directive.name === 'include' && args.if === false) return true;
  }
  return false;
}

function executeSelection(parent: GqlObject, selections: SelectionNode[], ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined) {
        Object.assign(out, executeSelection(parent, fragment.selection, ctx));
      }
      continue;
    }
    if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition === null || selection.typeCondition === parent.__typename) {
        Object.assign(out, executeSelection(parent, selection.selection, ctx));
      }
      continue;
    }
    if (directivesSkip(selection.directives, ctx.variables)) continue;
    const key = selection.alias ?? selection.name;
    const args = resolveArgs(selection.args, ctx.variables);
    out[key] = resolveField(parent, selection.name, args, selection.selection, ctx);
  }
  return out;
}

function resolveField(parent: GqlObject, field: string, args: Record<string, unknown>, selection: SelectionNode[] | null, ctx: ExecContext): unknown {
  if (field === '__typename') return parent.__typename;

  // Root Query
  if (parent.__typename === 'Query') {
    if (field === 'viewer') {
      const obj = viewerObject();
      return selection === null ? obj : executeSelection(obj, selection, ctx);
    }
    if (field === 'repository') {
      const repo = ctx.store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
      if (repo === undefined) return null;
      const obj = repoObject(repo);
      return selection === null ? obj : executeSelection(obj, selection, ctx);
    }
    if (field === 'node') {
      const obj = nodeFromId(ctx.store, String(args.id ?? ''));
      if (obj === null) return null;
      return selection === null ? obj : executeSelection(obj, selection, ctx);
    }
    if (field === '__type') {
      const obj = typeObject(String(args.name ?? ''));
      return selection === null ? obj : executeSelection(obj, selection, ctx);
    }
    if (field === '__schema') {
      const obj: GqlObject = { __typename: '__Schema', types: Object.keys(SCHEMA).map((name) => typeObject(name)) };
      return selection === null ? obj : executeSelection(obj, selection, ctx);
    }
    ctx.errors.push({ message: `Cannot query field "${field}" on type "Query".` });
    return null;
  }

  // Root Mutation
  if (parent.__typename === 'Mutation') {
    return resolveMutation(field, args, selection, ctx);
  }

  // __Type introspection object
  if (parent.__typename === '__Type') {
    if (field === 'name' || field === 'kind' || field === 'description') return parent[field];
    if (field === 'fields') {
      const fields = parent.fields as GqlObject[];
      return selection === null
        ? fields
        : fields.map((entry) => executeSelection(entry, selection, ctx));
    }
    if (field === 'enumValues') {
      const values = parent.enumValues as GqlObject[];
      return selection === null
        ? values
        : values.map((entry) => executeSelection(entry, selection, ctx));
    }
    ctx.errors.push({ message: `Cannot query field "${field}" on type "__Type".` });
    return null;
  }
  if (parent.__typename === '__Field' || parent.__typename === '__EnumValue') {
    if (field === 'name' || field === 'description') return parent[field];
    if (field === 'args') return [];
    if (field === 'type') return { __typename: '__Type', name: 'String', kind: 'SCALAR' };
    ctx.errors.push({ message: `Cannot query field "${field}" on type "${parent.__typename}".` });
    return null;
  }
  if (parent.__typename === '__Schema') {
    if (field === 'types') {
      const types = parent.types as GqlObject[];
      return selection === null ? types : types.map((entry) => executeSelection(entry, selection, ctx));
    }
    ctx.errors.push({ message: `Cannot query field "${field}" on type "__Schema".` });
    return null;
  }

  // User
  if (parent.__typename === 'User') {
    if (field === 'login') return VIEWER.login;
    if (field === 'id') return globalId('user', VIEWER.id);
    if (field === 'databaseId') return VIEWER.id;
    if (field === 'name') return VIEWER.name;
    ctx.errors.push({ message: `Cannot query field "${field}" on type "User".` });
    return null;
  }

  // Ref
  if (parent.__typename === 'Ref') {
    if (field === 'name') return parent.name;
    ctx.errors.push({ message: `Cannot query field "${field}" on type "Ref".` });
    return null;
  }

  // Repository
  if (parent.__typename === 'Repository') {
    const repo = parent.repo as Repo;
    if (field === 'id') return globalId('repo', repo.id);
    if (field === 'databaseId') return repo.id;
    if (field === 'name') return repo.name;
    if (field === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
    if (field === 'owner') {
      const obj = viewerObject();
      return selection === null ? obj : executeSelection(obj, selection, ctx);
    }
    if (field === 'defaultBranchRef') {
      const obj = refObject(repo.defaultBranch);
      return selection === null ? obj : executeSelection(obj, selection, ctx);
    }
    if (field === 'viewerPermission') return 'ADMIN';
    if (field === 'hasIssuesEnabled') return true;
    if (field === 'issue') {
      const issue = repo.issues.find((entry) => entry.number === Number(args.number));
      if (issue === undefined) return null;
      const obj = issueObject(repo, issue);
      return selection === null ? obj : executeSelection(obj, selection, ctx);
    }
    if (field === 'issues') return issueConnection(repo, args, selection, ctx);
    if (field === 'pullRequest') {
      const pull = repo.pulls.find((entry) => entry.number === Number(args.number));
      if (pull === undefined) return null;
      const obj = pullObject(repo, pull);
      return selection === null ? obj : executeSelection(obj, selection, ctx);
    }
    if (field === 'pullRequests') return pullConnection(repo, args, selection, ctx);
    ctx.errors.push({ message: `Cannot query field "${field}" on type "Repository".` });
    return null;
  }

  // Issue
  if (parent.__typename === 'Issue') {
    const issue = parent.issue as Issue;
    const repo = parent.repo as Repo;
    if (field === 'id') return globalId('issue', repo.id, issue.number);
    if (field === 'number') return issue.number;
    if (field === 'title') return issue.title;
    if (field === 'state') return issue.state.toUpperCase();
    if (field === 'body') return issue.body;
    if (field === 'createdAt') return issue.createdAt;
    if (field === 'url') return `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`;
    if (field === 'author') {
      const obj = viewerObject();
      return selection === null ? obj : executeSelection(obj, selection, ctx);
    }
    if (field === 'comments') {
      const nodes = issue.comments.map((comment) => ({ __typename: 'IssueComment', id: globalId('comment', repo.id, issue.number, comment.id), body: comment.body }));
      return connectionResult(nodes, args, selection, ctx);
    }
    ctx.errors.push({ message: `Cannot query field "${field}" on type "Issue".` });
    return null;
  }

  // PullRequest
  if (parent.__typename === 'PullRequest') {
    const pull = parent.pull as Pull;
    const repo = parent.repo as Repo;
    if (field === 'id') return globalId('pr', repo.id, pull.number);
    if (field === 'number') return pull.number;
    if (field === 'title') return pull.title;
    if (field === 'body') return pull.body;
    if (field === 'state') return pull.state.toUpperCase();
    if (field === 'merged') return pull.merged;
    if (field === 'mergeable') return ctx.store.mergeable(repo, pull);
    if (field === 'headRefName') return pull.headRef;
    if (field === 'baseRefName') return pull.baseRef;
    if (field === 'createdAt') return pull.createdAt;
    if (field === 'closedAt') return pull.state === 'closed' ? pull.updatedAt : null;
    if (field === 'mergedAt') return pull.mergedAt;
    if (field === 'url') return `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`;
    if (field === 'files') {
      const changes = ctx.store.pullFiles(repo, pull);
      const nodes = changes.map((change) => ({
        __typename: 'PullRequestChangedFile',
        path: change.path,
        additions: change.newOid === null ? 0 : 1,
        deletions: change.oldOid === null ? 0 : 1,
        changeType: change.status.toUpperCase(),
      }));
      return connectionResult(nodes, args, selection, ctx);
    }
    ctx.errors.push({ message: `Cannot query field "${field}" on type "PullRequest".` });
    return null;
  }

  // IssueComment
  if (parent.__typename === 'IssueComment') {
    if (field === 'id') return parent.id;
    if (field === 'body') return parent.body;
    ctx.errors.push({ message: `Cannot query field "${field}" on type "IssueComment".` });
    return null;
  }

  // PullRequestChangedFile
  if (parent.__typename === 'PullRequestChangedFile') {
    if (field === 'path' || field === 'additions' || field === 'deletions' || field === 'changeType') return parent[field];
    ctx.errors.push({ message: `Cannot query field "${field}" on type "PullRequestChangedFile".` });
    return null;
  }

  // Generic payloads (mutation results, PageInfo, edges): resolve any own property,
  // recursing into sub-selections on objects that carry a __typename.
  const GENERIC_TYPES = new Set([
    'CreateIssuePayload',
    'CloseIssuePayload',
    'CreatePullRequestPayload',
    'MergePullRequestPayload',
    'AddCommentPayload',
    'PageInfo',
    'Edge',
    'IssueCommentEdge',
  ]);
  if (GENERIC_TYPES.has(parent.__typename) && Object.prototype.hasOwnProperty.call(parent, field)) {
    const value = parent[field];
    if (selection === null) return value;
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && '__typename' in (value as Record<string, unknown>)) {
      return executeSelection(value as GqlObject, selection, ctx);
    }
    if (Array.isArray(value)) {
      return value.map((entry) =>
        entry !== null && typeof entry === 'object' && '__typename' in (entry as Record<string, unknown>)
          ? executeSelection(entry as GqlObject, selection, ctx)
          : entry,
      );
    }
    return value;
  }

  ctx.errors.push({ message: `Cannot query field "${field}" on type "${parent.__typename}".` });
  return null;
}

function cursorFor(index: number): string {
  return Buffer.from(`cursor:${index}`).toString('base64');
}

function cursorIndex(cursor: unknown): number {
  if (typeof cursor !== 'string') return -1;
  const decoded = Buffer.from(cursor, 'base64').toString('utf8');
  const match = /^cursor:(\d+)$/.exec(decoded);
  return match === null ? -1 : Number(match[1]);
}

function connectionResult(nodes: GqlObject[], args: Record<string, unknown>, selection: SelectionNode[] | null, ctx: ExecContext): unknown {
  const first = typeof args.first === 'number' ? args.first : nodes.length;
  const afterIndex = cursorIndex(args.after);
  const start = afterIndex + 1;
  const page = nodes.slice(start, start + first);
  const endCursor = page.length > 0 ? cursorFor(start + page.length - 1) : null;
  const conn: GqlObject = {
    __typename: 'Connection',
    nodes: page,
    edges: page.map((node, i) => ({ __typename: 'Edge', cursor: cursorFor(start + i), node })),
    totalCount: nodes.length,
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: start + first < nodes.length,
      hasPreviousPage: start > 0,
      startCursor: page.length > 0 ? cursorFor(start) : null,
      endCursor,
    },
  };
  if (selection === null) return conn;
  const out: Record<string, unknown> = {};
  for (const sel of selection) {
    if (sel.kind !== 'field') continue;
    const key = sel.alias ?? sel.name;
    if (sel.name === 'nodes') {
      out[key] = (conn.nodes as GqlObject[]).map((node) => (sel.selection === null ? node : executeSelection(node, sel.selection, ctx)));
    } else if (sel.name === 'edges') {
      out[key] = (conn.edges as GqlObject[]).map((edge) => {
        if (sel.selection === null) return edge;
        const edgeOut: Record<string, unknown> = {};
        for (const edgeSel of sel.selection) {
          if (edgeSel.kind !== 'field') continue;
          const edgeKey = edgeSel.alias ?? edgeSel.name;
          if (edgeSel.name === 'node') {
            edgeOut[edgeKey] = edgeSel.selection === null ? edge.node : executeSelection(edge.node as GqlObject, edgeSel.selection, ctx);
          } else if (edgeSel.name === 'cursor') edgeOut[edgeKey] = edge.cursor;
        }
        return edgeOut;
      });
    } else if (sel.name === 'pageInfo') {
      const info = conn.pageInfo as GqlObject;
      out[key] = sel.selection === null ? info : executeSelection(info, sel.selection, ctx);
    } else if (sel.name === 'totalCount') {
      out[key] = conn.totalCount;
    }
  }
  return out;
}

function issueConnection(repo: Repo, args: Record<string, unknown>, selection: SelectionNode[] | null, ctx: ExecContext): unknown {
  let issues = [...repo.issues];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toLowerCase()));
    issues = issues.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
  if (orderBy !== undefined && orderBy.field === 'CREATED_AT') {
    issues.sort((a, b) => (orderBy.direction === 'DESC' ? b.createdSeq - a.createdSeq : a.createdSeq - b.createdSeq));
  }
  const nodes = issues.map((issue) => issueObject(repo, issue));
  return connectionResult(nodes, args, selection, ctx);
}

function pullConnection(repo: Repo, args: Record<string, unknown>, selection: SelectionNode[] | null, ctx: ExecContext): unknown {
  let pulls = [...repo.pulls];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toLowerCase()));
    pulls = pulls.filter((pull) => wanted.has(pull.state));
  }
  const nodes = pulls.map((pull) => pullObject(repo, pull));
  return connectionResult(nodes, args, selection, ctx);
}

function resolveMutation(field: string, args: Record<string, unknown>, selection: SelectionNode[] | null, ctx: ExecContext): unknown {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const store = ctx.store;

  if (field === 'createIssue') {
    const repo = store.listRepos().find((entry) => entry.id === Number(decodeGlobalId(String(input.repositoryId ?? ''))?.parts[1]));
    if (repo === undefined) {
      ctx.errors.push({ message: 'Repository not found.' });
      return null;
    }
    const created = store.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
    if ('error' in created) {
      ctx.errors.push({ message: created.error });
      return null;
    }
    const payload: GqlObject = { __typename: 'CreateIssuePayload', issue: issueObject(repo, created) };
    return selection === null ? payload : executeSelection(payload, selection, ctx);
  }

  if (field === 'closeIssue') {
    const decoded = decodeGlobalId(String(input.issueId ?? ''));
    const repo = store.listRepos().find((entry) => entry.id === Number(decoded?.parts[1]));
    const issue = repo?.issues.find((entry) => entry.number === Number(decoded?.parts[2]));
    if (repo === undefined || issue === undefined) {
      ctx.errors.push({ message: 'Issue not found.' });
      return null;
    }
    issue.state = 'closed';
    const payload: GqlObject = { __typename: 'CloseIssuePayload', issue: issueObject(repo, issue) };
    return selection === null ? payload : executeSelection(payload, selection, ctx);
  }

  if (field === 'createPullRequest') {
    const repo = store.listRepos().find((entry) => entry.id === Number(decodeGlobalId(String(input.repositoryId ?? ''))?.parts[1]));
    if (repo === undefined) {
      ctx.errors.push({ message: 'Repository not found.' });
      return null;
    }
    const created = store.createPull(
      repo,
      String(input.headRefName ?? ''),
      String(input.baseRefName ?? ''),
      String(input.title ?? ''),
      String(input.body ?? ''),
    );
    if ('error' in created) {
      ctx.errors.push({ message: created.error });
      return null;
    }
    const payload: GqlObject = { __typename: 'CreatePullRequestPayload', pullRequest: pullObject(repo, created) };
    return selection === null ? payload : executeSelection(payload, selection, ctx);
  }

  if (field === 'mergePullRequest') {
    const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
    const repo = store.listRepos().find((entry) => entry.id === Number(decoded?.parts[1]));
    const pull = repo?.pulls.find((entry) => entry.number === Number(decoded?.parts[2]));
    if (repo === undefined || pull === undefined) {
      ctx.errors.push({ message: 'Pull request not found.' });
      return null;
    }
    const merged = store.mergePull(repo, pull);
    if ('error' in merged) {
      ctx.errors.push({ message: merged.error });
      return null;
    }
    const payload: GqlObject = { __typename: 'MergePullRequestPayload', pullRequest: pullObject(repo, pull) };
    return selection === null ? payload : executeSelection(payload, selection, ctx);
  }

  if (field === 'addComment') {
    const decoded = decodeGlobalId(String(input.subjectId ?? ''));
    const repo = store.listRepos().find((entry) => entry.id === Number(decoded?.parts[1]));
    const issue = repo?.issues.find((entry) => entry.number === Number(decoded?.parts[2]));
    if (repo === undefined || issue === undefined) {
      ctx.errors.push({ message: 'Subject not found.' });
      return null;
    }
    const comment = store.addComment(repo, issue, String(input.body ?? ''));
    const node: GqlObject = { __typename: 'IssueComment', id: globalId('comment', repo.id, issue.number, comment.id), body: comment.body };
    const payload: GqlObject = {
      __typename: 'AddCommentPayload',
      commentEdge: { __typename: 'IssueCommentEdge', node },
    };
    if (selection === null) return payload;
    const out: Record<string, unknown> = {};
    for (const sel of selection) {
      if (sel.kind !== 'field') continue;
      const key = sel.alias ?? sel.name;
      if (sel.name === 'commentEdge') {
        if (sel.selection === null) {
          out[key] = payload.commentEdge;
        } else {
          const edgeOut: Record<string, unknown> = {};
          for (const edgeSel of sel.selection) {
            if (edgeSel.kind !== 'field') continue;
            const edgeKey = edgeSel.alias ?? edgeSel.name;
            if (edgeSel.name === 'node') {
              edgeOut[edgeKey] = edgeSel.selection === null ? node : executeSelection(node, edgeSel.selection, ctx);
            }
          }
          out[key] = edgeOut;
        }
      }
    }
    return out;
  }

  ctx.errors.push({ message: `Cannot query field "${field}" on type "Mutation".` });
  return null;
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

export interface GraphqlResult {
  data?: Record<string, unknown> | null;
  errors?: { message: string }[];
}

export function executeGraphql(store: Store, body: unknown): GraphqlResult | GraphqlResult[] {
  if (Array.isArray(body)) {
    return body.map((entry) => executeOne(store, entry));
  }
  return executeOne(store, body);
}

function executeOne(store: Store, body: unknown): GraphqlResult {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { errors: [{ message: 'Request body must be a JSON object.' }] };
  }
  const { query, variables } = body as { query?: unknown; variables?: unknown };
  if (typeof query !== 'string' || query.trim() === '') {
    return { errors: [{ message: 'A query document is required.' }] };
  }
  let doc: Document;
  try {
    doc = new Parser(lex(query)).parseDocument();
  } catch (error) {
    return { errors: [{ message: `Syntax error: ${(error as Error).message}` }] };
  }
  const operation = doc.operations[0];
  if (operation === undefined) return { errors: [{ message: 'No operation found.' }] };
  const vars: Record<string, unknown> = {};
  for (const def of operation.variables) {
    const provided = (variables as Record<string, unknown> | undefined)?.[def.name];
    if (provided !== undefined) vars[def.name] = provided;
    else if (def.default !== null) vars[def.name] = resolveValue(def.default, {});
  }
  const ctx: ExecContext = { store, variables: vars, fragments: doc.fragments, errors: [] };
  const root: GqlObject = { __typename: operation.operation === 'mutation' ? 'Mutation' : 'Query' };
  const data = executeSelection(root, operation.selection, ctx);
  const result: GraphqlResult = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}
