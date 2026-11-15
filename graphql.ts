// GitHub GraphQL v4: a small parser and executor for the documents gh and
// github-mcp-server actually send (see program/env/src/checks-graphql.ts).
// Supports queries, mutations, variables, aliases, inline fragments,
// inline input objects and enum lists, __type introspection, and batched
// operation arrays. Unknown fields answer HTTP 200 with an errors array.

import { decodeGlobalId, globalId, mergeConflict, squashMerge } from './rest.ts';
import {
  commitTree,
  diffTrees,
  isoNow,
  mergeBase,
  refCommit,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

// ---------------------------------------------------------------- parsing

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Record<string, Value> };

interface Field {
  alias: string | null;
  name: string;
  args: Record<string, Value>;
  selection: Field[] | null;
}

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  variables: Record<string, Value | undefined>;
  selection: Field[];
}

interface Token {
  kind: 'name' | 'int' | 'float' | 'string' | 'punct' | 'spread' | 'var';
  value: string;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():![]=@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '$') {
      let j = i + 1;
      while (j < input.length && /[_A-Za-z0-9]/.test(input[j] as string)) j += 1;
      tokens.push({ kind: 'var', value: input.slice(i + 1, j) });
      i = j;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === '"') out += '"';
          else if (esc === '\\') out += '\\';
          else if (esc === '/') out += '/';
          else out += esc as string;
          j += 2;
        } else {
          out += input[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < input.length && /[0-9.]/.test(input[j] as string)) j += 1;
      const text = input.slice(i, j);
      tokens.push({ kind: text.includes('.') ? 'float' : 'int', value: text });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < input.length && /[_A-Za-z0-9]/.test(input[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }
  expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}, got ${token.value}`);
  }
  expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name, got ${token.value}`);
    if (value !== undefined && token.value !== value) throw new Error(`expected ${value}, got ${token.value}`);
    return token.value;
  }

  parseDocument(): Operation[] {
    const ops: Operation[] = [];
    while (this.peek() !== undefined) {
      ops.push(this.parseOperation());
    }
    return ops;
  }

  parseOperation(): Operation {
    let type: 'query' | 'mutation' = 'query';
    const first = this.peek();
    if (first !== undefined && first.kind === 'name' && (first.value === 'query' || first.value === 'mutation')) {
      type = this.next().value as 'query' | 'mutation';
    }
    let name: string | null = null;
    const maybeName = this.peek();
    if (maybeName !== undefined && maybeName.kind === 'name') name = this.next().value;
    const variables: Record<string, Value | undefined> = {};
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
        const varToken = this.next();
        if (varToken.kind !== 'var') throw new Error('expected a variable in a variable definition');
        this.expectPunct(':');
        this.parseType();
        let def: Value | undefined;
        if (this.peek()?.kind === 'punct' && this.peek()?.value === '=') {
          this.next();
          def = this.parseValue();
        }
        variables[varToken.value] = def;
      }
      this.expectPunct(')');
    }
    const selection = this.parseSelectionSet();
    return { type, name, variables, selection };
  }

  parseType(): void {
    const token = this.peek();
    if (token?.kind === 'punct' && token.value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '!') this.next();
  }

  parseSelectionSet(): Field[] {
    this.expectPunct('{');
    const fields: Field[] = [];
    while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
      const token = this.peek();
      if (token === undefined) throw new Error('unterminated selection set');
      if (token.kind === 'spread') {
        this.next();
        const on = this.peek();
        if (on !== undefined && on.kind === 'name' && on.value === 'on') {
          this.next();
          const typeName = this.expectName();
          const inner = this.parseSelectionSet();
          fields.push({ alias: null, name: `... on ${typeName}`, args: {}, selection: inner });
        } else {
          throw new Error('named fragments are not supported');
        }
        continue;
      }
      const first = this.expectName();
      let alias: string | null = null;
      let name = first;
      if (this.peek()?.kind === 'punct' && this.peek()?.value === ':') {
        this.next();
        alias = first;
        name = this.expectName();
      }
      const args: Record<string, Value> = {};
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
        this.next();
        while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
          const argName = this.expectName();
          this.expectPunct(':');
          args[argName] = this.parseValue();
        }
        this.expectPunct(')');
      }
      let selection: Field[] | null = null;
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '{') selection = this.parseSelectionSet();
      fields.push({ alias, name, args, selection });
    }
    this.expectPunct('}');
    return fields;
  }

  parseValue(): Value {
    const token = this.next();
    if (token.kind === 'var') return { kind: 'variable', name: token.value };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: parseFloat(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const items: Value[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ']')) items.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Record<string, Value> = {};
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
        const key = this.expectName();
        this.expectPunct(':');
        fields[key] = this.parseValue();
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new Error(`unexpected value token ${token.value}`);
  }
}

// ---------------------------------------------------------------- values

type NodeValue =
  | { __typename: 'User'; login: string }
  | { __typename: 'Repository'; repo: Repo }
  | { __typename: 'Ref'; name: string }
  | { __typename: 'Issue'; repo: Repo; issue: Issue }
  | { __typename: 'PullRequest'; repo: Repo; pull: Pull }
  | { __typename: 'IssueConnection'; repo: Repo; issues: Issue[]; endCursor: string | null; hasNextPage: boolean }
  | { __typename: 'PullRequestConnection'; repo: Repo; pulls: Pull[] }
  | { __typename: 'PullRequestChangedFileConnection'; paths: string[] }
  | { __typename: 'PullRequestChangedFile'; path: string }
  | { __typename: 'PageInfo'; hasNextPage: boolean; endCursor: string | null }
  | { __typename: '__Type'; name: string }
  | { __typename: '__Field'; name: string }
  | { __typename: '__EnumValue'; name: string }
  | { __typename: 'CreateIssuePayload'; repo: Repo; issue: Issue }
  | { __typename: 'CloseIssuePayload'; repo: Repo; issue: Issue }
  | { __typename: 'CreatePullRequestPayload'; repo: Repo; pull: Pull }
  | { __typename: 'MergePullRequestPayload'; repo: Repo; pull: Pull }
  | { __typename: 'AddCommentPayload'; id: string; body: string }
  | { __typename: 'IssueCommentEdge'; node: { __typename: 'IssueComment'; id: string; body: string } }
  | { __typename: 'IssueComment'; id: string; body: string };

const ISSUE_FIELDS = ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'closed', 'closedAt', 'repository', 'assignees', 'milestone', 'locked', 'viewerCanUpdate'];
const PULL_REQUEST_FIELDS = ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'url', 'createdAt', 'updatedAt', 'author', 'additions', 'deletions', 'changedFiles', 'mergeCommit', 'mergedAt', 'isDraft', 'reviewDecision', 'repository', 'closed', 'closedAt'];
const REPOSITORY_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'url', 'description', 'createdAt', 'updatedAt', 'isPrivate', 'forkCount', 'stargazerCount', 'watcherCount', 'primaryLanguage', 'licenseInfo', 'diskUsage', 'homepageUrl', 'visibility'];
const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE', 'COMMIT', 'ORGANIZATION', 'MILESTONE', 'PACKAGE', 'PROJECT', 'WIKI', 'TOPIC'];

function typeFields(name: string): string[] | null {
  if (name === 'Issue') return ISSUE_FIELDS;
  if (name === 'PullRequest') return PULL_REQUEST_FIELDS;
  if (name === 'Repository') return REPOSITORY_FIELDS;
  if (name === 'User') return ['id', 'login', 'name', 'email', 'url'];
  return null;
}

function typeEnumValues(name: string): string[] | null {
  if (name === 'SearchType') return SEARCH_TYPE_VALUES;
  if (name === 'IssueState') return ['OPEN', 'CLOSED'];
  if (name === 'PullRequestState') return ['OPEN', 'CLOSED', 'MERGED'];
  if (name === 'MergeableState') return ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'];
  if (name === 'OrderDirection') return ['ASC', 'DESC'];
  if (name === 'IssueOrderField') return ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'];
  if (name === 'RepositoryPermission') return ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'];
  if (name === 'PullRequestMergeMethod') return ['MERGE', 'SQUASH', 'REBASE'];
  return null;
}

// ---------------------------------------------------------------- execution

interface Ctx {
  store: Store;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

function resolveValue(value: Value, ctx: Ctx): unknown {
  switch (value.kind) {
    case 'variable': {
      const found = ctx.variables[value.name];
      return found === undefined ? undefined : found;
    }
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.items.map((item) => resolveValue(item, ctx));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value.fields)) out[key] = resolveValue(item, ctx);
      return out;
    }
  }
}

function argValue(field: Field, name: string, ctx: Ctx): unknown {
  const value = field.args[name];
  if (value === undefined) return undefined;
  return resolveValue(value, ctx);
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function prMergeable(repo: Repo, pull: Pull): string {
  if (pull.state !== 'open') return 'UNKNOWN';
  return mergeConflict(repo, pull) === null ? 'MERGEABLE' : 'CONFLICTING';
}

function cursorFor(number: number): string {
  return Buffer.from(`issue-cursor:${number}`, 'utf8').toString('base64');
}

function cursorNumber(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^issue-cursor:(\d+)$/.exec(text);
    return match === null ? null : parseInt(match[1], 10);
  } catch {
    return null;
  }
}

function issuesConnection(repo: Repo, field: Field, ctx: Ctx): NodeValue {
  const states = argValue(field, 'states', ctx) as string[] | undefined;
  const orderBy = argValue(field, 'orderBy', ctx) as { field?: string; direction?: string } | undefined;
  const first = argValue(field, 'first', ctx) as number | undefined;
  const after = argValue(field, 'after', ctx) as string | null | undefined;
  let list = [...repo.issues];
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s).toUpperCase()));
    list = list.filter((i) => wanted.has(issueState(i)));
  }
  const direction = (orderBy?.direction ?? 'DESC') as string;
  list.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
  if (typeof after === 'string' && after !== '') {
    const afterNumber = cursorNumber(after);
    if (afterNumber !== null) {
      const index = list.findIndex((i) => i.number === afterNumber);
      if (index >= 0) list = list.slice(index + 1);
    }
  }
  const limit = typeof first === 'number' ? first : list.length;
  const page = list.slice(0, limit);
  const hasNextPage = list.length > page.length;
  const endCursor = page.length > 0 ? cursorFor(page[page.length - 1]?.number as number) : null;
  return { __typename: 'IssueConnection', repo, issues: page, endCursor, hasNextPage };
}

function pullFiles(repo: Repo, pull: Pull, first: number | undefined): NodeValue {
  const headTip = refCommit(repo, pull.head);
  const baseTip = refCommit(repo, pull.base);
  let paths: string[] = [];
  if (headTip !== null && baseTip !== null) {
    const base = mergeBase(repo, headTip, baseTip);
    paths = diffTrees(repo, base === null ? null : commitTree(repo, base), commitTree(repo, headTip)).map((d) => d.path);
  }
  if (typeof first === 'number') paths = paths.slice(0, first);
  return { __typename: 'PullRequestChangedFileConnection', paths };
}

function resolveField(parent: NodeValue | null, field: Field, ctx: Ctx): unknown {
  if (parent === null) return null;
  switch (parent.__typename) {
    case 'User':
      if (field.name === 'login') return parent.login;
      if (field.name === 'id') return globalId('User', parent.login);
      break;
    case 'Ref':
      if (field.name === 'name') return parent.name;
      break;
    case 'Repository': {
      const repo = parent.repo;
      switch (field.name) {
        case 'id':
          return globalId('Repository', `${repo.owner}/${repo.name}`);
        case 'databaseId':
          return repo.id;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return `${repo.owner}/${repo.name}`;
        case 'owner':
          return { __typename: 'User', login: repo.owner } as NodeValue;
        case 'defaultBranchRef':
          return { __typename: 'Ref', name: repo.defaultBranch } as NodeValue;
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'issue': {
          const number = argValue(field, 'number', ctx) as number | undefined;
          const issue = repo.issues.find((i) => i.number === number);
          return issue === undefined ? null : ({ __typename: 'Issue', repo, issue } as NodeValue);
        }
        case 'issues':
          return issuesConnection(repo, field, ctx);
        case 'pullRequests': {
          const first = argValue(field, 'first', ctx) as number | undefined;
          let pulls = repo.pulls.filter((p) => p.state === 'open');
          if (typeof first === 'number') pulls = pulls.slice(0, first);
          return { __typename: 'PullRequestConnection', repo, pulls } as NodeValue;
        }
        case 'pullRequest': {
          const number = argValue(field, 'number', ctx) as number | undefined;
          const pull = repo.pulls.find((p) => p.number === number);
          return pull === undefined ? null : ({ __typename: 'PullRequest', repo, pull } as NodeValue);
        }
      }
      break;
    }
    case 'Issue': {
      const issue = parent.issue;
      switch (field.name) {
        case 'id':
          return globalId('Issue', `${parent.repo.owner}/${parent.repo.name}#${issue.number}`);
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'state':
          return issueState(issue);
        case 'body':
          return issue.body;
      }
      break;
    }
    case 'PullRequest': {
      const pull = parent.pull;
      switch (field.name) {
        case 'id':
          return globalId('PullRequest', `${parent.repo.owner}/${parent.repo.name}#${pull.number}`);
        case 'number':
          return pull.number;
        case 'state':
          return pullState(pull);
        case 'merged':
          return pull.merged;
        case 'headRefName':
          return pull.head;
        case 'baseRefName':
          return pull.base;
        case 'mergeable':
          return prMergeable(parent.repo, pull);
        case 'files':
          return pullFiles(parent.repo, pull, argValue(field, 'first', ctx) as number | undefined);
      }
      break;
    }
    case 'IssueConnection':
      if (field.name === 'nodes') return parent.issues.map((i) => ({ __typename: 'Issue', repo: parent.repo, issue: i }) as NodeValue);
      if (field.name === 'pageInfo') return { __typename: 'PageInfo', hasNextPage: parent.hasNextPage, endCursor: parent.endCursor } as NodeValue;
      break;
    case 'PullRequestConnection':
      if (field.name === 'nodes') return parent.pulls.map((p) => ({ __typename: 'PullRequest', repo: parent.repo, pull: p }) as NodeValue);
      break;
    case 'PullRequestChangedFileConnection':
      if (field.name === 'nodes') return parent.paths.map((p) => ({ __typename: 'PullRequestChangedFile', path: p }) as NodeValue);
      break;
    case 'PullRequestChangedFile':
      if (field.name === 'path') return parent.path;
      break;
    case 'PageInfo':
      if (field.name === 'hasNextPage') return parent.hasNextPage;
      if (field.name === 'endCursor') return parent.endCursor;
      break;
    case '__Type': {
      if (field.name === 'fields') {
        const names = typeFields(parent.name) ?? [];
        return names.map((n) => ({ __typename: '__Field', name: n }) as NodeValue);
      }
      if (field.name === 'enumValues') {
        const names = typeEnumValues(parent.name) ?? [];
        return names.map((n) => ({ __typename: '__EnumValue', name: n }) as NodeValue);
      }
      if (field.name === 'name') return parent.name;
      break;
    }
    case '__Field':
    case '__EnumValue':
      if (field.name === 'name') return parent.name;
      break;
    case 'CreateIssuePayload':
      if (field.name === 'issue') return { __typename: 'Issue', repo: parent.repo, issue: parent.issue } as NodeValue;
      break;
    case 'CloseIssuePayload':
      if (field.name === 'issue') return { __typename: 'Issue', repo: parent.repo, issue: parent.issue } as NodeValue;
      break;
    case 'CreatePullRequestPayload':
      if (field.name === 'pullRequest') return { __typename: 'PullRequest', repo: parent.repo, pull: parent.pull } as NodeValue;
      break;
    case 'MergePullRequestPayload':
      if (field.name === 'pullRequest') return { __typename: 'PullRequest', repo: parent.repo, pull: parent.pull } as NodeValue;
      break;
    case 'AddCommentPayload':
      if (field.name === 'commentEdge') {
        return { __typename: 'IssueCommentEdge', node: { __typename: 'IssueComment', id: parent.id, body: parent.body } } as NodeValue;
      }
      break;
    case 'IssueCommentEdge':
      if (field.name === 'node') return parent.node as NodeValue;
      break;
    case 'IssueComment':
      if (field.name === 'id') return parent.id;
      if (field.name === 'body') return parent.body;
      break;
  }
  ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${parent.__typename}".` });
  return null;
}

function executeSelection(parent: NodeValue | null, selection: Field[], ctx: Ctx): Record<string, unknown> | null {
  if (parent === null) return null;
  const out: Record<string, unknown> = {};
  for (const field of selection) {
    const key = field.alias ?? field.name;
    if (field.name.startsWith('... on ')) {
      const typeName = field.name.slice('... on '.length);
      if (parent.__typename === typeName && field.selection !== null) {
        Object.assign(out, executeSelection(parent, field.selection, ctx));
      }
      continue;
    }
    const value = resolveField(parent, field, ctx);
    if (field.selection === null) {
      out[key] = value;
    } else if (Array.isArray(value)) {
      out[key] = value.map((entry) => (isNodeValue(entry) ? executeSelection(entry, field.selection as Field[], ctx) : entry));
    } else if (isNodeValue(value)) {
      out[key] = executeSelection(value, field.selection, ctx);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function isNodeValue(value: unknown): value is NodeValue {
  return value !== null && typeof value === 'object' && '__typename' in (value as Record<string, unknown>);
}

// ---------------------------------------------------------------- mutations

function findRepoById(store: Store, id: string): Repo | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'Repository') return null;
  const slash = decoded.key.indexOf('/');
  if (slash < 0) return null;
  return store.getRepo(decoded.key.slice(0, slash), decoded.key.slice(slash + 1));
}

function findIssueById(store: Store, id: string): { repo: Repo; issue: Issue } | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'Issue') return null;
  const hash = decoded.key.lastIndexOf('#');
  if (hash < 0) return null;
  const full = decoded.key.slice(0, hash);
  const number = parseInt(decoded.key.slice(hash + 1), 10);
  const slash = full.indexOf('/');
  if (slash < 0) return null;
  const repo = store.getRepo(full.slice(0, slash), full.slice(slash + 1));
  if (repo === null) return null;
  const issue = repo.issues.find((i) => i.number === number);
  return issue === undefined ? null : { repo, issue };
}

function findPullById(store: Store, id: string): { repo: Repo; pull: Pull } | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'PullRequest') return null;
  const hash = decoded.key.lastIndexOf('#');
  if (hash < 0) return null;
  const full = decoded.key.slice(0, hash);
  const number = parseInt(decoded.key.slice(hash + 1), 10);
  const slash = full.indexOf('/');
  if (slash < 0) return null;
  const repo = store.getRepo(full.slice(0, slash), full.slice(slash + 1));
  if (repo === null) return null;
  const pull = repo.pulls.find((p) => p.number === number);
  return pull === undefined ? null : { repo, pull };
}

function resolveMutation(store: Store, field: Field, ctx: Ctx): NodeValue | null {
  const input = argValue(field, 'input', ctx) as Record<string, unknown> | undefined;
  if (input === undefined) {
    ctx.errors.push({ message: `Field "${field.name}" requires an input argument.` });
    return null;
  }
  switch (field.name) {
    case 'createIssue': {
      const repo = findRepoById(store, String(input.repositoryId ?? ''));
      if (repo === null) {
        ctx.errors.push({ message: 'Could not resolve to a Repository with the id provided.' });
        return null;
      }
      const issue: Issue = {
        id: store.nextIssueGlobalId(),
        number: repo.nextIssueNumber++,
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        labels: [],
        comments: [],
        createdAt: isoNow(),
        updatedAt: isoNow(),
      };
      repo.issues.push(issue);
      return { __typename: 'CreateIssuePayload', repo, issue };
    }
    case 'closeIssue': {
      const found = findIssueById(store, String(input.issueId ?? ''));
      if (found === null) {
        ctx.errors.push({ message: 'Could not resolve to an Issue with the id provided.' });
        return null;
      }
      found.issue.state = 'closed';
      found.issue.updatedAt = isoNow();
      return { __typename: 'CloseIssuePayload', repo: found.repo, issue: found.issue };
    }
    case 'createPullRequest': {
      const repo = findRepoById(store, String(input.repositoryId ?? ''));
      if (repo === null) {
        ctx.errors.push({ message: 'Could not resolve to a Repository with the id provided.' });
        return null;
      }
      const head = String(input.headRefName ?? '');
      const base = String(input.baseRefName ?? '');
      if (repo.refs.get(`refs/heads/${head}`) === undefined || repo.refs.get(`refs/heads/${base}`) === undefined) {
        ctx.errors.push({ message: 'head or base branch does not exist.' });
        return null;
      }
      const pull: Pull = {
        id: store.nextIssueGlobalId(),
        number: repo.nextPullNumber++,
        title: String(input.title ?? ''),
        body: '',
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        head,
        base,
        headSha: repo.refs.get(`refs/heads/${head}`) as string,
        baseSha: repo.refs.get(`refs/heads/${base}`) as string,
        createdAt: isoNow(),
      };
      repo.pulls.push(pull);
      return { __typename: 'CreatePullRequestPayload', repo, pull };
    }
    case 'mergePullRequest': {
      const found = findPullById(store, String(input.pullRequestId ?? ''));
      if (found === null) {
        ctx.errors.push({ message: 'Could not resolve to a PullRequest with the id provided.' });
        return null;
      }
      const result = squashMerge(store, found.repo, found.pull);
      if ('error' in result) {
        ctx.errors.push({ message: result.message });
        return null;
      }
      return { __typename: 'MergePullRequestPayload', repo: found.repo, pull: found.pull };
    }
    case 'addComment': {
      const found = findIssueById(store, String(input.subjectId ?? ''));
      const body = String(input.body ?? '');
      if (found !== null) {
        const id = store.nextCommentGlobalId();
        found.issue.comments.push({ id, body, user: store.viewer, createdAt: isoNow() });
        return { __typename: 'AddCommentPayload', id: globalId('IssueComment', `${found.repo.owner}/${found.repo.name}#${found.issue.number}:${id}`), body };
      }
      const pullFound = findPullById(store, String(input.subjectId ?? ''));
      if (pullFound !== null) {
        const id = store.nextCommentGlobalId();
        return { __typename: 'AddCommentPayload', id: globalId('IssueComment', `${pullFound.repo.owner}/${pullFound.repo.name}#${pullFound.pull.number}:${id}`), body };
      }
      ctx.errors.push({ message: 'Could not resolve to an Issue with the id provided.' });
      return null;
    }
    default:
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Mutation".` });
      return null;
  }
}

function resolveRoot(store: Store, op: Operation, field: Field, ctx: Ctx): unknown {
  if (op.type === 'mutation') {
    return resolveMutation(store, field, ctx);
  }
  switch (field.name) {
    case 'viewer':
      return { __typename: 'User', login: store.viewer } as NodeValue;
    case 'repository': {
      const owner = String(argValue(field, 'owner', ctx) ?? '');
      const name = String(argValue(field, 'name', ctx) ?? '');
      const repo = store.getRepo(owner, name);
      return repo === null ? null : ({ __typename: 'Repository', repo } as NodeValue);
    }
    case 'node': {
      const id = String(argValue(field, 'id', ctx) ?? '');
      const decoded = decodeGlobalId(id);
      if (decoded === null) return null;
      if (decoded.kind === 'Repository') {
        const repo = findRepoById(store, id);
        return repo === null ? null : ({ __typename: 'Repository', repo } as NodeValue);
      }
      if (decoded.kind === 'Issue') {
        const found = findIssueById(store, id);
        return found === null ? null : ({ __typename: 'Issue', repo: found.repo, issue: found.issue } as NodeValue);
      }
      if (decoded.kind === 'PullRequest') {
        const found = findPullById(store, id);
        return found === null ? null : ({ __typename: 'PullRequest', repo: found.repo, pull: found.pull } as NodeValue);
      }
      return null;
    }
    case '__type': {
      const name = String(argValue(field, 'name', ctx) ?? '');
      if (typeFields(name) === null && typeEnumValues(name) === null) return null;
      return { __typename: '__Type', name } as NodeValue;
    }
    default:
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Query".` });
      return null;
  }
}

// ---------------------------------------------------------------- entry points

export interface GraphQLResult {
  data: Record<string, unknown> | null;
  errors?: Array<{ message: string }>;
}

export function executeGraphQL(store: Store, query: string, variables: Record<string, unknown>): GraphQLResult {
  const ctx: Ctx = { store, variables: variables ?? {}, errors: [] };
  let operations: Operation[];
  try {
    operations = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Syntax Error' }] };
  }
  const data: Record<string, unknown> = {};
  for (const op of operations) {
    for (const field of op.selection) {
      const key = field.alias ?? field.name;
      const value = resolveRoot(store, op, field, ctx);
      if (field.selection === null) {
        data[key] = value;
      } else if (isNodeValue(value)) {
        data[key] = executeSelection(value, field.selection, ctx);
      } else {
        data[key] = value;
      }
    }
  }
  const result: GraphQLResult = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

/** Handle one POST /api/graphql body (a single operation or a batch array). */
export function handleGraphQL(store: Store, body: unknown): { status: number; body: unknown } {
  if (Array.isArray(body)) {
    const results = body.map((entry) => {
      if (entry === null || typeof entry !== 'object') return { data: null, errors: [{ message: 'Invalid operation' }] };
      const record = entry as Record<string, unknown>;
      const query = typeof record.query === 'string' ? record.query : '';
      const variables = (record.variables ?? {}) as Record<string, unknown>;
      return executeGraphQL(store, query, variables);
    });
    return { status: 200, body: results };
  }
  if (body === null || typeof body !== 'object') {
    return { status: 400, body: { errors: [{ message: 'Invalid GraphQL body' }] } };
  }
  const record = body as Record<string, unknown>;
  const query = typeof record.query === 'string' ? record.query : '';
  const variables = (record.variables ?? {}) as Record<string, unknown>;
  return { status: 200, body: executeGraphQL(store, query, variables) };
}
