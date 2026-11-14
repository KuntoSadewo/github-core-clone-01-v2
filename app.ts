// app.ts — HTTP server for Pocket Forge.
// Routes: /healthz (no auth), /api/v3/*, /api/graphql, /mcp, and the git smart-HTTP
// endpoints /{owner}/{repo}.git/{info/refs,git-upload-pack,git-receive-pack}.
// Every reply carries X-GitHub-Request-Id. Auth: Bearer $MAKEFUN_SHOP_TOKEN; when the
// env token is empty (local dev), any non-empty Bearer token is accepted.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleRest } from './rest.ts';
import { executeGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import {
  handleFetchV0,
  handleFetchV2,
  handleLsRefs,
  handleReceivePack,
  uploadPackCommand,
  v0Advertisement,
  v2Advertisement,
} from './gitproto.ts';

const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length);
  if (token === '') return false;
  if (SHOP_TOKEN === '') return true;
  return token === SHOP_TOKEN;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const payload = body === null ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'x-github-request-id': nextRequestId(),
    ...extraHeaders,
  });
  res.end(payload);
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': contentType,
    'x-github-request-id': nextRequestId(),
    'content-length': String(body.length),
    ...extraHeaders,
  });
  res.end(body);
}

export function createApp(): Server {
  const store = new Store();

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const pathname = url.pathname;
        const segments = pathname.split('/').filter((segment) => segment !== '');
        const method = req.method ?? 'GET';

        if (pathname === '/healthz' && method === 'GET') {
          res.writeHead(200, { 'content-type': 'text/plain', 'x-github-request-id': nextRequestId() });
          res.end('ok');
          return;
        }

        if (!authorized(req)) {
          sendJson(res, 401, { message: 'Requires authentication' });
          return;
        }

        // MCP
        if (pathname === '/mcp' && method === 'POST') {
          const body = await readBody(req);
          const { status, body: payload } = handleMcp(store, body.toString('utf8'));
          sendJson(res, status, payload);
          return;
        }

        // GraphQL
        if (pathname === '/api/graphql' && method === 'POST') {
          const body = await readBody(req);
          let parsed: unknown;
          try {
            parsed = JSON.parse(body.toString('utf8'));
          } catch {
            sendJson(res, 400, { errors: [{ message: 'Parse error' }] });
            return;
          }
          sendJson(res, 200, executeGraphql(store, parsed));
          return;
        }

        // REST v3
        if (segments[0] === 'api' && segments[1] === 'v3') {
          let body: unknown = null;
          if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
            const raw = await readBody(req);
            if (raw.length > 0) {
              try {
                body = JSON.parse(raw.toString('utf8'));
              } catch {
                sendJson(res, 400, { message: 'Invalid JSON' });
                return;
              }
            }
          }
          const baseUrl = `http://${req.headers.host ?? '127.0.0.1'}`;
          const response = handleRest(store, { method, segments, query: url.searchParams, body, baseUrl });
          sendJson(res, response.status, response.body, response.headers ?? {});
          return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/{info/refs,git-upload-pack,git-receive-pack}
        if (segments.length >= 3 && segments[1] !== undefined && segments[1].endsWith('.git')) {
          const owner = decodeURIComponent(segments[0] as string);
          const repoName = decodeURIComponent((segments[1] as string).slice(0, -'.git'.length));
          const repo = store.getRepo(owner, repoName);
          if (repo === undefined) {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          const tail = segments.slice(2);
          // info/refs
          if (tail[0] === 'info' && tail[1] === 'refs' && method === 'GET') {
            const service = url.searchParams.get('service') ?? '';
            if (service === 'git-upload-pack') {
              if (req.headers['git-protocol'] === 'version=2') {
                sendBuffer(res, 200, v2Advertisement(), 'application/x-git-upload-pack-advertisement');
              } else {
                sendBuffer(res, 200, v0Advertisement(repo, 'git-upload-pack'), 'application/x-git-upload-pack-advertisement');
              }
              return;
            }
            if (service === 'git-receive-pack') {
              sendBuffer(res, 200, v0Advertisement(repo, 'git-receive-pack'), 'application/x-git-receive-pack-advertisement');
              return;
            }
            sendJson(res, 400, { message: 'service is required' });
            return;
          }
          // git-upload-pack
          if (tail[0] === 'git-upload-pack' && method === 'POST') {
            const body = await readBody(req);
            if (req.headers['git-protocol'] === 'version=2') {
              const command = uploadPackCommand(body);
              if (command === 'ls-refs') {
                sendBuffer(res, 200, handleLsRefs(repo, body), 'application/x-git-upload-pack-result');
                return;
              }
              if (command === 'fetch') {
                sendBuffer(res, 200, handleFetchV2(repo, body), 'application/x-git-upload-pack-result');
                return;
              }
              sendJson(res, 400, { message: 'unknown command' });
              return;
            }
            sendBuffer(res, 200, handleFetchV0(repo, body), 'application/x-git-upload-pack-result');
            return;
          }
          // git-receive-pack
          if (tail[0] === 'git-receive-pack' && method === 'POST') {
            const body = await readBody(req);
            sendBuffer(res, 200, handleReceivePack(repo, store, body), 'application/x-git-receive-pack-result');
            return;
          }
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }

        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        try {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'internal error' });
        } catch {
          // The response was already started; nothing left to do.
        }
      }
    })();
  });

  return server;
}
