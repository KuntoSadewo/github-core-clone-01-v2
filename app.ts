// app.ts — server HTTP forge: routing, auth bearer, parsing body.
//
// Permukaan:
//   GET  /healthz                      — tanpa auth, 200 {ok:true}
//   /api/v3/*                          — REST v3 (auth bearer)
//   POST /api/graphql                  — GraphQL (auth bearer)
//   POST /mcp                          — MCP JSON-RPC (auth bearer)
//   /{owner}/{repo}.git/info/refs      — git advertisement (auth bearer)
//   /{owner}/{repo}.git/git-upload-pack
//   /{owner}/{repo}.git/git-receive-pack
//
// Bila MAKEFUN_SHOP_TOKEN kosong, auth dilewati (mode uji lokal).

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { ForgeStore } from './store.ts';
import { RestHandlers } from './rest.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import type { GitResponse } from './gitproto.ts';
import {
  infoRefsUpload,
  infoRefsReceive,
  handleLsRefs,
  handleUploadPack,
  handleReceivePack,
} from './gitproto.ts';

export interface ForgeServerOptions {
  shopToken: string;
  host: string;
  port: number;
}

const MAX_BODY_BYTES = 64 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('body terlalu besar'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function decodeSegments(pathname: string): string[] {
  return pathname
    .split('/')
    .filter((s) => s !== '')
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
}

export function createForgeServer(store: ForgeStore, opts: ForgeServerOptions): Server {
  const rest = new RestHandlers(store);
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const requestId = store.nextRequestId();
    const sendJson = (status: number, body: unknown, extra?: Record<string, string>) => {
      const text = body === null || body === undefined ? '' : JSON.stringify(body);
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'x-github-request-id': requestId,
        ...(extra ?? {}),
      });
      res.end(text);
    };
    const sendRaw = (status: number, contentType: string, body: Buffer, extra?: Record<string, string>) => {
      res.writeHead(status, {
        'content-type': contentType,
        'x-github-request-id': requestId,
        ...(extra ?? {}),
      });
      res.end(body);
    };

    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const method = (req.method ?? 'GET').toUpperCase();
      const segments = decodeSegments(url.pathname);

      // Healthz tanpa auth.
      if (url.pathname === '/healthz' && method === 'GET') {
        sendJson(200, { ok: true });
        return;
      }

      // Auth bearer untuk semua permukaan lain (kecuali token kosong).
      if (opts.shopToken !== '') {
        const auth = req.headers.authorization ?? '';
        if (auth !== `Bearer ${opts.shopToken}`) {
          sendJson(401, { message: 'Unauthorized' });
          return;
        }
      }

      const body = await readBody(req);

      // -- REST v3 ---------------------------------------------------------
      if (segments[0] === 'api' && segments[1] === 'v3') {
        const restSegments = segments.slice(2);
        let parsed: unknown = {};
        if (body.length > 0) {
          const contentType = req.headers['content-type'] ?? '';
          if (contentType.includes('application/json') || contentType === '') {
            try {
              parsed = JSON.parse(body.toString('utf8'));
            } catch {
              sendJson(400, { message: 'Invalid JSON body' });
              return;
            }
          }
        }
        const baseUrl = `http://${req.headers.host ?? 'localhost'}${url.pathname}`;
        const outcome = rest.route(method, restSegments, url.searchParams, parsed, baseUrl);
        sendJson(outcome.status, outcome.body, outcome.headers);
        return;
      }

      // -- GraphQL ---------------------------------------------------------
      if (segments[0] === 'api' && segments[1] === 'graphql' && method === 'POST') {
        let parsed: unknown;
        try {
          parsed = JSON.parse(body.toString('utf8'));
        } catch {
          sendJson(400, { data: null, errors: [{ message: 'Invalid JSON body' }] });
          return;
        }
        const result = executeGraphQL(store, parsed);
        sendJson(200, result);
        return;
      }

      // -- MCP --------------------------------------------------------------
      if (segments[0] === 'mcp' && method === 'POST') {
        const result = handleMcp(store, body);
        res.writeHead(result.status, {
          'content-type': 'application/json; charset=utf-8',
          'x-github-request-id': requestId,
        });
        res.end(result.body);
        return;
      }

      // -- Git smart HTTP ----------------------------------------------------
      if (segments.length >= 2 && segments[1].endsWith('.git')) {
        const owner = segments[0];
        const repoName = segments[1].slice(0, -4);
        const repo = store.getRepo(owner, repoName);
        if (repo === undefined) {
          sendJson(404, { message: 'Repository not found' });
          return;
        }
        const gitPath = segments.slice(2).join('/');
        const protoV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
        if (gitPath === 'info/refs' && method === 'GET') {
          const service = url.searchParams.get('service');
          if (service === 'git-upload-pack') {
            const out: GitResponse = infoRefsUpload(repo, protoV2);
            sendRaw(out.status, out.contentType, out.body);
            return;
          }
          if (service === 'git-receive-pack') {
            const out: GitResponse = infoRefsReceive(repo);
            sendRaw(out.status, out.contentType, out.body);
            return;
          }
          sendJson(400, { message: 'service wajib git-upload-pack atau git-receive-pack' });
          return;
        }
        if (gitPath === 'git-upload-pack' && method === 'POST') {
          try {
            // Permintaan ls-refs vs fetch dibedakan dari baris perintah.
            const firstLine = body.toString('utf8', 0, Math.min(body.length, 64));
            const out: GitResponse = firstLine.includes('command=ls-refs')
              ? handleLsRefs(repo, body)
              : handleUploadPack(repo, body, protoV2);
            sendRaw(out.status, out.contentType, out.body);
          } catch (err) {
            sendJson(400, { message: err instanceof Error ? err.message : 'git-upload-pack gagal' });
          }
          return;
        }
        if (gitPath === 'git-receive-pack' && method === 'POST') {
          try {
            const out: GitResponse = handleReceivePack(repo, body);
            sendRaw(out.status, out.contentType, out.body);
          } catch (err) {
            sendJson(400, { message: err instanceof Error ? err.message : 'git-receive-pack gagal' });
          }
          return;
        }
        sendJson(404, { message: 'Not Found' });
        return;
      }

      sendJson(404, { message: 'Not Found' });
    } catch (err) {
      console.error('app: error tidak tertangani', err);
      if (!res.headersSent) {
        sendJson(500, { message: 'Internal server error' });
      }
    }
  });
  return server;
}
