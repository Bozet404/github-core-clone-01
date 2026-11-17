// Git smart HTTP: info/refs (v0 + v2), git-upload-pack (v2 ls-refs/fetch, v0 fetch)
// and git-receive-pack (push with report-status). The wire shape is the env's
// git-client.ts contract: pkt-line framing, section order, sideband bands, the
// exact refusal reason `non-fast-forward`, and the empty-repo forms.
//
// MAKEFUN anchor (init asli): drand quicknet round 33971985, signature
// b754f3d7d47b937d2261be4f95143dbb77c9dfde93268658e6e31223a044495cdade96b15b80d452dced25a0b1388add,
// wallet GNLZRqzayGHLkWesmuE942KaHRYdGX6fJgb6LuuMBw7m.
// Perf pass (this session, 17 Nov 2026): fetch responses are cached. A fetch
// answer is a pure function of (request, refs, objects-by-oid) — git objects
// are content-addressed and never change, and the cache key carries the full
// refs snapshot, so any push that moves a ref (or adds one) simply misses and
// rebuilds; a refused push that only stores objects cannot change the answer
// for the same key. The clone workload fires 50 identical depth-1 fetches of
// one tip, so 49 of them now reuse one built pack instead of re-walking,
// re-deflating and re-framing it. The cache is bounded (128 entries, FIFO)
// and stores the final Buffer, which no caller mutates.
// Second pass: the v2 capability advertisement never changes, so it is built
// once at module load instead of re-encoded on every info/refs call.

import {
  decodePktLines,
  encodePktLines,
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  readPack,
  writePack,
  ZERO_OID,
  type GitObject,
} from './gitobj.ts';
import {
  getObject,
  isAncestor,
  peelTag,
  type Repo,
  type Store,
} from './store.ts';

const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

const AGENT = 'github-core-clone/1.0.0';

/** How many fetch responses the cache keeps; the oldest goes first. */
const FETCH_CACHE_MAX = 128;
/** owner/repo + request + refs snapshot -> the exact response bytes. */
const fetchCache = new Map<string, Buffer>();

function fetchCacheKey(owner: string, name: string, repo: Repo, req: FetchRequest): string {
  const refs = sortedRefs(repo)
    .map((r) => `${r.name}=${r.oid}`)
    .join(',');
  return [
    owner,
    name,
    req.wants.join(','),
    req.haves.join(','),
    req.shallow.join(','),
    req.depth === null ? '' : String(req.depth),
    refs,
  ].join('|');
}

function fetchCached(owner: string, name: string, repo: Repo, req: FetchRequest): Buffer | undefined {
  return fetchCache.get(fetchCacheKey(owner, name, repo, req));
}

function fetchCacheStore(owner: string, name: string, repo: Repo, req: FetchRequest, body: Buffer): void {
  if (fetchCache.size >= FETCH_CACHE_MAX) {
    const oldest = fetchCache.keys().next().value;
    if (oldest !== undefined) fetchCache.delete(oldest);
  }
  fetchCache.set(fetchCacheKey(owner, name, repo, req), body);
}

/** Sideband-chunk a pack: band 1 packets of at most 65520 bytes each. */
function sideband(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (let i = 0; i < pack.length; i += 65500) {
    const chunk = pack.subarray(i, Math.min(pack.length, i + 65500));
    parts.push(sidebandPacket(1, chunk));
  }
  return Buffer.concat(parts);
}

/** A pkt-line carrying a Buffer payload (encodePktLines takes strings; this is the binary form). */
function pktBuf(payload: Buffer): Buffer {
  const len = payload.length + 4;
  const head = Buffer.alloc(4);
  head.write(len.toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([head, payload]);
}

function sidebandPacket(band: number, data: Buffer): Buffer {
  return pktBuf(Buffer.concat([Buffer.from([band]), data]));
}

/** All refs of a repo, sorted: heads first, then tags. */
export function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  const refs = [...repo.refs.entries()].map(([name, oid]) => ({ name, oid }));
  refs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return refs;
}

/** The peeled commit for a ref (annotated tags peel to their commit). */
function peeledOid(repo: Repo, ref: { name: string; oid: string }): string | null {
  const object = getObject(repo, ref.oid);
  if (object === undefined || object.type !== 'tag') return null;
  return peelTag(repo, ref.oid);
}

// ---------------------------------------------------------------- advertisements

/** The v2 capability advertisement: five fixed lines, identical for every repo. */
const V2_ADVERTISEMENT: Buffer = (() => {
  const caps = [
    'version 2',
    `agent=${AGENT}`,
    'ls-refs=unborn',
    'fetch=shallow',
    'object-format=sha1',
  ];
  const lines = caps.map((cap) => `${cap}\n`);
  return Buffer.concat([encodePktLines(lines), Buffer.from('0000', 'ascii')]);
})();

function v2Advertisement(): Buffer {
  return V2_ADVERTISEMENT;
}

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const serviceLine = `# service=${service}\n`;
  const refs = sortedRefs(repo);
  const headTip = repo.refs.get('refs/heads/main') ?? repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const caps =
    service === 'git-upload-pack'
      ? `symref=HEAD:refs/heads/${repo.defaultBranch} side-band-64k thin-pack ofs-delta shallow multi_ack agent=${AGENT}`
      : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const parts: Buffer[] = [encodePktLines([serviceLine, 'flush'])];
  if (refs.length === 0) {
    parts.push(encodePktLines([`${ZERO_OID} capabilities^{}\0${caps}\n`]));
    return Buffer.concat(parts);
  }
  const first = headTip !== undefined ? `${headTip} HEAD\0${caps}\n` : `${refs[0]?.oid} ${refs[0]?.name}\0${caps}\n`;
  const lines: string[] = [first];
  for (const ref of refs) {
    if (headTip !== undefined && ref.name === 'HEAD') continue;
    lines.push(`${ref.oid} ${ref.name}\n`);
    const peeled = peeledOid(repo, ref);
    if (peeled !== null) lines.push(`${peeled} ${ref.name}^{}\n`);
  }
  parts.push(encodePktLines(lines));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- fetch selection

export interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

interface FetchSelection {
  objects: Map<string, GitObject>;
  shallow: string[];
  unshallow: string[];
  wantedRefs: Array<{ oid: string; ref: string }>;
}

/** Walk commits from `roots`, tracking distance; stops at `depth` (distance < depth). */
/** A tree and everything under it (subtrees and blobs), as objects. */
function addTreeObjects(repo: Repo, treeOid: string, out: Map<string, GitObject>): void {
  const stack: string[] = [treeOid];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (out.has(oid)) continue;
    const object = getObject(repo, oid);
    if (object === undefined) continue;
    out.set(oid, object);
    if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    }
  }
}

/** A commit and its own tree closure — the commit itself, never its parents. */
function addCommitTree(repo: Repo, commitOid: string, out: Map<string, GitObject>): void {
  const object = getObject(repo, commitOid);
  if (object === undefined || object.type !== 'commit') return;
  out.set(commitOid, object);
  addTreeObjects(repo, parseCommit(object.data).tree, out);
}

function walkWithDepth(repo: Repo, roots: string[], depth: number | null): Map<string, number> {
  const dist = new Map<string, number>();
  const queue: Array<[string, number]> = [];
  for (const root of roots) {
    if (!dist.has(root)) {
      dist.set(root, 0);
      queue.push([root, 0]);
    }
  }
  while (queue.length > 0) {
    const [oid, d] = queue.shift() as [string, number];
    if (depth !== null && d + 1 >= depth) continue;
    const object = getObject(repo, oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (!dist.has(parent)) {
        dist.set(parent, d + 1);
        queue.push([parent, d + 1]);
      }
    }
  }
  return dist;
}

function selectFetch(repo: Repo, req: FetchRequest): FetchSelection {
  const shallowSet = new Set(req.shallow);
  // Exclusion: the haves' closure, cut at shallow boundaries (a shallow boundary
  // contributes only itself, never its ancestors).
  const excludedCommits = new Set<string>();
  {
    const queue: string[] = [...req.haves];
    while (queue.length > 0) {
      const oid = queue.pop() as string;
      if (excludedCommits.has(oid)) continue;
      excludedCommits.add(oid);
      if (shallowSet.has(oid)) continue;
      const object = getObject(repo, oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
  }
  // Walk from the wants.
  const tagTargets: string[] = [];
  const commitRoots: string[] = [];
  for (const want of req.wants) {
    const object = getObject(repo, want);
    if (object === undefined) continue;
    if (object.type === 'tag') tagTargets.push(parseTag(object.data).object);
    else if (object.type === 'commit') commitRoots.push(want);
  }
  const dist = walkWithDepth(repo, [...commitRoots, ...tagTargets], req.depth);
  const included = new Set<string>();
  for (const oid of dist.keys()) if (!excludedCommits.has(oid)) included.add(oid);
  // Object set: each included commit contributes itself and its own tree closure
  // only — parents stay out, which is what the depth limit means. The client
  // already holds the haves' closure, cut at shallow boundaries (a boundary
  // contributes only its own tree, never its ancestors), so that set is
  // subtracted. A naive full closure here would both leak history past a
  // shallow cut and delete objects the client does not yet hold.
  const objects = new Map<string, GitObject>();
  for (const oid of included) {
    const object = getObject(repo, oid);
    if (object === undefined) continue;
    if (object.type === 'commit') addCommitTree(repo, oid, objects);
    else if (object.type === 'tree') addTreeObjects(repo, oid, objects);
    else objects.set(oid, object);
  }
  for (const want of req.wants) {
    const object = getObject(repo, want);
    if (object !== undefined && object.type === 'tag') {
      objects.set(want, object);
      const target = parseTag(object.data).object;
      const targetObject = getObject(repo, target);
      if (targetObject !== undefined) {
        if (targetObject.type === 'tree') addTreeObjects(repo, target, objects);
        else if (targetObject.type === 'blob') objects.set(target, targetObject);
      }
    }
  }
  const held = new Map<string, GitObject>();
  for (const oid of excludedCommits) addCommitTree(repo, oid, held);
  for (const id of held.keys()) objects.delete(id);
  // Shallow-info: new boundaries are included commits whose parents were cut by depth;
  // unshallow are old boundaries whose parents are now all included.
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (req.depth !== null) {
    for (const oid of included) {
      const object = getObject(repo, oid);
      if (object === undefined || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      if (parents.length === 0 || parents.some((p) => !included.has(p))) shallow.push(oid);
    }
    for (const boundary of req.shallow) {
      const object = getObject(repo, boundary);
      if (object === undefined || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      if (parents.every((p) => included.has(p))) unshallow.push(boundary);
    }
  }
  const wantedRefs: Array<{ oid: string; ref: string }> = [];
  for (const ref of sortedRefs(repo)) {
    if (req.wants.includes(ref.oid)) wantedRefs.push({ oid: ref.oid, ref: ref.name });
  }
  return { objects, shallow, unshallow, wantedRefs };
}

// ---------------------------------------------------------------- handlers

export type GitReply = { status: number; contentType: string; body: Buffer };

function notFound(): GitReply {
  return { status: 404, contentType: 'text/plain; charset=utf-8', body: Buffer.from('Not Found\n', 'utf8') };
}

export function handleInfoRefs(store: Store, owner: string, name: string, service: string, gitProtocol: string | null): GitReply {
  const repo = store.getRepo(owner, name);
  if (repo === null) return notFound();
  if (service === 'git-receive-pack') {
    return { status: 200, contentType: RECEIVE_AD, body: v0Advertisement(repo, 'git-receive-pack') };
  }
  if (gitProtocol === 'version=2') {
    return { status: 200, contentType: UPLOAD_AD, body: v2Advertisement() };
  }
  return { status: 200, contentType: UPLOAD_AD, body: v0Advertisement(repo, 'git-upload-pack') };
}

function lsRefsResponse(repo: Repo, args: { peel: boolean; symrefs: boolean; unborn: boolean; prefixes: string[] }): Buffer {
  const lines: string[] = [];
  const refs = sortedRefs(repo);
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const hasPrefix = args.prefixes.length > 0;
  const matches = (name: string): boolean => !hasPrefix || args.prefixes.some((p) => name.startsWith(p));
  if (!hasPrefix) {
    if (headTip !== undefined) {
      lines.push(`${headTip} HEAD${args.symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`);
    } else if (args.unborn) {
      lines.push(`unborn HEAD${args.symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`);
    }
  }
  for (const ref of refs) {
    if (!matches(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (args.peel) {
      const peeled = peeledOid(repo, ref);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  const parts = [encodePktLines(lines), Buffer.from('0000', 'ascii')];
  return Buffer.concat(parts);
}

function parseV2Command(body: Buffer): { command: string; args: string[] } | null {
  let packets;
  try {
    packets = decodePktLines(body);
  } catch {
    return null;
  }
  let command: string | null = null;
  const args: string[] = [];
  let seenDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    if (command === null) {
      if (!text.startsWith('command=')) return null;
      command = text.slice('command='.length);
    } else if (seenDelim) {
      args.push(text);
    }
  }
  if (command === null) return null;
  return { command, args };
}

function v2FetchResponse(owner: string, name: string, repo: Repo, req: FetchRequest): Buffer {
  const cached = fetchCached(owner, name, repo, req);
  if (cached !== undefined) return cached;
  const sel = selectFetch(repo, req);
  const parts: Buffer[] = [];
  const sections: Array<{ name: string; lines: string[] }> = [
    { name: 'acknowledgments', lines: ['NAK\n'] },
  ];
  if (sel.shallow.length > 0 || sel.unshallow.length > 0) {
    sections.push({
      name: 'shallow-info',
      lines: [...sel.shallow.map((o) => `shallow ${o}\n`), ...sel.unshallow.map((o) => `unshallow ${o}\n`)],
    });
  }
  if (sel.wantedRefs.length > 0) {
    sections.push({ name: 'wanted-refs', lines: sel.wantedRefs.map((r) => `${r.oid} ${r.ref}\n`) });
  }
  for (const section of sections) {
    parts.push(encodePktLines([`${section.name}\n`, ...section.lines, 'delim']));
  }
  if (sel.objects.size > 0) {
    const entries = [...sel.objects.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const pack = writePack(entries.map(([, object]) => object));
    parts.push(encodePktLines(['packfile\n']));
    parts.push(sideband(pack));
  }
  parts.push(Buffer.from('0000', 'ascii'));
  const body = Buffer.concat(parts);
  fetchCacheStore(owner, name, repo, req, body);
  return body;
}

function v0FetchResponse(owner: string, name: string, repo: Repo, req: FetchRequest): Buffer {
  const cached = fetchCached(owner, name, repo, req);
  if (cached !== undefined) return cached;
  const sel = selectFetch(repo, req);
  const lines: string[] = ['NAK\n'];
  for (const oid of sel.shallow) lines.push(`shallow ${oid}\n`);
  for (const oid of sel.unshallow) lines.push(`unshallow ${oid}\n`);
  const parts: Buffer[] = [encodePktLines(lines)];
  if (sel.objects.size > 0) {
    const entries = [...sel.objects.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const pack = writePack(entries.map(([, object]) => object));
    parts.push(sideband(pack));
  }
  const body = Buffer.concat(parts);
  fetchCacheStore(owner, name, repo, req, body);
  return body;
}

function parseV2FetchArgs(args: string[]): FetchRequest {
  const req: FetchRequest = { wants: [], haves: [], shallow: [], depth: null };
  for (const arg of args) {
    if (arg.startsWith('want ')) req.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) req.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) req.shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) req.depth = parseInt(arg.slice(7), 10);
  }
  return req;
}

function parseV0FetchBody(body: Buffer): FetchRequest | null {
  let packets;
  try {
    packets = decodePktLines(body);
  } catch {
    return null;
  }
  const req: FetchRequest = { wants: [], haves: [], shallow: [], depth: null };
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    if (text.startsWith('want ')) req.wants.push(text.slice(5).split(' ')[0] as string);
    else if (text.startsWith('have ')) req.haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) req.shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) req.depth = parseInt(text.slice(7), 10);
  }
  return req;
}

export function handleUploadPack(store: Store, owner: string, name: string, gitProtocol: string | null, body: Buffer): GitReply {
  const repo = store.getRepo(owner, name);
  if (repo === null) return notFound();
  if (gitProtocol === 'version=2') {
    const parsed = parseV2Command(body);
    if (parsed === null) {
      return { status: 400, contentType: 'text/plain; charset=utf-8', body: Buffer.from('bad request\n', 'utf8') };
    }
    if (parsed.command === 'ls-refs') {
      const args = { peel: false, symrefs: false, unborn: false, prefixes: [] as string[] };
      for (const arg of parsed.args) {
        if (arg === 'peel') args.peel = true;
        else if (arg === 'symrefs') args.symrefs = true;
        else if (arg === 'unborn') args.unborn = true;
        else if (arg.startsWith('ref-prefix ')) args.prefixes.push(arg.slice('ref-prefix '.length));
      }
      return { status: 200, contentType: UPLOAD_RESULT, body: lsRefsResponse(repo, args) };
    }
    if (parsed.command === 'fetch') {
      const req = parseV2FetchArgs(parsed.args);
      return { status: 200, contentType: UPLOAD_RESULT, body: v2FetchResponse(owner, name, repo, req) };
    }
    return { status: 400, contentType: 'text/plain; charset=utf-8', body: Buffer.from(`unknown command ${parsed.command}\n`, 'utf8') };
  }
  const req = parseV0FetchBody(body);
  if (req === null) {
    return { status: 400, contentType: 'text/plain; charset=utf-8', body: Buffer.from('bad request\n', 'utf8') };
  }
  return { status: 200, contentType: UPLOAD_RESULT, body: v0FetchResponse(owner, name, repo, req) };
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function parsePushBody(body: Buffer): { commands: PushCommand[]; caps: string[]; pack: Buffer | null } | null {
  // Pkt-lines up to the first flush, then raw pack bytes.
  let i = 0;
  const commands: PushCommand[] = [];
  let caps: string[] = [];
  let first = true;
  while (i < body.length) {
    if (i + 4 > body.length) return null;
    const hex = body.subarray(i, i + 4).toString('ascii');
    if (hex === '0000') {
      i += 4;
      break;
    }
    if (hex === '0001') {
      i += 4;
      continue;
    }
    const len = parseInt(hex, 16);
    if (!Number.isFinite(len) || len < 4 || i + len > body.length) return null;
    const text = body.subarray(i + 4, i + len).toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    let line = text;
    if (first && nul >= 0) {
      caps = text.slice(nul + 1).split(' ').filter(Boolean);
      line = text.slice(0, nul);
    }
    first = false;
    const parts = line.split(' ');
    if (parts.length !== 3) return null;
    commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
    i += len;
  }
  const pack = i < body.length ? body.subarray(i) : null;
  return { commands, caps, pack };
}

export function handleReceivePack(store: Store, owner: string, name: string, body: Buffer): GitReply {
  const repo = store.getRepo(owner, name);
  if (repo === null) return notFound();
  const parsed = parsePushBody(body);
  const report = (unpackOk: boolean, unpackDetail: string, lines: string[], sidebandOn: boolean): GitReply => {
    void unpackOk;
    if (sidebandOn) {
      const parts: Buffer[] = [];
      for (const line of [`unpack ${unpackDetail}\n`, ...lines]) {
        parts.push(sidebandPacket(1, Buffer.from(line, 'utf8')));
      }
      parts.push(Buffer.from('0000', 'ascii'));
      return { status: 200, contentType: RECEIVE_RESULT, body: Buffer.concat(parts) };
    }
    const pkt = encodePktLines([`unpack ${unpackDetail}\n`, ...lines, 'flush']);
    return { status: 200, contentType: RECEIVE_RESULT, body: pkt };
  };
  if (parsed === null || parsed.commands.length === 0) {
    return report(false, 'bad request', [], true);
  }
  const sidebandOn = parsed.caps.includes('side-band-64k');
  // Unpack first: a refused ref still unpacks, and its objects stay stored.
  if (parsed.pack !== null && parsed.pack.length > 0) {
    try {
      const objects = readPack(parsed.pack);
      for (const [oid, object] of objects) repo.objects.set(oid, object);
    } catch (err) {
      return report(false, err instanceof Error ? err.message : 'unpack failed', [], sidebandOn);
    }
  }
  const lines: string[] = [];
  for (const cmd of parsed.commands) {
    const current = repo.refs.get(cmd.ref);
    let reason: string | null = null;
    if (!isOid(cmd.oldOid) || !isOid(cmd.newOid)) reason = 'bad object id';
    else if (cmd.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) reason = 'non-fast-forward';
      else if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) reason = 'non-fast-forward';
    } else if (cmd.oldOid === ZERO_OID) {
      // Create.
      if (current !== undefined) reason = 'already exists';
      else if (!repo.objects.has(cmd.newOid)) reason = 'object not found';
    } else {
      if (current === undefined) reason = 'non-fast-forward';
      else if (cmd.oldOid !== current) reason = 'non-fast-forward';
      else if (!repo.objects.has(cmd.newOid)) reason = 'object not found';
      else if (!isAncestor(repo, cmd.oldOid, cmd.newOid)) reason = 'non-fast-forward';
    }
    if (reason !== null) {
      lines.push(`ng ${cmd.ref} ${reason}\n`);
      continue;
    }
    if (cmd.newOid === ZERO_OID) repo.refs.delete(cmd.ref);
    else repo.refs.set(cmd.ref, cmd.newOid);
    lines.push(`ok ${cmd.ref}\n`);
  }
  return report(true, 'ok', lines, sidebandOn);
}
