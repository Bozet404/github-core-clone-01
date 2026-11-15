// The forge's whole state: one in-memory store, no disk. A Repo holds its git objects
// and refs plus its REST resources (issues, labels, pull requests); every surface
// (git smart HTTP, REST, GraphQL, MCP) reads and writes this one store, so the
// cross-surface checks always see the same objects.

import {
  buildCommit,
  buildTree,
  hashObject,
  isOid,
  makeObject,
  parseCommit,
  parseTag,
  parseTree,
  type GitObject,
  type ObjType,
  type TreeEntry,
  ZERO_OID,
} from './gitobj.ts';

export interface Label {
  name: string;
  color: string;
}

export interface Comment {
  id: number;
  body: string;
  user: string;
  createdAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: Comment[];
  createdAt: string;
  updatedAt: string;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  createdAt: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  createdAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Issue[];
  labels: Label[];
  pulls: Pull[];
  nextIssueNumber: number;
  nextPullNumber: number;
}

export function isoNow(): string {
  return new Date().toISOString();
}

export class Store {
  readonly viewer: string;
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 5000;
  private nextIssueId = 100000;
  private nextCommentId = 200000;

  constructor(viewer: string) {
    this.viewer = viewer;
  }

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(name: string, opts: { private?: boolean; description?: string }): Repo | null {
    const key = this.key(this.viewer, name);
    if (this.repos.has(key)) return null;
    const repo: Repo = {
      id: this.nextRepoId++,
      name,
      owner: this.viewer,
      private: opts.private ?? false,
      description: opts.description ?? '',
      defaultBranch: 'main',
      createdAt: isoNow(),
      objects: new Map(),
      refs: new Map(),
      issues: [],
      labels: [],
      pulls: [],
      nextIssueNumber: 1,
      nextPullNumber: 1,
    };
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | null {
    if (owner !== this.viewer) return null;
    return this.repos.get(this.key(owner, name)) ?? null;
  }

  deleteRepo(owner: string, name: string): boolean {
    if (owner !== this.viewer) return false;
    return this.repos.delete(this.key(owner, name));
  }

  listRepos(): Repo[] {
    return [...this.repos.values()];
  }

  nextIssueGlobalId(): number {
    return this.nextIssueId++;
  }

  nextCommentGlobalId(): number {
    return this.nextCommentId++;
  }
}

// ---------------------------------------------------------------- git model

/** Resolve a ref name, branch short name or raw oid to a commit oid (or null). */
export function resolveRef(repo: Repo, ref: string): string | null {
  if (isOid(ref)) return repo.objects.has(ref) ? ref : null;
  const full = ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
  const oid = repo.refs.get(full);
  return oid ?? null;
}

/** The commit a ref points at (following annotated tags), or null. */
export function refCommit(repo: Repo, ref: string): string | null {
  const oid = resolveRef(repo, ref);
  if (oid === null) return null;
  const object = repo.objects.get(oid);
  if (object === undefined) return null;
  if (object.type === 'tag') return parseTag(object.data).object;
  if (object.type === 'commit') return oid;
  return null;
}

export function putObject(repo: Repo, type: ObjType, data: Buffer): string {
  const { oid, object } = makeObject(type, data);
  repo.objects.set(oid, object);
  return oid;
}

export function getObject(repo: Repo, oid: string): GitObject | undefined {
  return repo.objects.get(oid);
}

/** Commits reachable from `start`, newest first (children before parents). */
export function walkCommits(repo: Repo, start: string, limit = 10000): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack: string[] = [start];
  while (stack.length > 0 && out.length < limit) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    out.push(oid);
    const view = parseCommit(object.data);
    for (const parent of view.parents) stack.push(parent);
  }
  return out;
}

/** The set of commits reachable from `start` (including `start` itself). */
export function ancestorSet(repo: Repo, start: string): Set<string> {
  return new Set(walkCommits(repo, start));
}

/** True when `ancestor` is reachable from `descendant` (or equal). */
export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  return ancestorSet(repo, descendant).has(ancestor);
}

/** Best common ancestor of two commits (first common commit walking from `a`). */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const bAncestors = ancestorSet(repo, b);
  for (const oid of walkCommits(repo, a)) {
    if (bAncestors.has(oid)) return oid;
  }
  return null;
}

/** Every object reachable from a commit: the commit, its trees and blobs, recursively. */
export function closureOfCommit(repo: Repo, commitOid: string, out = new Map<string, GitObject>()): Map<string, GitObject> {
  const stack: string[] = [commitOid];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (out.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    out.set(oid, object);
    if (object.type === 'commit') {
      const view = parseCommit(object.data);
      stack.push(view.tree);
      for (const parent of view.parents) stack.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return out;
}

/** Flatten a tree to path -> {oid, mode}, recursing into subtrees. */
export function flattenTree(repo: Repo, treeOid: string, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
  const object = repo.objects.get(treeOid);
  if (object === undefined || object.type !== 'tree') return out;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(repo, entry.oid, path, out);
    else out.set(path, { oid: entry.oid, mode: entry.mode });
  }
  return out;
}

/** The entry at `path` in a tree (blob or subtree), or null. */
export function treeEntryAt(repo: Repo, treeOid: string, path: string): { oid: string; mode: string } | null {
  const segments = path.split('/').filter((s) => s !== '');
  let current = treeOid;
  for (let i = 0; i < segments.length; i += 1) {
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((e) => e.name === segments[i]);
    if (entry === undefined) return null;
    if (i === segments.length - 1) return { oid: entry.oid, mode: entry.mode };
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

/** The entries directly under `path` in a tree ('' = root), or null when missing. */
export function treeDirAt(repo: Repo, treeOid: string, path: string): TreeEntry[] | null {
  if (path === '') {
    const object = repo.objects.get(treeOid);
    if (object === undefined || object.type !== 'tree') return null;
    return parseTree(object.data);
  }
  const entry = treeEntryAt(repo, treeOid, path);
  if (entry === null || entry.mode !== '40000') return null;
  const object = repo.objects.get(entry.oid);
  if (object === undefined || object.type !== 'tree') return null;
  return parseTree(object.data);
}

/**
 * Return a new root tree oid with `path` set to `blobOid` (or removed when null),
 * creating intermediate trees as needed. The old tree is untouched.
 */
export function setTreePath(repo: Repo, rootOid: string | null, path: string, blobOid: string | null): string {
  const segments = path.split('/').filter((s) => s !== '');
  const build = (treeOid: string | null, depth: number): string | null => {
    const entries = new Map<string, TreeEntry>();
    if (treeOid !== null) {
      const object = repo.objects.get(treeOid);
      if (object !== undefined && object.type === 'tree') {
        for (const entry of parseTree(object.data)) entries.set(entry.name, entry);
      }
    }
    const name = segments[depth] as string;
    if (depth === segments.length - 1) {
      if (blobOid === null) entries.delete(name);
      else entries.set(name, { mode: '100644', name, oid: blobOid });
    } else {
      const child = entries.get(name);
      const next = build(child !== undefined && child.mode === '40000' ? child.oid : null, depth + 1);
      if (next === null) entries.delete(name);
      else entries.set(name, { mode: '40000', name, oid: next });
    }
    if (entries.size === 0) return null;
    return putObject(repo, 'tree', buildTree([...entries.values()]));
  };
  const result = build(rootOid, 0);
  if (result === null) return putObject(repo, 'tree', buildTree([]));
  return result;
}

export interface FileDiff {
  path: string;
  status: 'added' | 'removed' | 'modified';
  oldOid: string | null;
  newOid: string | null;
  additions: number;
  deletions: number;
}

/** A line diff's added/removed counts, by longest common subsequence on lines. */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  if (a.length === 0 && b.length === 0) return { additions: 0, deletions: 0 };
  // LCS on lines; files here are small (the suite's are under a few KB).
  const m = a.length;
  const n = b.length;
  const dp = new Uint32Array((m + 1) * (n + 1));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i * (n + 1) + j] = a[i] === b[j] ? dp[(i + 1) * (n + 1) + (j + 1)] + 1 : Math.max(dp[(i + 1) * (n + 1) + j], dp[i * (n + 1) + (j + 1)]);
    }
  }
  const common = dp[0];
  return { additions: n - common, deletions: m - common };
}

/** The file-level diff between two trees (null tree = empty). */
export function diffTrees(repo: Repo, oldTree: string | null, newTree: string | null): FileDiff[] {
  const oldMap = oldTree === null ? new Map() : flattenTree(repo, oldTree);
  const newMap = newTree === null ? new Map() : flattenTree(repo, newTree);
  const paths = new Set([...oldMap.keys(), ...newMap.keys()]);
  const out: FileDiff[] = [];
  for (const path of [...paths].sort()) {
    const oldEntry = oldMap.get(path);
    const newEntry = newMap.get(path);
    if (oldEntry !== undefined && newEntry === undefined) {
      const oldData = repo.objects.get(oldEntry.oid)?.data.toString('utf8') ?? '';
      const { deletions } = lineDiff(oldData, '');
      out.push({ path, status: 'removed', oldOid: oldEntry.oid, newOid: null, additions: 0, deletions });
    } else if (oldEntry === undefined && newEntry !== undefined) {
      const newData = repo.objects.get(newEntry.oid)?.data.toString('utf8') ?? '';
      const { additions } = lineDiff('', newData);
      out.push({ path, status: 'added', oldOid: null, newOid: newEntry.oid, additions, deletions: 0 });
    } else if (oldEntry !== undefined && newEntry !== undefined && oldEntry.oid !== newEntry.oid) {
      const oldData = repo.objects.get(oldEntry.oid)?.data.toString('utf8') ?? '';
      const newData = repo.objects.get(newEntry.oid)?.data.toString('utf8') ?? '';
      const { additions, deletions } = lineDiff(oldData, newData);
      out.push({ path, status: 'modified', oldOid: oldEntry.oid, newOid: newEntry.oid, additions, deletions });
    }
  }
  return out;
}

/** The identity line for a commit: `Name <email> <epoch> +0000`. */
export function identity(login: string, epochSec: number): string {
  return `${login} <${login}@example.invalid> ${epochSec} +0000`;
}

/** Create a commit object on a tree; returns its oid. */
export function makeCommit(
  repo: Repo,
  opts: { tree: string; parents?: readonly string[]; message: string; author: string; committer: string },
): string {
  return putObject(repo, 'commit', buildCommit(opts));
}

/** The tree oid of a commit, or null. */
export function commitTree(repo: Repo, commitOid: string): string | null {
  const object = repo.objects.get(commitOid);
  if (object === undefined || object.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}

/** The peeled commit a tag object points at (following nested tags). */
export function peelTag(repo: Repo, tagOid: string): string | null {
  let current = tagOid;
  for (let i = 0; i < 10; i += 1) {
    const object = repo.objects.get(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type !== 'tag') return null;
    current = parseTag(object.data).object;
  }
  return null;
}

export { ZERO_OID, hashObject };
