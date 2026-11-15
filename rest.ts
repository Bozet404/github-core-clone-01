// GitHub REST v3: repositories, branches, commits, contents, issues, comments,
// labels and pull requests (with squash merge). Every reply is JSON with a
// non-empty X-GitHub-Request-Id; unknown routes are 404 {"message":...};
// malformed JSON is 400; no (or wrong) token is 401; a repo name under another
// owner is 404, never 403.

import { hashObject, isOid } from './gitobj.ts';
import {
  commitTree,
  diffTrees,
  flattenTree,
  identity,
  isoNow,
  makeCommit,
  mergeBase,
  putObject,
  refCommit,
  resolveRef,
  setTreePath,
  treeDirAt,
  treeEntryAt,
  walkCommits,
  type Issue,
  type Label,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

export interface RestReply {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

let requestCounter = 0;
function requestId(): string {
  requestCounter += 1;
  return `req-${Date.now().toString(36)}-${requestCounter}`;
}

export function jsonReply(status: number, body: unknown, extra: Record<string, string> = {}): RestReply {
  return { status, headers: { 'x-github-request-id': requestId(), ...extra }, body };
}

export function errorReply(status: number, message: string): RestReply {
  return jsonReply(status, { message });
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('Repository', `${repo.owner}/${repo.name}`),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1000, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    has_issues: true,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
  };
}

export function globalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('Issue', `${repo.owner}/${repo.name}#${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((l) => ({ name: l.name, color: l.color })),
    user: { login: repo.owner },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    comments: issue.comments.length,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

export function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = refCommit(repo, pull.head) ?? pull.headSha;
  const baseSha = refCommit(repo, pull.base) ?? pull.baseSha;
  return {
    id: pull.id,
    node_id: globalId('PullRequest', `${repo.owner}/${repo.name}#${pull.number}`),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: mergeableState(repo, pull),
    head: { ref: pull.head, sha: headSha, label: `${repo.owner}:${pull.head}` },
    base: { ref: pull.base, sha: baseSha, label: `${repo.owner}:${pull.base}` },
    user: { login: repo.owner },
    created_at: pull.createdAt,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function mergeableState(repo: Repo, pull: Pull): boolean {
  return mergeConflict(repo, pull) === null;
}

/** The conflicting path of a pull request, or null when it merges cleanly. */
export function mergeConflict(repo: Repo, pull: Pull): string | null {
  const headTip = refCommit(repo, pull.head);
  const baseTip = refCommit(repo, pull.base);
  if (headTip === null || baseTip === null) return null;
  const base = mergeBase(repo, headTip, baseTip);
  const baseTree = base === null ? null : commitTree(repo, base);
  const headTree = commitTree(repo, headTip);
  const baseTipTree = commitTree(repo, baseTip);
  const headDiff = diffTrees(repo, baseTree, headTree);
  const baseDiff = diffTrees(repo, baseTree, baseTipTree);
  for (const h of headDiff) {
    const b = baseDiff.find((d) => d.path === h.path);
    if (b !== undefined && b.newOid !== h.newOid) return h.path;
  }
  return null;
}

/** Squash-merge a pull request onto its base branch. Returns the squash sha or an error. */
export function squashMerge(store: Store, repo: Repo, pull: Pull): { sha: string } | { error: number; message: string } {
  const headTip = refCommit(repo, pull.head);
  const baseTip = refCommit(repo, pull.base);
  if (headTip === null || baseTip === null) return { error: 422, message: 'head or base branch is missing' };
  const conflict = mergeConflict(repo, pull);
  if (conflict !== null) return { error: 405, message: 'Merge conflict' };
  const base = mergeBase(repo, headTip, baseTip);
  const baseTree = base === null ? null : commitTree(repo, base);
  const headTree = commitTree(repo, headTip);
  let tree = commitTree(repo, baseTip);
  for (const change of diffTrees(repo, baseTree, headTree)) {
    tree = setTreePath(repo, tree, change.path, change.newOid);
  }
  const epoch = Math.floor(Date.now() / 1000);
  const who = identity(store.viewer, epoch);
  const sha = makeCommit(repo, {
    tree: tree ?? putObject(repo, 'tree', Buffer.alloc(0)),
    parents: [baseTip],
    message: pull.title,
    author: who,
    committer: who,
  });
  repo.refs.set(`refs/heads/${pull.base}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = isoNow();
  pull.mergeCommitSha = sha;
  pull.baseSha = sha;
  return { sha };
}

function parsePaging(query: URLSearchParams): { perPage: number; page: number } {
  const perPage = Math.max(1, Math.min(100, parseInt(query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
  return { perPage, page };
}

function pageOf<T>(items: readonly T[], perPage: number, page: number): T[] {
  return items.slice((page - 1) * perPage, page * perPage);
}

function linkHeader(base: string, path: string, query: URLSearchParams, perPage: number, page: number, total: number): string | null {
  const pages = Math.ceil(total / perPage);
  if (page >= pages) return null;
  const q = new URLSearchParams(query);
  q.set('per_page', String(perPage));
  q.set('page', String(page + 1));
  return `<${base}${path}?${q.toString()}>; rel="next"`;
}

// ---------------------------------------------------------------- contents

function contentsCommit(
  store: Store,
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer,
  message: string,
  expectedSha: string | null,
): { status: number; body: Record<string, unknown> } {
  const tip = refCommit(repo, branch);
  const tree = tip === null ? null : commitTree(repo, tip);
  const existing = tree === null ? null : treeEntryAt(repo, tree, path);
  if (expectedSha !== null) {
    if (existing === null || existing.oid !== expectedSha) {
      return { status: 409, body: { message: 'sha does not match the current blob' } };
    }
  }
  const blobOid = putObject(repo, 'blob', content);
  const newTree = setTreePath(repo, tree, path, blobOid);
  const epoch = Math.floor(Date.now() / 1000);
  const who = identity(store.viewer, epoch);
  const sha = makeCommit(repo, {
    tree: newTree,
    parents: tip === null ? [] : [tip],
    message,
    author: who,
    committer: who,
  });
  repo.refs.set(`refs/heads/${branch}`, sha);
  const created = existing === null;
  return {
    status: created ? 201 : 200,
    body: {
      content: {
        name: path.split('/').pop() ?? path,
        path,
        sha: blobOid,
        size: content.length,
        type: 'file',
        encoding: 'base64',
        content: content.toString('base64'),
      },
      commit: { sha, message },
    },
  };
}

function contentsDelete(
  store: Store,
  repo: Repo,
  branch: string,
  path: string,
  message: string,
): { status: number; body: Record<string, unknown> } {
  const tip = refCommit(repo, branch);
  if (tip === null) return { status: 404, body: { message: 'Not Found' } };
  const tree = commitTree(repo, tip);
  if (tree === null || treeEntryAt(repo, tree, path) === null) {
    return { status: 404, body: { message: 'Not Found' } };
  }
  const newTree = setTreePath(repo, tree, path, null);
  const epoch = Math.floor(Date.now() / 1000);
  const who = identity(store.viewer, epoch);
  const sha = makeCommit(repo, { tree: newTree, parents: [tip], message, author: who, committer: who });
  repo.refs.set(`refs/heads/${branch}`, sha);
  return { status: 200, body: { commit: { sha, message } } };
}

// ---------------------------------------------------------------- the router

export interface RestContext {
  store: Store;
  method: string;
  segments: string[];
  query: URLSearchParams;
  body: unknown;
  bodyText: string;
  baseUrl: string;
  path: string;
}

function needRepo(store: Store, owner: string, name: string): Repo | null {
  return store.getRepo(owner, name);
}

export function handleRest(ctx: RestContext): RestReply {
  const { store, method, segments } = ctx;
  const seg = (i: number): string | undefined => segments[i];
  const badJson = (body: unknown): body is Record<string, unknown> =>
    body !== null && typeof body === 'object' && !Array.isArray(body);

  // GET /api/v3/ — the API root (handled in app.ts, but kept here for completeness).
  if (segments.length === 0) {
    if (method === 'GET') {
      return jsonReply(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    }
    return errorReply(404, 'Not Found');
  }

  // GET /api/v3/user — the token owner's profile.
  if (segments.length === 1 && seg(0) === 'user') {
    if (method !== 'GET') return errorReply(404, 'Not Found');
    return jsonReply(200, { login: store.viewer, id: 1000, type: 'User', html_url: `https://example.invalid/${store.viewer}` });
  }

  // POST /api/v3/user/repos + GET /api/v3/user/repos (paginated).
  if (segments.length === 2 && seg(0) === 'user' && seg(1) === 'repos') {
    if (method === 'POST') {
      if (!badJson(ctx.body)) return errorReply(400, 'Invalid JSON');
      const name = typeof ctx.body.name === 'string' ? ctx.body.name : '';
      if (name === '') return errorReply(422, 'name is required');
      const created = store.createRepo(name, {
        private: ctx.body.private === true,
        description: typeof ctx.body.description === 'string' ? ctx.body.description : '',
      });
      if (created === null) return errorReply(422, 'Repository already exists');
      return jsonReply(201, repoJson(created));
    }
    if (method === 'GET') {
      const { perPage, page } = parsePaging(ctx.query);
      const all = store.listRepos();
      const link = linkHeader(ctx.baseUrl, ctx.path, ctx.query, perPage, page, all.length);
      return jsonReply(200, pageOf(all, perPage, page).map(repoJson), link === null ? {} : { link });
    }
    return errorReply(404, 'Not Found');
  }

  if (segments.length === 1 && seg(0) === 'meta') {
    if (method !== 'GET') return errorReply(404, 'Not Found');
    return jsonReply(200, { installed_version: '1.0.0' });
  }

  // /api/v3/repos/{owner}/{repo}/...
  if (seg(0) !== 'repos' || segments.length < 3) return errorReply(404, 'Not Found');
  const owner = decodeURIComponent(seg(1) as string);
  const repoName = decodeURIComponent(seg(2) as string);
  const repo = needRepo(store, owner, repoName);
  if (repo === null) return errorReply(404, 'Not Found');
  const rest = segments.slice(3);

  // GET/PATCH/DELETE /repos/{o}/{r}
  if (rest.length === 0) {
    if (method === 'GET') return jsonReply(200, repoJson(repo));
    if (method === 'PATCH') {
      if (!badJson(ctx.body)) return errorReply(400, 'Invalid JSON');
      if (typeof ctx.body.description === 'string') repo.description = ctx.body.description;
      if (typeof ctx.body.private === 'boolean') repo.private = ctx.body.private;
      return jsonReply(200, repoJson(repo));
    }
    if (method === 'DELETE') {
      store.deleteRepo(owner, repoName);
      return { status: 204, headers: { 'x-github-request-id': requestId() }, body: null };
    }
    return errorReply(404, 'Not Found');
  }

  // GET /repos/{o}/{r}/branches
  if (rest.length === 1 && rest[0] === 'branches') {
    if (method !== 'GET') return errorReply(404, 'Not Found');
    const branches = [...repo.refs.entries()]
      .filter(([name]) => name.startsWith('refs/heads/'))
      .map(([name, oid]) => ({ name: name.slice('refs/heads/'.length), commit: { sha: oid } }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    return jsonReply(200, branches);
  }

  // GET /repos/{o}/{r}/branches/{branch}
  if (rest.length === 2 && rest[0] === 'branches') {
    if (method !== 'GET') return errorReply(404, 'Not Found');
    const oid = repo.refs.get(`refs/heads/${decodeURIComponent(rest[1] as string)}`);
    if (oid === undefined) return errorReply(404, 'Not Found');
    return jsonReply(200, { name: decodeURIComponent(rest[1] as string), commit: { sha: oid }, protected: false });
  }

  // GET /repos/{o}/{r}/commits[?sha=]
  if (rest.length === 1 && rest[0] === 'commits') {
    if (method !== 'GET') return errorReply(404, 'Not Found');
    const ref = ctx.query.get('sha') ?? repo.defaultBranch;
    const tip = refCommit(repo, ref);
    if (tip === null) return errorReply(404, 'Not Found');
    const { perPage, page } = parsePaging(ctx.query);
    const commits = walkCommits(repo, tip).map((sha) => {
      const object = repo.objects.get(sha);
      const view = object === undefined ? null : parseCommitView(object.data);
      return {
        sha,
        commit: {
          message: view?.message ?? '',
          author: { name: store.viewer, email: `${store.viewer}@example.invalid` },
          committer: { name: store.viewer, email: `${store.viewer}@example.invalid` },
        },
      };
    });
    return jsonReply(200, pageOf(commits, perPage, page));
  }

  // POST /repos/{o}/{r}/git/refs ; GET /repos/{o}/{r}/git/refs[/heads/{branch}]
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      if (!badJson(ctx.body)) return errorReply(400, 'Invalid JSON');
      const ref = typeof ctx.body.ref === 'string' ? ctx.body.ref : '';
      const sha = typeof ctx.body.sha === 'string' ? ctx.body.sha : '';
      if (!ref.startsWith('refs/') || !isOid(sha) || !repo.objects.has(sha)) {
        return errorReply(422, 'invalid ref or sha');
      }
      if (repo.refs.has(ref)) return errorReply(422, 'Reference already exists');
      repo.refs.set(ref, sha);
      return jsonReply(201, { ref, object: { sha, type: 'commit' } });
    }
    if (method === 'GET') {
      if (rest.length === 2) {
        const all = [...repo.refs.entries()].map(([ref, sha]) => ({ ref, object: { sha, type: 'commit' } }));
        return jsonReply(200, all);
      }
      if (rest.length === 4 && rest[2] === 'heads') {
        const oid = repo.refs.get(`refs/heads/${decodeURIComponent(rest[3] as string)}`);
        if (oid === undefined) return errorReply(404, 'Not Found');
        return jsonReply(200, { ref: `refs/heads/${decodeURIComponent(rest[3] as string)}`, object: { sha: oid, type: 'commit' } });
      }
      if (rest.length === 4 && rest[2] === 'tags') {
        const oid = repo.refs.get(`refs/tags/${decodeURIComponent(rest[3] as string)}`);
        if (oid === undefined) return errorReply(404, 'Not Found');
        return jsonReply(200, { ref: `refs/tags/${decodeURIComponent(rest[3] as string)}`, object: { sha: oid, type: 'tag' } });
      }
    }
    return errorReply(404, 'Not Found');
  }

  // /repos/{o}/{r}/contents/{path...}
  if (rest[0] === 'contents') {
    const filePath = rest.slice(1).map((s) => decodeURIComponent(s)).join('/');
    if (filePath === '') return errorReply(404, 'Not Found');
    if (method === 'PUT') {
      if (!badJson(ctx.body)) return errorReply(400, 'Invalid JSON');
      const message = typeof ctx.body.message === 'string' ? ctx.body.message : 'update';
      const contentB64 = typeof ctx.body.content === 'string' ? ctx.body.content : '';
      let content: Buffer;
      try {
        content = Buffer.from(contentB64, 'base64');
      } catch {
        return errorReply(422, 'content is not valid base64');
      }
      let branch = repo.defaultBranch;
      if (typeof ctx.body.branch === 'string' && ctx.body.branch !== '') branch = ctx.body.branch;
      if (!repo.refs.has(`refs/heads/${branch}`)) {
        // Creating the branch: from the default branch tip, or from nothing.
        const base = refCommit(repo, repo.defaultBranch);
        if (base !== null) repo.refs.set(`refs/heads/${branch}`, base);
      }
      const sha = typeof ctx.body.sha === 'string' ? ctx.body.sha : null;
      const result = contentsCommit(store, repo, branch, filePath, content, message, sha);
      return jsonReply(result.status, result.body);
    }
    if (method === 'DELETE') {
      if (!badJson(ctx.body)) return errorReply(400, 'Invalid JSON');
      const message = typeof ctx.body.message === 'string' ? ctx.body.message : 'delete';
      const branch = typeof ctx.body.branch === 'string' && ctx.body.branch !== '' ? ctx.body.branch : repo.defaultBranch;
      const result = contentsDelete(store, repo, branch, filePath, message);
      return jsonReply(result.status, result.body);
    }
    if (method === 'GET') {
      const ref = ctx.query.get('ref') ?? repo.defaultBranch;
      const tip = refCommit(repo, ref);
      if (tip === null) return errorReply(404, 'Not Found');
      const tree = commitTree(repo, tip);
      if (tree === null) return errorReply(404, 'Not Found');
      const entry = treeEntryAt(repo, tree, filePath);
      if (entry !== null && entry.mode !== '40000') {
        const object = repo.objects.get(entry.oid);
        if (object === undefined) return errorReply(404, 'Not Found');
        return jsonReply(200, {
          name: filePath.split('/').pop() ?? filePath,
          path: filePath,
          sha: entry.oid,
          size: object.data.length,
          type: 'file',
          encoding: 'base64',
          content: object.data.toString('base64'),
        });
      }
      const dir = treeDirAt(repo, tree, filePath);
      if (dir === null) return errorReply(404, 'Not Found');
      return jsonReply(
        200,
        dir.map((e) => ({
          name: e.name,
          path: filePath === '' ? e.name : `${filePath}/${e.name}`,
          sha: e.oid,
          size: 0,
          type: e.mode === '40000' ? 'dir' : 'file',
        })),
      );
    }
    return errorReply(404, 'Not Found');
  }

  // /repos/{o}/{r}/labels
  if (rest[0] === 'labels') {
    if (method === 'POST' && rest.length === 1) {
      if (!badJson(ctx.body)) return errorReply(400, 'Invalid JSON');
      const name = typeof ctx.body.name === 'string' ? ctx.body.name : '';
      const color = typeof ctx.body.color === 'string' ? ctx.body.color : 'ededed';
      if (name === '') return errorReply(422, 'name is required');
      const existing = repo.labels.find((l) => l.name === name);
      if (existing !== undefined) return jsonReply(201, { name: existing.name, color: existing.color });
      const label: Label = { name, color };
      repo.labels.push(label);
      return jsonReply(201, { name, color });
    }
    if (method === 'GET' && rest.length === 1) {
      return jsonReply(200, repo.labels.map((l) => ({ name: l.name, color: l.color })));
    }
    return errorReply(404, 'Not Found');
  }

  // /repos/{o}/{r}/issues[/{n}[/comments]]
  if (rest[0] === 'issues') {
    if (rest.length === 1) {
      if (method === 'POST') {
        if (!badJson(ctx.body)) return errorReply(400, 'Invalid JSON');
        const title = typeof ctx.body.title === 'string' ? ctx.body.title : '';
        const body = typeof ctx.body.body === 'string' ? ctx.body.body : '';
        const labelNames = Array.isArray(ctx.body.labels) ? (ctx.body.labels as unknown[]).filter((l): l is string => typeof l === 'string') : [];
        for (const labelName of labelNames) {
          if (!repo.labels.some((l) => l.name === labelName)) return errorReply(422, `label ${labelName} does not exist`);
        }
        const issue: Issue = {
          id: store.nextIssueGlobalId(),
          number: repo.nextIssueNumber++,
          title,
          body,
          state: 'open',
          labels: labelNames.map((n) => repo.labels.find((l) => l.name === n) as Label),
          comments: [],
          createdAt: isoNow(),
          updatedAt: isoNow(),
        };
        repo.issues.push(issue);
        return jsonReply(201, issueJson(repo, issue));
      }
      if (method === 'GET') {
        const state = ctx.query.get('state') ?? 'open';
        const sort = ctx.query.get('sort') ?? 'created';
        const direction = ctx.query.get('direction') ?? 'desc';
        let list = repo.issues.filter((i) => (state === 'all' ? true : i.state === state));
        if (sort === 'created') {
          list = [...list].sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
        }
        const { perPage, page } = parsePaging(ctx.query);
        return jsonReply(200, pageOf(list, perPage, page).map((i) => issueJson(repo, i)));
      }
      return errorReply(404, 'Not Found');
    }
    const number = parseInt(rest[1] as string, 10);
    if (!Number.isInteger(number)) return errorReply(404, 'Not Found');
    const issue = repo.issues.find((i) => i.number === number);
    if (issue === undefined) return errorReply(404, 'Not Found');
    if (rest.length === 2) {
      if (method === 'GET') return jsonReply(200, issueJson(repo, issue));
      if (method === 'PATCH') {
        if (!badJson(ctx.body)) return errorReply(400, 'Invalid JSON');
        if (ctx.body.state === 'open' || ctx.body.state === 'closed') issue.state = ctx.body.state;
        if (typeof ctx.body.title === 'string') issue.title = ctx.body.title;
        if (typeof ctx.body.body === 'string') issue.body = ctx.body.body;
        issue.updatedAt = isoNow();
        return jsonReply(200, issueJson(repo, issue));
      }
      return errorReply(404, 'Not Found');
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      if (method === 'POST') {
        if (!badJson(ctx.body)) return errorReply(400, 'Invalid JSON');
        const body = typeof ctx.body.body === 'string' ? ctx.body.body : '';
        const comment = { id: store.nextCommentGlobalId(), body, user: store.viewer, createdAt: isoNow() };
        issue.comments.push(comment);
        return jsonReply(201, { id: comment.id, body: comment.body, user: { login: store.viewer }, created_at: comment.createdAt });
      }
      if (method === 'GET') {
        return jsonReply(
          200,
          issue.comments.map((c) => ({ id: c.id, body: c.body, user: { login: store.viewer }, created_at: c.createdAt })),
        );
      }
      return errorReply(404, 'Not Found');
    }
    return errorReply(404, 'Not Found');
  }

  // /repos/{o}/{r}/pulls[/{n}[/files|merge]]
  if (rest[0] === 'pulls') {
    if (rest.length === 1) {
      if (method === 'POST') {
        if (!badJson(ctx.body)) return errorReply(400, 'Invalid JSON');
        const head = typeof ctx.body.head === 'string' ? ctx.body.head : '';
        const base = typeof ctx.body.base === 'string' ? ctx.body.base : '';
        const title = typeof ctx.body.title === 'string' ? ctx.body.title : '';
        const body = typeof ctx.body.body === 'string' ? ctx.body.body : '';
        if (head === '' || base === '') return errorReply(422, 'head and base are required');
        if (repo.refs.get(`refs/heads/${head}`) === undefined) return errorReply(422, `head branch ${head} does not exist`);
        if (repo.refs.get(`refs/heads/${base}`) === undefined) return errorReply(422, `base branch ${base} does not exist`);
        const dup = repo.pulls.find((p) => p.head === head && p.base === base && p.state === 'open');
        if (dup !== undefined) return errorReply(422, 'a pull request from this head already exists');
        const pull: Pull = {
          id: store.nextIssueGlobalId(),
          number: repo.nextPullNumber++,
          title,
          body,
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
        return jsonReply(201, pullJson(repo, pull));
      }
      if (method === 'GET') {
        const state = ctx.query.get('state') ?? 'open';
        const list = repo.pulls.filter((p) => (state === 'all' ? true : p.state === state));
        const { perPage, page } = parsePaging(ctx.query);
        return jsonReply(200, pageOf(list, perPage, page).map((p) => pullJson(repo, p)));
      }
      return errorReply(404, 'Not Found');
    }
    const number = parseInt(rest[1] as string, 10);
    if (!Number.isInteger(number)) return errorReply(404, 'Not Found');
    const pull = repo.pulls.find((p) => p.number === number);
    if (pull === undefined) return errorReply(404, 'Not Found');
    if (rest.length === 2) {
      if (method === 'GET') return jsonReply(200, pullJson(repo, pull));
      return errorReply(404, 'Not Found');
    }
    if (rest.length === 3 && rest[2] === 'files') {
      if (method !== 'GET') return errorReply(404, 'Not Found');
      const headTip = refCommit(repo, pull.head);
      const baseTip = refCommit(repo, pull.base);
      if (headTip === null || baseTip === null) return errorReply(404, 'Not Found');
      const base = mergeBase(repo, headTip, baseTip);
      const files = diffTrees(repo, base === null ? null : commitTree(repo, base), commitTree(repo, headTip)).map((d) => ({
        filename: d.path,
        status: d.status === 'modified' ? 'modified' : d.status,
        additions: d.additions,
        deletions: d.deletions,
        changes: d.additions + d.deletions,
        sha: d.newOid ?? d.oldOid,
      }));
      return jsonReply(200, files);
    }
    if (rest.length === 3 && rest[2] === 'merge') {
      if (method !== 'PUT') return errorReply(404, 'Not Found');
      if (pull.merged) return errorReply(405, 'Pull request has already been merged');
      if (pull.state === 'closed') return errorReply(405, 'Pull request is closed');
      const result = squashMerge(store, repo, pull);
      if ('error' in result) return errorReply(result.error, result.message);
      return jsonReply(200, { sha: result.sha, merged: true, message: 'Pull request successfully merged' });
    }
    return errorReply(404, 'Not Found');
  }

  return errorReply(404, 'Not Found');
}

function parseCommitView(data: Buffer): { message: string } | null {
  const blank = data.indexOf('\n\n');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  return { message };
}

export { hashObject, resolveRef };
