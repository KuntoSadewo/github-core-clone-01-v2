// main.ts — entrypoint forge.
//
// Siklus hidup trial:
//   1. Bind port ephemeral (0.0.0.0:0) dan layani request.
//   2. Bila MAKEFUN_ENV_URL diset: POST {"port": N} ke $ENV/register
//      (diulang sampai 18 dtk), lalu long-poll GET $ENV/done tiap 1 dtk
//      sampai {"done": true}, lalu tutup server dan keluar 0.
//   3. Bila MAKEFUN_ENV_URL tidak diset: layani selamanya (uji lokal).
//
// Token shop dibaca dari MAKEFUN_SHOP_TOKEN; bila kosong, auth dilewati.

import { createForgeServer } from './app.ts';
import { ForgeStore } from './store.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/$/, '');
const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const PORT = process.env.PORT !== undefined && process.env.PORT !== '' ? Number(process.env.PORT) : 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postJson(url: string, payload: unknown, timeoutMs: number): Promise<{ status: number; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await res.text();
    return { status: res.status, text };
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(url: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  // Jaring pengaman global: satu handler yang lolos tidak boleh mematikan
  // proses di tengah trial — catat dan terus layani.
  process.on('uncaughtException', (err) => {
    console.error('main: uncaughtException (tetap layani)', err);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('main: unhandledRejection (tetap layani)', reason);
  });

  const store = new ForgeStore();
  const server = createForgeServer(store, { shopToken: SHOP_TOKEN, host: '0.0.0.0', port: PORT });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, '0.0.0.0', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : PORT;
  console.log(`pocket-forge listening on 0.0.0.0:${port}`);

  let shuttingDown = false;
  // Lacak koneksi terbuka supaya shutdown tidak tertahan keep-alive.
  const liveSockets = new Set<import('node:net').Socket>();
  server.on('connection', (socket) => {
    liveSockets.add(socket);
    socket.on('close', () => liveSockets.delete(socket));
  });
  const shutdown = (code: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const socket of liveSockets) socket.destroy();
    server.close(() => process.exit(code));
    setTimeout(() => process.exit(code), 2000).unref();
  };
  process.on('SIGTERM', () => shutdown(0));
  process.on('SIGINT', () => shutdown(0));

  if (ENV_URL === '') {
    // Mode mandiri: layani selamanya sampai sinyal.
    return;
  }

  // Mode trial: register, lalu poll done.
  const registerUrl = `${ENV_URL}/register`;
  const doneUrl = `${ENV_URL}/done`;
  let registered = false;
  const deadline = Date.now() + 18000;
  while (Date.now() < deadline) {
    try {
      const res = await postJson(registerUrl, { port }, 2000);
      if (res.status === 200) {
        registered = true;
        break;
      }
      console.error(`register ditolak: ${res.status} ${res.text}`);
    } catch (err) {
      console.error('register gagal, coba lagi:', err instanceof Error ? err.message : String(err));
    }
    await sleep(500);
  }
  if (!registered) {
    console.error('register gagal setelah 18 dtk');
    shutdown(1);
    return;
  }
  console.log('registered, menunggu done...');

  while (true) {
    try {
      const data = (await getJson(doneUrl, 5000)) as Record<string, unknown>;
      if (data !== null && data.done === true) break;
    } catch {
      // Env belum siap / jaringan putus sesaat: coba lagi.
    }
    await sleep(1000);
  }
  console.log('done, menutup server');
  shutdown(0);
}

main().catch((err) => {
  console.error('main: fatal', err);
  process.exit(1);
});
