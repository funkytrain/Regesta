/**
 * Regesta server.
 *
 * A single process: it serves the interface, the API and the documents.
 * Designed to run in a container on a home server and be consulted from any
 * machine on the local network.
 */

import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { openDb, readSetting, writeSetting } from './db.js';
import { registerApi } from './api.js';
import { Watcher } from '../indexer/watcher.js';
import { purgeSkippedFolders } from '../indexer/indexer.js';
import { GrampsReader } from './gramps.js';

const HERE = dirname(fileURLToPath(import.meta.url));

const PORT = Number.parseInt(process.env.REGESTA_PORT ?? '8080', 10);
const DB_PATH = resolve(process.env.REGESTA_DB ?? 'data/regesta.db');
const THUMBNAIL_DIR = resolve(process.env.REGESTA_THUMBNAILS ?? 'data/thumbnails');
const WEB_DIR = resolve(process.env.REGESTA_WEB ?? join(HERE, '..', 'web'));

const db = openDb(DB_PATH);
// The export writes next to the database, so it needs to know where that is.
writeSetting(db, 'db_path', DB_PATH);

const app = Fastify({
  logger: { level: process.env.REGESTA_LOG ?? 'info' },
  // Docker's healthcheck polls every 30 s; logging it is continuous writing to
  // the container log with no useful information.
  disableRequestLogging: (request) =>
    request.url === '/api/summary' &&
    ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.ip),
  // Archive scans can be large TIFFs.
  bodyLimit: 32 * 1024 * 1024,
});

// Clears out what folder watching let in from Synology snapshots before that
// was fixed. After the first run it finds nothing and costs nothing.
{
  const p = purgeSkippedFolders(db);
  if (p.deleted || p.kept || p.units) {
    app.log.info(
      `Copies from skipped folders (#snapshot…): removed ${p.deleted} documents and ` +
        `${p.units} folders; kept ${p.kept} as missing because they carry your work`,
    );
  }
}

/**
 * Watching of the indexed folder: whatever is copied into it shows up in the
 * application without running anything by hand.
 *
 * Disabled with REGESTA_WATCH=0; REGESTA_POLLING=1 forces polling, in
 * case file system notifications do not make it across the network.
 */
const documentRoot = readSetting(db, 'document_root');
const watcher =
  documentRoot && process.env.REGESTA_WATCH !== '0'
    ? new Watcher(db, {
        root: documentRoot,
        thumbnailDir: THUMBNAIL_DIR,
        sweepMinutes: Number(process.env.REGESTA_SWEEP_MIN ?? '360'),
        log: (m) => app.log.info(`[watcher] ${m}`),
      })
    : null;

/**
 * Reader for the Gramps tree. It always works on a copy inside the data
 * directory: the Gramps file itself is never opened.
 */
const gramps = new GrampsReader(join(dirname(DB_PATH), 'gramps-copy.db'));

registerApi(app, { db, thumbnailDir: THUMBNAIL_DIR, watcher, gramps });

await app.register(fastifyStatic, {
  root: WEB_DIR,
  prefix: '/',
});

// PDF.js is served from this server and not from a CDN: the application is
// meant to run on a home server and must work without an internet connection.
await app.register(fastifyStatic, {
  root: resolve('node_modules/pdfjs-dist/build'),
  prefix: '/vendor/pdfjs/',
  decorateReply: false,
});

// Any unrecognised route returns the interface: client-side navigation takes
// care of the rest.
app.setNotFoundHandler(async (request, reply) => {
  if (request.url.startsWith('/api/')) {
    return reply.code(404).send({ error: 'No such resource' });
  }
  return reply.sendFile('index.html');
});

const shutdown = async (signal: string): Promise<void> => {
  app.log.info(`Received ${signal}, shutting down`);
  await watcher?.stop();
  await app.close();
  db.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

// 0.0.0.0 so it is reachable from other machines on the local network, which
// is the point: the application lives on the server and is consulted from a
// laptop.
await app.listen({ port: PORT, host: '0.0.0.0' });
app.log.info(`Regesta on http://localhost:${PORT}`);

if (watcher) {
  watcher.start();
  // A sweep at start-up picks up whatever changed while the server was down.
  void watcher.sweep();
} else if (!documentRoot) {
  app.log.warn('No folder indexed yet: run "npm run index -- --root <folder>"');
}
