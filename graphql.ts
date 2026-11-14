// graphql.ts — executor GraphQL kecil untuk API forge.
//
// Bukan implementasi GraphQL penuh: cukup untuk pola query yang dipakai
// suite (query/mutation, variabel, alias, inline fragment, __type,
// koneksi first/after, input object, enum). Validasi ketat: field yang
// tidak ada di skema menghasilkan errors[] berisi nama field itu.

import type { RepoRecord, IssueRecord, PullRecord, CommentRecord } from './store.ts';
import {
  ForgeStore,
  ForgeStoreIssues,
  ForgeStoreMerge,
} from './store.ts';

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type TokenKind = 'name' | 'string' | 'int' | 'float' | 'punct' | 'spread' | 'variable';

interface Token {
  kind: TokenKind;
  value: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string) => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string) => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i++;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (c === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if (c === '$') {
      let j = i + 1;
      while (j < source.length && isNameChar(source[j])) j++;
      tokens.push({ kind: 'variable', value: source.slice(i + 1, j) });
      i = j;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else out += esc;
          j += 2;
        } else {
          out += source[j];
          j++;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      if (source[j] === '-') j++;
      while (j < source.length && /[0-9]/.test(source[j])) j++;
      let isFloat = false;
      if (source[j] === '.') {
        isFloat = true;
        j++;
        while (j < source.length && /[0-9]/.test(source[j])) j++;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j])) j++;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if ('{}()[]:! =@'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i++;
      continue;
    }
    throw new Error(`graphql: karakter tidak dikenal: ${c}`);
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser (AST minimal)
// ---------------------------------------------------------------------------

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

export interface FieldSelection {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Record<string, ValueNode>;
  selections: Selection[] | null;
}

export interface InlineFragment {
  kind: 'inline';
  typeCondition: string | null;
  selections: Selection[];
}

export interface SpreadSelection {
  kind: 'spread';
  name: string;
}

export type Selection = FieldSelection | InlineFragment | SpreadSelection;

export interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  variables: Record<string, ValueNode | null>;
  selections: Selection[];
}

export interface Document {
  operations: Operation[];
  fragments: Record<string, Selection[]>;
}

class Parser {
  private pos = 0;

  private tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | null {
    return this.tokens[this.pos] ?? null;
  }

  private take(): Token {
    const t = this.tokens[this.pos];
    if (t === undefined) throw new Error('graphql: akhir dokumen tak terduga');
    this.pos++;
    return t;
  }

  private expectPunct(value: string): void {
    const t = this.take();
    if (t.kind !== 'punct' || t.value !== value) {
      throw new Error(`graphql: diharapkan "${value}", dapat "${t.value}"`);
    }
  }

  private acceptPunct(value: string): boolean {
    const t = this.peek();
    if (t !== null && t.kind === 'punct' && t.value === value) {
      this.pos++;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const t = this.take();
    if (t.kind !== 'name') throw new Error(`graphql: diharapkan nama, dapat "${t.value}"`);
    return t.value;
  }

  parseDocument(): Document {
    const doc: Document = { operations: [], fragments: {} };
    while (this.peek() !== null) {
      const t = this.peek()!;
      if (t.kind === 'name' && t.value === 'fragment') {
        this.take();
        const name = this.expectName();
        this.expectName(); // 'on'
        this.expectName(); // type condition (diabaikan di definisi)
        doc.fragments[name] = this.parseSelectionSet();
        continue;
      }
      doc.operations.push(this.parseOperation());
    }
    return doc;
  }

  private parseOperation(): Operation {
    let type: 'query' | 'mutation' = 'query';
    const t = this.peek();
    if (t !== null && t.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
      type = t.value as 'query' | 'mutation';
      this.take();
    }
    let name: string | null = null;
    const next = this.peek();
    if (next !== null && next.kind === 'name') {
      name = this.take().value;
    }
    const variables: Record<string, ValueNode | null> = {};
    if (this.acceptPunct('(')) {
      while (!this.acceptPunct(')')) {
        const varToken = this.take();
        if (varToken.kind !== 'variable') throw new Error('graphql: diharapkan $variabel');
        this.expectPunct(':');
        this.parseTypeRef();
        if (this.acceptPunct('=')) {
          variables[varToken.value] = this.parseValue();
        } else {
          variables[varToken.value] = null;
        }
      }
    }
    // Direktif operasi (@...) dilewati.
    while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') {
      this.take();
      this.expectName();
      if (this.acceptPunct('(')) this.parseArguments();
    }
    const selections = this.parseSelectionSet();
    return { type, name, variables, selections };
  }

  private parseTypeRef(): void {
    if (this.acceptPunct('[')) {
      this.parseTypeRef();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.acceptPunct('!');
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const out: Selection[] = [];
    while (!this.acceptPunct('}')) {
      const t = this.peek();
      if (t === null) throw new Error('graphql: selection set tidak tertutup');
      if (t.kind === 'spread') {
        this.take();
        const nameToken = this.peek();
        if (nameToken !== null && nameToken.kind === 'name' && nameToken.value === 'on') {
          this.take();
          const typeCondition = this.expectName();
          out.push({ kind: 'inline', typeCondition, selections: this.parseSelectionSet() });
        } else {
          const name = this.expectName();
          out.push({ kind: 'spread', name });
        }
        continue;
      }
      out.push(this.parseField());
    }
    return out;
  }

  private parseField(): FieldSelection {
    let alias: string | null = null;
    let name = this.expectName();
    if (this.acceptPunct(':')) {
      alias = name;
      name = this.expectName();
    }
    let args: Record<string, ValueNode> = {};
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
      args = this.parseArguments();
    }
    // Direktif field dilewati.
    while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') {
      this.take();
      this.expectName();
      if (this.acceptPunct('(')) this.parseArguments();
    }
    let selections: Selection[] | null = null;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '{') {
      selections = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, selections };
  }

  private parseArguments(): Record<string, ValueNode> {
    this.expectPunct('(');
    const out: Record<string, ValueNode> = {};
    while (!this.acceptPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      out[name] = this.parseValue();
    }
    return out;
  }

  private parseValue(): ValueNode {
    const t = this.take();
    switch (t.kind) {
      case 'variable':
        return { kind: 'variable', name: t.value };
      case 'string':
        return { kind: 'string', value: t.value };
      case 'int':
        return { kind: 'int', value: Number(t.value) };
      case 'float':
        return { kind: 'float', value: Number(t.value) };
      case 'name':
        if (t.value === 'true') return { kind: 'boolean', value: true };
        if (t.value === 'false') return { kind: 'boolean', value: false };
        if (t.value === 'null') return { kind: 'null' };
        return { kind: 'enum', value: t.value };
      case 'punct':
        if (t.value === '[') {
          const items: ValueNode[] = [];
          while (!this.acceptPunct(']')) items.push(this.parseValue());
          return { kind: 'list', items };
        }
        if (t.value === '{') {
          const fields: Record<string, ValueNode> = {};
          while (!this.acceptPunct('}')) {
            const name = this.expectName();
            this.expectPunct(':');
            fields[name] = this.parseValue();
          }
          return { kind: 'object', fields };
        }
        throw new Error(`graphql: nilai tidak dikenal: ${t.value}`);
      default:
        throw new Error(`graphql: nilai tidak dikenal: ${t.value}`);
    }
  }
}

/** Substitusi variabel menjadi nilai JS biasa. */
function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'string':
      return node.value;
    case 'int':
    case 'float':
      return node.value;
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node.fields)) {
        out[key] = resolveValue(value, variables);
      }
      return out;
    }
  }
}

// ---------------------------------------------------------------------------
// Skema (untuk validasi field + introspeksi __type)
// ---------------------------------------------------------------------------

const FIELD_SETS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Viewer: ['login'],
  User: ['login', 'id'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef',
    'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests',
    'pullRequest', 'description', 'private', 'url', 'createdAt', 'updatedAt',
    'fork', 'archived', 'homepageUrl',
  ],
  Ref: ['name', 'target'],
  Issue: [
    'id', 'number', 'title', 'body', 'state', 'author', 'createdAt', 'updatedAt',
    'closedAt', 'labels', 'comments', 'url', 'repository', 'locked', 'assignees',
    'milestone', 'reactions', 'timelineItems', 'participants',
  ],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName',
    'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'author', 'createdAt',
    'updatedAt', 'closedAt', 'mergedAt', 'mergeCommit', 'additions', 'deletions',
    'changedFiles', 'commits', 'reviews', 'url', 'repository',
  ],
  Label: ['id', 'name', 'color', 'description'],
  Comment: ['id', 'body', 'author', 'createdAt', 'updatedAt'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  FileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  FileEdge: ['node', 'cursor'],
  CommentEdge: ['node'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
  ChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description'],
  __EnumValue: ['name', 'description'],
  __Schema: ['types', 'queryType', 'mutationType'],
};

const TYPE_KIND: Record<string, string> = {
  Issue: 'OBJECT',
  PullRequest: 'OBJECT',
  Repository: 'OBJECT',
  Viewer: 'OBJECT',
  User: 'OBJECT',
  Label: 'OBJECT',
  Comment: 'OBJECT',
  SearchType: 'ENUM',
};

const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE', 'COMMIT'];

const FIXED_DATE = new Date(1735689600 * 1000).toISOString();

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

type AnyObj = Record<string, unknown>;

interface GqlError {
  message: string;
}

export class GraphQLExecutor {
  private issues: ForgeStoreIssues;
  private merge: ForgeStoreMerge;

  private store: ForgeStore;
  constructor(store: ForgeStore) {
    this.store = store;
    this.issues = new ForgeStoreIssues(store);
    this.merge = new ForgeStoreMerge(store);
  }

  /** Jalankan satu atau banyak operasi (batch = array). */
  run(body: unknown): unknown {
    if (Array.isArray(body)) {
      return body.map((item) => this.runOne(item));
    }
    return this.runOne(body);
  }

  private runOne(payload: unknown): Record<string, unknown> {
    const p = (payload ?? {}) as Record<string, unknown>;
    const query = p.query;
    const variables = (p.variables ?? {}) as Record<string, unknown>;
    if (typeof query !== 'string' || query.trim() === '') {
      return { data: null, errors: [{ message: 'query kosong' }] };
    }
    let doc: Document;
    try {
      doc = new Parser(tokenize(query)).parseDocument();
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
    }
    if (doc.operations.length === 0) {
      return { data: null, errors: [{ message: 'tidak ada operasi' }] };
    }
    const op = doc.operations[0];
    const errors: GqlError[] = [];
    const root: AnyObj = { __typename: op.type === 'mutation' ? 'Mutation' : 'Query' };
    const data = this.executeSelections(root, op.selections, variables, doc.fragments, errors);
    if (errors.length > 0) {
      return { data: null, errors };
    }
    return { data };
  }

  private executeSelections(
    obj: AnyObj,
    selections: Selection[],
    variables: Record<string, unknown>,
    fragments: Record<string, Selection[]>,
    errors: GqlError[],
  ): Record<string, unknown> | null {
    const typeName = String(obj.__typename ?? 'Query');
    const out: Record<string, unknown> = {};
    for (const sel of selections) {
      if (sel.kind === 'inline') {
        if (sel.typeCondition !== null && sel.typeCondition !== typeName) continue;
        const inner = this.executeSelections(obj, sel.selections, variables, fragments, errors);
        if (inner !== null) Object.assign(out, inner);
        continue;
      }
      if (sel.kind === 'spread') {
        const frag = fragments[sel.name];
        if (frag !== undefined) {
          const inner = this.executeSelections(obj, frag, variables, fragments, errors);
          if (inner !== null) Object.assign(out, inner);
        }
        continue;
      }
      const key = sel.alias ?? sel.name;
      const allowed = FIELD_SETS[typeName];
      if (allowed !== undefined && !allowed.includes(sel.name)) {
        errors.push({ message: `Cannot query field "${sel.name}" on type "${typeName}".` });
        continue;
      }
      const args: Record<string, unknown> = {};
      for (const [name, node] of Object.entries(sel.args)) {
        args[name] = resolveValue(node, variables);
      }
      let value: unknown;
      try {
        value = this.resolveField(obj, sel.name, args, variables);
      } catch (err) {
        errors.push({ message: err instanceof Error ? err.message : String(err) });
        continue;
      }
      if (sel.selections !== null) {
        if (value === null || value === undefined) {
          out[key] = null;
        } else if (Array.isArray(value)) {
          out[key] = value.map((item) =>
            this.isWrapped(item)
              ? this.executeSelections(item as AnyObj, sel.selections!, variables, fragments, errors)
              : item,
          );
        } else if (this.isWrapped(value)) {
          out[key] = this.executeSelections(value as AnyObj, sel.selections, variables, fragments, errors);
        } else {
          out[key] = value;
        }
      } else {
        out[key] = this.isWrapped(value) ? this.scalarize(value as AnyObj) : value;
      }
    }
    return out;
  }

  private isWrapped(value: unknown): boolean {
    return (
      typeof value === 'object' &&
      value !== null &&
      typeof (value as AnyObj).__typename === 'string'
    );
  }

  /** Nilai skalar dari objek terbungkus tanpa sub-seleksi (tidak dipakai suite). */
  private scalarize(value: AnyObj): unknown {
    return value;
  }

  // -- resolver field ----------------------------------------------------------

  private resolveField(
    obj: AnyObj,
    field: string,
    args: Record<string, unknown>,
    _variables: Record<string, unknown>,
  ): unknown {
    const typeName = String(obj.__typename ?? 'Query');
    if (typeName === 'Query') return this.resolveQuery(obj, field, args);
    if (typeName === 'Mutation') return this.resolveMutation(obj, field, args);
    if (typeName === 'Repository') return this.resolveRepository(obj, field, args);
    if (typeName === 'Issue') return this.resolveIssue(obj, field, args);
    if (typeName === 'PullRequest') return this.resolvePullRequest(obj, field, args);
    if (typeName === 'Viewer' || typeName === 'User') return obj[field] ?? null;
    if (typeName === 'Comment') {
      const repo = obj.repo as RepoRecord;
      const issue = obj.issue as IssueRecord;
      const comment = obj.comment as CommentRecord;
      if (field === 'id') return this.store.commentGlobalId(repo, issue, comment);
      if (field === 'body') return comment.body;
      if (field === 'author') return { __typename: 'User', login: repo.owner, id: repo.id };
      if (field === 'createdAt' || field === 'updatedAt') return FIXED_DATE;
      return null;
    }
    if (typeName === 'Label' || typeName === 'ChangedFile') {
      return obj[field] ?? null;
    }
    if (typeName.endsWith('Connection')) return this.resolveConnection(obj, field, args);
    if (typeName.endsWith('Edge')) return obj[field] ?? null;
    if (typeName === 'PageInfo') return obj[field] ?? null;
    if (typeName === '__Type') return this.resolveTypeInfo(obj, field, args);
    if (typeName === '__Field' || typeName === '__EnumValue') return obj[field] ?? null;
    return obj[field] ?? null;
  }

  private resolveQuery(obj: AnyObj, field: string, args: Record<string, unknown>): unknown {
    void obj;
    if (field === 'viewer') {
      return { __typename: 'Viewer', login: this.store.viewerLogin() };
    }
    if (field === 'repository') {
      const owner = String(args.owner ?? '');
      const name = String(args.name ?? '');
      const repo = this.store.getRepo(owner, name);
      if (repo === undefined) return null;
      return { __typename: 'Repository', repo };
    }
    if (field === 'node') {
      const gid = String(args.id ?? '');
      const decoded = this.store.decodeGlobalId(gid);
      if (decoded === null) return null;
      const repo = this.store.getRepo(decoded.owner, decoded.name);
      if (repo === undefined) return null;
      if (decoded.kind === 'repo') return { __typename: 'Repository', repo };
      if (decoded.kind === 'issue') {
        const issue = repo.issues.find((i) => i.number === decoded.number);
        if (issue === undefined) return null;
        return { __typename: 'Issue', repo, issue };
      }
      if (decoded.kind === 'pr') {
        const pull = repo.pulls.find((p) => p.number === decoded.number);
        if (pull === undefined) return null;
        return { __typename: 'PullRequest', repo, pull };
      }
      if (decoded.kind === 'comment') {
        const issue = repo.issues.find((i) => i.number === decoded.number);
        const comment = issue?.comments.find((c) => c.id === decoded.commentId);
        if (issue === undefined || comment === undefined) return null;
        return { __typename: 'Comment', repo, issue, comment };
      }
      return null;
    }
    if (field === '__type') {
      const name = String(args.name ?? '');
      const kind = TYPE_KIND[name] ?? 'OBJECT';
      const fields = (FIELD_SETS[name] ?? []).map((n) => ({
        __typename: '__Field',
        name: n,
        description: null,
      }));
      const enumValues =
        kind === 'ENUM'
          ? SEARCH_TYPE_VALUES.map((n) => ({ __typename: '__EnumValue', name: n, description: null }))
          : [];
      return { __typename: '__Type', name, kind, fields, enumValues, description: null };
    }
    return null;
  }

  private resolveMutation(obj: AnyObj, field: string, args: Record<string, unknown>): unknown {
    void obj;
    const input = (args.input ?? {}) as Record<string, unknown>;
    if (field === 'createIssue') {
      const decoded = this.store.decodeGlobalId(String(input.repositoryId ?? ''));
      if (decoded === null || decoded.kind !== 'repo') {
        throw new Error('repositoryId tidak valid');
      }
      const repo = this.store.getRepo(decoded.owner, decoded.name);
      if (repo === undefined) throw new Error('repository tidak ditemukan');
      const result = this.issues.createIssue(
        repo,
        String(input.title ?? ''),
        typeof input.body === 'string' ? input.body : '',
        [],
      );
      if ('error' in result) throw new Error(result.error);
      return { __typename: 'CreateIssuePayload', issue: { __typename: 'Issue', repo, issue: result.issue } };
    }
    if (field === 'closeIssue') {
      const decoded = this.store.decodeGlobalId(String(input.issueId ?? ''));
      if (decoded === null || decoded.kind !== 'issue') throw new Error('issueId tidak valid');
      const repo = this.store.getRepo(decoded.owner, decoded.name);
      const issue = repo?.issues.find((i) => i.number === decoded.number);
      if (repo === undefined || issue === undefined) throw new Error('issue tidak ditemukan');
      issue.state = 'closed';
      return { __typename: 'CloseIssuePayload', issue: { __typename: 'Issue', repo, issue } };
    }
    if (field === 'createPullRequest') {
      const decoded = this.store.decodeGlobalId(String(input.repositoryId ?? ''));
      if (decoded === null || decoded.kind !== 'repo') {
        throw new Error('repositoryId tidak valid');
      }
      const repo = this.store.getRepo(decoded.owner, decoded.name);
      if (repo === undefined) throw new Error('repository tidak ditemukan');
      const result = this.issues.createPull(
        repo,
        String(input.title ?? ''),
        typeof input.body === 'string' ? input.body : '',
        String(input.headRefName ?? ''),
        String(input.baseRefName ?? ''),
      );
      if ('error' in result) throw new Error(result.error);
      return { __typename: 'CreatePullRequestPayload', pullRequest: { __typename: 'PullRequest', repo, pull: result.pull } };
    }
    if (field === 'mergePullRequest') {
      const decoded = this.store.decodeGlobalId(String(input.pullRequestId ?? ''));
      if (decoded === null || decoded.kind !== 'pr') throw new Error('pullRequestId tidak valid');
      const repo = this.store.getRepo(decoded.owner, decoded.name);
      const pull = repo?.pulls.find((p) => p.number === decoded.number);
      if (repo === undefined || pull === undefined) throw new Error('pull request tidak ditemukan');
      if (pull.merged) throw new Error('pull request sudah merged');
      const outcome = this.merge.merge(repo, pull);
      if (outcome.conflict) throw new Error('Merge conflict');
      if (!outcome.ok) throw new Error('Merge gagal');
      return { __typename: 'MergePullRequestPayload', pullRequest: { __typename: 'PullRequest', repo, pull } };
    }
    if (field === 'addComment') {
      const decoded = this.store.decodeGlobalId(String(input.subjectId ?? ''));
      if (decoded === null || decoded.kind !== 'issue') throw new Error('subjectId tidak valid');
      const repo = this.store.getRepo(decoded.owner, decoded.name);
      const issue = repo?.issues.find((i) => i.number === decoded.number);
      if (repo === undefined || issue === undefined) throw new Error('issue tidak ditemukan');
      const comment = this.issues.addComment(repo, issue, String(input.body ?? ''));
      return {
        __typename: 'AddCommentPayload',
        commentEdge: {
          __typename: 'CommentEdge',
          node: { __typename: 'Comment', repo, issue, comment },
        },
      };
    }
    return null;
  }

  private resolveRepository(obj: AnyObj, field: string, args: Record<string, unknown>): unknown {
    const repo = obj.repo as RepoRecord;
    switch (field) {
      case 'id':
        return this.store.repoGlobalId(repo);
      case 'databaseId':
        return repo.id;
      case 'name':
        return repo.name;
      case 'nameWithOwner':
        return `${repo.owner}/${repo.name}`;
      case 'owner':
        return { __typename: 'User', login: repo.owner, id: repo.id };
      case 'defaultBranchRef': {
        const tip = this.store.branchTip(repo, repo.defaultBranch);
        if (tip === null) return null;
        return { __typename: 'Ref', name: repo.defaultBranch, target: tip };
      }
      case 'viewerPermission':
        return 'ADMIN';
      case 'hasIssuesEnabled':
        return true;
      case 'description':
        return repo.description;
      case 'private':
        return repo.isPrivate;
      case 'url':
        return `https://example.invalid/${repo.owner}/${repo.name}`;
      case 'createdAt':
      case 'updatedAt':
        return FIXED_DATE;
      case 'fork':
      case 'archived':
        return false;
      case 'homepageUrl':
        return null;
      case 'issue': {
        const number = Number(args.number ?? 0);
        const issue = repo.issues.find((i) => i.number === number);
        if (issue === undefined) return null;
        return { __typename: 'Issue', repo, issue };
      }
      case 'issues': {
        let list = [...repo.issues];
        const states = args.states as string[] | undefined;
        if (Array.isArray(states) && states.length > 0) {
          const wanted = new Set(states.map((s) => String(s).toLowerCase()));
          list = list.filter((i) => wanted.has(i.state));
        }
        const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
        const direction = String(orderBy.direction ?? 'DESC').toUpperCase();
        list.sort((a, b) => (direction === 'ASC' ? a.seq - b.seq : b.seq - a.seq));
        return this.makeConnection(
          'IssueConnection',
          list.map((issue) => ({ __typename: 'Issue', repo, issue })),
          args,
          (item) => `cursor:${(item.issue as IssueRecord).seq}`,
        );
      }
      case 'pullRequests': {
        let list = [...repo.pulls];
        const states = args.states as string[] | undefined;
        if (Array.isArray(states) && states.length > 0) {
          const wanted = new Set(states.map((s) => String(s).toLowerCase()));
          list = list.filter((p) => wanted.has(p.state === 'open' ? 'open' : 'closed'));
        }
        list.sort((a, b) => b.seq - a.seq);
        return this.makeConnection(
          'PullRequestConnection',
          list.map((pull) => ({ __typename: 'PullRequest', repo, pull })),
          args,
          (item) => `cursor:${(item.pull as PullRecord).seq}`,
        );
      }
      case 'pullRequest': {
        const number = Number(args.number ?? 0);
        const pull = repo.pulls.find((p) => p.number === number);
        if (pull === undefined) return null;
        return { __typename: 'PullRequest', repo, pull };
      }
      default:
        return null;
    }
  }

  private resolveIssue(obj: AnyObj, field: string, args: Record<string, unknown>): unknown {
    const repo = obj.repo as RepoRecord;
    const issue = obj.issue as IssueRecord;
    switch (field) {
      case 'id':
        return this.store.issueGlobalId(repo, issue);
      case 'number':
        return issue.number;
      case 'title':
        return issue.title;
      case 'body':
        return issue.body;
      case 'state':
        return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      case 'author':
        return { __typename: 'User', login: repo.owner, id: repo.id };
      case 'createdAt':
      case 'updatedAt':
        return FIXED_DATE;
      case 'closedAt':
        return issue.state === 'closed' ? FIXED_DATE : null;
      case 'labels':
        return this.makeConnection(
          'IssueConnection',
          issue.labels.map((name) => {
            const label = repo.labels.get(name);
            return { __typename: 'Label', name, color: label?.color ?? 'ededed' };
          }),
          args,
          (item) => `cursor:${String(item.name)}`,
        );
      case 'comments':
        return this.makeConnection(
          'IssueConnection',
          issue.comments.map((comment) => ({ __typename: 'Comment', repo, issue, comment })),
          args,
          (item) => `cursor:${(item.comment as { id: number }).id}`,
        );
      case 'url':
        return `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`;
      case 'repository':
        return { __typename: 'Repository', repo };
      case 'locked':
        return false;
      default:
        return null;
    }
  }

  private resolvePullRequest(obj: AnyObj, field: string, args: Record<string, unknown>): unknown {
    const repo = obj.repo as RepoRecord;
    const pull = obj.pull as PullRecord;
    switch (field) {
      case 'id':
        return this.store.pullGlobalId(repo, pull);
      case 'number':
        return pull.number;
      case 'title':
        return pull.title;
      case 'body':
        return pull.body;
      case 'state':
        if (pull.merged) return 'MERGED';
        return pull.state === 'open' ? 'OPEN' : 'CLOSED';
      case 'merged':
        return pull.merged;
      case 'mergeable':
        return this.merge.mergeable(repo, pull);
      case 'headRefName':
        return pull.headRef;
      case 'baseRefName':
        return pull.baseRef;
      case 'headRefOid':
        return pull.headSha;
      case 'baseRefOid':
        return pull.baseSha;
      case 'files': {
        const files = this.merge.filesOf(repo, pull);
        return this.makeConnection(
          'FileConnection',
          files.map((f, idx) => ({
            __typename: 'ChangedFile',
            path: f.path,
            additions: f.additions,
            deletions: f.deletions,
            changeType: f.status === 'added' ? 'ADDED' : f.status === 'removed' ? 'REMOVED' : 'MODIFIED',
            __seq: idx,
          })),
          args,
          (item) => `cursor:${String(item.__seq)}`,
        );
      }
      case 'author':
        return { __typename: 'User', login: repo.owner, id: repo.id };
      case 'createdAt':
      case 'updatedAt':
        return FIXED_DATE;
      case 'closedAt':
        return pull.state === 'closed' ? FIXED_DATE : null;
      case 'mergedAt':
        return pull.mergedAt;
      case 'mergeCommit':
        return pull.mergeCommitSha === null
          ? null
          : { __typename: 'Ref', name: pull.mergeCommitSha, target: pull.mergeCommitSha };
      case 'additions':
      case 'deletions':
      case 'changedFiles': {
        const files = this.merge.filesOf(repo, pull);
        if (field === 'additions') return files.reduce((s, f) => s + f.additions, 0);
        if (field === 'deletions') return files.reduce((s, f) => s + f.deletions, 0);
        return files.length;
      }
      case 'url':
        return `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`;
      case 'repository':
        return { __typename: 'Repository', repo };
      default:
        return null;
    }
  }

  private resolveConnection(obj: AnyObj, field: string, _args: Record<string, unknown>): unknown {
    if (field === 'nodes') return (obj.nodes as unknown[]) ?? [];
    if (field === 'pageInfo') return obj.pageInfo ?? null;
    if (field === 'totalCount') return (obj.nodes as unknown[])?.length ?? 0;
    if (field === 'edges') {
      const nodes = (obj.nodes as AnyObj[]) ?? [];
      return nodes.map((node, idx) => ({
        __typename: `${String(obj.__typename).replace('Connection', 'Edge')}`,
        node,
        cursor: (obj.cursors as string[])[idx] ?? null,
      }));
    }
    return null;
  }

  private resolveTypeInfo(obj: AnyObj, field: string, _args: Record<string, unknown>): unknown {
    if (field === 'name') return obj.name ?? null;
    if (field === 'kind') return obj.kind ?? null;
    if (field === 'fields') return (obj.fields as unknown[]) ?? [];
    if (field === 'enumValues') return (obj.enumValues as unknown[]) ?? [];
    if (field === 'description') return obj.description ?? null;
    return null;
  }

  /** Bangun koneksi (nodes + pageInfo + cursors) dari daftar terurut. */
  private makeConnection(
    typeName: string,
    items: AnyObj[],
    args: Record<string, unknown>,
    cursorOf: (item: AnyObj) => string,
  ): AnyObj {
    const first = typeof args.first === 'number' ? args.first : null;
    const after = typeof args.after === 'string' && args.after !== '' ? args.after : null;
    let start = 0;
    if (after !== null) {
      const idx = items.findIndex((item) => {
        try {
          return Buffer.from(cursorOf(item), 'utf8').toString('base64') === after;
        } catch {
          return false;
        }
      });
      if (idx >= 0) start = idx + 1;
    }
    const page = first === null ? items.slice(start) : items.slice(start, start + first);
    const hasNextPage = first !== null && start + first < items.length;
    const cursors = page.map((item) =>
      Buffer.from(cursorOf(item), 'utf8').toString('base64'),
    );
    return {
      __typename: typeName,
      nodes: page,
      cursors,
      pageInfo: {
        __typename: 'PageInfo',
        hasNextPage,
        hasPreviousPage: start > 0,
        startCursor: cursors[0] ?? null,
        endCursor: cursors[cursors.length - 1] ?? null,
      },
    };
  }
}

/** Titik masuk: jalankan body GraphQL (objek atau array batch). */
export function executeGraphQL(store: ForgeStore, body: unknown): unknown {
  return new GraphQLExecutor(store).run(body);
}
