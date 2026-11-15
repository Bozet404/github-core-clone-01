// The forge's HTTP server: one process, one in-memory store, four surfaces.
// Routing: /healthz (no auth), /api/v3/* (REST, bearer token), /api/graphql
// (bearer token), /mcp (bearer token), /{owner}/{repo}.git/* (git smart HTTP,
// bearer token). Anything else is a JSON 404. main.ts owns the lifecycle
// (bind, register, poll done); this file owns the answers.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGraphQL } from './graphql.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './git.ts';
import { handleMcp } from './mcp.ts';
import { handleRest, jsonReply } from './rest.ts';
import { viewerLogin } from './scenario.ts';
import { Store } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

function send(res: ServerResponse, status: number, contentType: string, body: Buffer | string, headers: Record<string, string> = {}): void {
  const data = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  res.writeHead(status, { 'content-type': contentType, 'content-length': data.length, ...headers });
  res.end(data);
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  send(res, status, JSON_TYPE, `${JSON.stringify(body)}\n`, headers);
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** The bearer token this entry accepts, or null when no token is configured. */
function expectedToken(): string | null {
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  return token === '' ? null : token;
}

function authorized(req: IncomingMessage): boolean {
  const expected = expectedToken();
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length);
  if (token === '') return false;
  return expected === null ? true : token === expected;
}

function unauthorized(res: ServerResponse): void {
  sendJson(res, 401, { message: 'Requires authentication' }, { 'x-github-request-id': `req-${Date.now().toString(36)}` });
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const store = new Store(viewerLogin());
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        await route(store, req, res);
      } catch (err) {
        // A handler must never take the server down with it (the suite's
        // repo-survives-errors check proves exactly that).
        try {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
        } catch {
          // The socket is already gone; nothing more to do.
        }
      }
    })();
  });
  return server;
}

async function route(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = pathOf(req);
  const method = req.method ?? 'GET';
  const baseUrl = `http://${req.headers.host ?? '127.0.0.1'}`;

  // The env's boot check calls this twice: 200 {"ok":true}, no token.
  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/info/refs, git-upload-pack, git-receive-pack.
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (gitMatch !== null) {
    if (!authorized(req)) {
      unauthorized(res);
      return;
    }
    const owner = decodeURIComponent(gitMatch[1] as string);
    const repo = decodeURIComponent(gitMatch[2] as string);
    const service = gitMatch[3] as string;
    if (service === 'info/refs') {
      if (method !== 'GET') {
        sendJson(res, 405, { message: 'Method Not Allowed' });
        return;
      }
      const query = queryOf(req);
      const reply = handleInfoRefs(store, owner, repo, query.get('service') ?? 'git-upload-pack', req.headers['git-protocol'] ?? null);
      send(res, reply.status, reply.contentType, reply.body);
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    const body = await readBody(req);
    if (service === 'git-upload-pack') {
      const reply = handleUploadPack(store, owner, repo, req.headers['git-protocol'] ?? null, body);
      send(res, reply.status, reply.contentType, reply.body);
      return;
    }
    const reply = handleReceivePack(store, owner, repo, body);
    send(res, reply.status, reply.contentType, reply.body);
    return;
  }

  // GraphQL v4.
  if (path === '/api/graphql') {
    if (method !== 'POST') {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    if (!authorized(req)) {
      unauthorized(res);
      return;
    }
    const bodyText = (await readBody(req)).toString('utf8');
    let body: unknown;
    try {
      body = JSON.parse(bodyText);
    } catch {
      sendJson(res, 400, { errors: [{ message: 'Invalid JSON' }] });
      return;
    }
    const result = handleGraphQL(store, body);
    const headers: Record<string, string> = { 'x-github-request-id': `req-${Date.now().toString(36)}` };
    sendJson(res, result.status, result.body, headers);
    return;
  }

  // MCP over streamable HTTP.
  if (path === '/mcp') {
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    if (!authorized(req)) {
      send(res, 401, JSON_TYPE, `${JSON.stringify({ message: 'Requires authentication' })}\n`);
      return;
    }
    const bodyText = (await readBody(req)).toString('utf8');
    const reply = handleMcp(store, bodyText);
    if (reply.body === null) {
      res.writeHead(reply.status);
      res.end();
      return;
    }
    send(res, reply.status, JSON_TYPE, reply.body);
    return;
  }

  // REST v3.
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    // The API root answers without a token, as the starter ships it.
    if ((path === '/api/v3' || path === '/api/v3/') && method === 'GET') {
      const reply = jsonReply(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
      sendJson(res, reply.status, reply.body, reply.headers);
      return;
    }
    if (!authorized(req)) {
      unauthorized(res);
      return;
    }
    const segments = path.slice('/api/v3/'.length).split('/').filter((s) => s !== '');
    const query = queryOf(req);
    let body: unknown = undefined;
    let bodyText = '';
    if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      bodyText = (await readBody(req)).toString('utf8');
      if (bodyText.trim() !== '') {
        try {
          body = JSON.parse(bodyText);
        } catch {
          const reply = jsonReply(400, { message: 'Invalid JSON' });
          sendJson(res, reply.status, reply.body, reply.headers);
          return;
        }
      }
    }
    const reply = handleRest({ store, method, segments, query, body, bodyText, baseUrl, path });
    if (reply.status === 204) {
      res.writeHead(204, { 'x-github-request-id': reply.headers['x-github-request-id'] ?? '' });
      res.end();
      return;
    }
    sendJson(res, reply.status, reply.body, reply.headers);
    return;
  }

  // Everything else: GitHub's 404 body.
  sendJson(res, 404, { message: 'Not Found' });
}
