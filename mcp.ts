// Model Context Protocol over streamable HTTP (POST /mcp), modern revision
// 2026-07-28 (server/discover, no handshake, no session) with the legacy
// initialize handshake answered too. Six tools, all on the same store as REST.

import { issueJson, pullJson, repoJson, squashMerge } from './rest.ts';
import { type Issue, type Pull, type Store } from './store.ts';

export const MCP_SERVER_NAME = 'github-core-clone';
export const MCP_SERVER_VERSION = '1.0.0';
export const MCP_SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

/** The tool list, built once: two tools/list calls answer byte-identically. */
export const TOOLS: readonly ToolDef[] = Object.freeze([
  Object.freeze({
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  }),
  Object.freeze({
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  }),
  Object.freeze({
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  }),
  Object.freeze({
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  }),
  Object.freeze({
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  }),
  Object.freeze({
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request by number.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  }),
]);

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

function okResult(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

function errResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function callTool(store: Store, name: string, args: Record<string, unknown>): ToolResult {
  const tool = TOOLS.find((t) => t.name === name);
  if (tool === undefined) return errResult(`Unknown tool: ${name}`);
  const missing = tool.inputSchema.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
  if (missing.length > 0) return errResult(`Missing required argument(s): ${missing.join(', ')}`);

  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name);
      const created = store.createRepo(repoName, {
        private: args.private === true,
        description: typeof args.description === 'string' ? args.description : '',
      });
      if (created === null) return errResult(`Repository ${repoName} already exists`);
      return okResult(repoJson(created));
    }
    case 'get_repo': {
      const repo = store.getRepo(String(args.owner), String(args.repo));
      if (repo === null) return errResult(`Repository ${args.owner}/${args.repo} not found`);
      return okResult(repoJson(repo));
    }
    case 'create_issue': {
      const repo = store.getRepo(String(args.owner), String(args.repo));
      if (repo === null) return errResult(`Repository ${args.owner}/${args.repo} not found`);
      const issue: Issue = {
        id: store.nextIssueGlobalId(),
        number: repo.nextIssueNumber++,
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        labels: [],
        comments: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      repo.issues.push(issue);
      return okResult(issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = store.getRepo(String(args.owner), String(args.repo));
      if (repo === null) return errResult(`Repository ${args.owner}/${args.repo} not found`);
      const state = typeof args.state === 'string' ? args.state : 'open';
      const list = repo.issues.filter((i) => (state === 'all' ? true : i.state === state));
      return okResult(list.map((i) => issueJson(repo, i)));
    }
    case 'create_pull_request': {
      const repo = store.getRepo(String(args.owner), String(args.repo));
      if (repo === null) return errResult(`Repository ${args.owner}/${args.repo} not found`);
      const head = String(args.head);
      const base = String(args.base);
      if (repo.refs.get(`refs/heads/${head}`) === undefined) return errResult(`head branch ${head} does not exist`);
      if (repo.refs.get(`refs/heads/${base}`) === undefined) return errResult(`base branch ${base} does not exist`);
      const dup = repo.pulls.find((p) => p.head === head && p.base === base && p.state === 'open');
      if (dup !== undefined) return errResult('a pull request from this head already exists');
      const pull: Pull = {
        id: store.nextIssueGlobalId(),
        number: repo.nextPullNumber++,
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        head,
        base,
        headSha: repo.refs.get(`refs/heads/${head}`) as string,
        baseSha: repo.refs.get(`refs/heads/${base}`) as string,
        createdAt: new Date().toISOString(),
      };
      repo.pulls.push(pull);
      return okResult(pullJson(repo, pull));
    }
    case 'merge_pull_request': {
      const repo = store.getRepo(String(args.owner), String(args.repo));
      if (repo === null) return errResult(`Repository ${args.owner}/${args.repo} not found`);
      const number = Number(args.pull_number);
      const pull = repo.pulls.find((p) => p.number === number);
      if (pull === undefined) return errResult(`Pull request #${args.pull_number} not found`);
      if (pull.merged) return errResult('Pull request has already been merged');
      const result = squashMerge(store, repo, pull);
      if ('error' in result) return errResult(result.message);
      return okResult(pullJson(repo, pull));
    }
    default:
      return errResult(`Unknown tool: ${name}`);
  }
}

export interface McpReply {
  status: number;
  body: string | null;
}

/** Handle one POST /mcp body (raw text: a malformed body is a 400/-32700). */
export function handleMcp(store: Store, bodyText: string): McpReply {
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return {
      status: 400,
      body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }),
    };
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return {
      status: 400,
      body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }),
    };
  }
  const record = body as Record<string, unknown>;
  const method = typeof record.method === 'string' ? record.method : '';
  const id = (record.id ?? null) as string | number | null;
  // A notification (no id) is answered 202 with no body.
  if (id === null && typeof record.method === 'string') {
    return { status: 202, body: null };
  }
  const result = (value: unknown): McpReply => ({
    status: 200,
    body: JSON.stringify({ jsonrpc: '2.0', id, result: value }),
  });
  const error = (code: number, message: string): McpReply => ({
    status: 200,
    body: JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }),
  });
  const params = (record.params ?? {}) as Record<string, unknown>;

  switch (method) {
    case 'server/discover':
      return result({
        supportedVersions: MCP_SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION } },
      });
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const negotiated = MCP_SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25';
      return result({
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
      });
    }
    case 'ping':
      return result({});
    case 'tools/list':
      return result({ tools: TOOLS });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      if (TOOLS.every((t) => t.name !== name)) {
        return error(-32601, `Method not found: tools/call ${name}`);
      }
      return result(callTool(store, name, args));
    }
    default:
      return error(-32601, `Method not found: ${method}`);
  }
}
