/**
 * Watching the user's folders.
 *
 * Without this, indexing had to be launched by hand every time something was
 * copied to the archive folder. The watcher picks up additions, changes and
 * removals while the server is running, so a new document appears in the
 * application seconds after being dropped in the folder.
 *
 * It is still read-only: observing a directory does not modify it.
 *
 * File system notifications cannot be trusted on a network share — and a NAS
 * is typically used over SMB from other machines — so a full sweep is also
 * run periodically. Watching gives immediacy; the sweep gives the guarantee
 * that nothing is left out.
 */

import { watch, type FSWatcher } from 'chokidar';
import { join, relative } from 'node:path';
import type { DB } from '../server/db.js';
import { inTransaction } from '../server/db.js';
import { index, indexOne, markMissing } from './indexer.js';
import { extractText } from './extract-text.js';
import { inSkippedFolder } from './filename-parser.js';

export interface WatcherOptions {
  root: string;
  thumbnailDir: string;
  /** Minutes between full sweeps. 0 disables them. */
  sweepMinutes?: number;
  /** Also extract the text of new documents. */
  withText?: boolean;
  log?: (message: string) => void;
}

export interface WatcherState {
  active: boolean;
  pending: number;
  processed: number;
  lastChange: string | null;
  lastSweep: string | null;
  sweeping: boolean;
}

/** Wait before processing a file: a long copy notifies several times. */
const SETTLE_MS = 2500;

export class Watcher {
  private watcher: FSWatcher | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;
  /** Notified files, each with its settle timer. */
  private queue = new Map<string, NodeJS.Timeout>();

  readonly state: WatcherState = {
    active: false,
    pending: 0,
    processed: 0,
    lastChange: null,
    lastSweep: null,
    sweeping: false,
  };

  constructor(
    private readonly db: DB,
    private readonly op: WatcherOptions,
  ) {}

  private log(message: string): void {
    this.op.log?.(message);
  }

  start(): void {
    if (this.watcher) return;

    this.watcher = watch(this.op.root, {
      // Does not report what already exists at start-up: the sweep handles
      // that.
      ignoreInitial: true,
      // Wait until the file stops growing. Copying a 6 MB image to a NAS over
      // the network is not instantaneous, and processing it half-written
      // would give the wrong hash.
      awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 300 },
      // The same folders the indexer skips. Without #snapshot, chokidar walked
      // every Synology snapshot and exhausted the system's file watchers
      // (ENOSPC).
      ignored: (path) => inSkippedFolder(relative(this.op.root, path)),
      // On a network share system notifications do not always arrive; polling
      // is more expensive but reliable. Enabled only when needed.
      usePolling: process.env.REGESTA_POLLING === '1',
      interval: 30_000,
    });

    this.watcher
      .on('add', (path) => this.enqueue(path))
      .on('change', (path) => this.enqueue(path))
      .on('unlink', (path) => {
        markMissing(this.db, this.op.root, path);
        this.state.lastChange = new Date().toISOString();
        this.log(`gone: ${path}`);
      })
      .on('error', (e) => {
        // With no watchers left, carrying on only fills the log with one line
        // per file. Watching stops and the periodic sweep takes over.
        if ((e as NodeJS.ErrnoException).code === 'ENOSPC') {
          if (!this.watcher) return;
          this.log(
            'the system allows no more file watchers (ENOSPC); watching stops and ' +
              'changes will be picked up by the periodic sweep',
          );
          void this.watcher.close();
          this.watcher = null;
          this.state.active = false;
          return;
        }
        this.log(`watch error: ${String(e)}`);
      });

    this.state.active = true;
    this.log(`watching ${this.op.root}`);

    const minutes = this.op.sweepMinutes ?? 360;
    if (minutes > 0) {
      this.sweepTimer = setInterval(() => void this.sweep(), minutes * 60_000);
      // This timer must not keep the process alive.
      this.sweepTimer.unref?.();
    }
  }

  /**
   * Notes a file down to be processed once it stops moving. If several
   * notifications arrive for the same file, only the last one counts.
   */
  private enqueue(path: string): void {
    clearTimeout(this.queue.get(path));
    this.queue.set(
      path,
      setTimeout(() => {
        this.queue.delete(path);
        void this.process(path);
      }, SETTLE_MS),
    );
    this.state.pending = this.queue.size;
  }

  private async process(path: string): Promise<void> {
    try {
      const id = await indexOne(this.db, this.op.root, path, this.op.thumbnailDir);
      if (id === null) return;

      if (this.op.withText !== false) await this.extract(id, path);

      this.state.processed++;
      this.state.lastChange = new Date().toISOString();
      this.log(`indexed: ${path}`);
    } catch (e) {
      this.log(`could not index ${path}: ${String(e)}`);
    } finally {
      this.state.pending = this.queue.size;
    }
  }

  /** Extracts the text of the freshly indexed document, if it has any. */
  private async extract(id: number, path: string): Promise<void> {
    const doc = this.db
      .prepare('SELECT extension, hash FROM document WHERE id = ?')
      .get(id) as { extension: string | null; hash: string } | undefined;
    if (!doc?.extension) return;

    const already = this.db
      .prepare('SELECT hash FROM document_text WHERE document_id = ?')
      .get(id) as { hash: string } | undefined;
    if (already?.hash === doc.hash) return;

    const r = await extractText(path, doc.extension);
    if (!r) return;

    inTransaction(this.db, () => {
      this.db.prepare('DELETE FROM document_text WHERE document_id = ?').run(id);
      this.db
        .prepare(
          `INSERT INTO document_text (document_id, text, characters, pages, no_text_layer, hash)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(id, r.text, r.text.length, r.pages, r.noTextLayer ? 1 : 0, doc.hash);

      this.db.prepare('DELETE FROM document_search WHERE document_id = ?').run(id);
      if (!r.noTextLayer) {
        this.db
          .prepare('INSERT INTO document_search (text, document_id) VALUES (?, ?)')
          .run(r.text, id);
      }
    });
  }

  /**
   * Full sweep of the folder. It picks up whatever watching may have missed:
   * notifications that never arrive over the network, changes made while the
   * server was stopped, files moved between folders.
   */
  async sweep(): Promise<void> {
    if (this.state.sweeping) return;
    this.state.sweeping = true;
    this.log('full sweep');

    try {
      const r = await index(this.db, {
        root: this.op.root,
        thumbnailDir: this.op.thumbnailDir,
      });
      this.state.lastSweep = new Date().toISOString();
      if (r.added || r.updated || r.missing) {
        this.log(`sweep: ${r.added} added, ${r.updated} updated, ${r.missing} missing`);
      }
    } catch (e) {
      this.log(`the sweep failed: ${String(e)}`);
    } finally {
      this.state.sweeping = false;
    }
  }

  /**
   * Switches to watching another folder, without restarting the server.
   *
   * Used when the user changes the indexed folder from the interface: the
   * natural thing is for watching to follow the new folder straight away.
   */
  async changeRoot(next: string): Promise<void> {
    if (next === this.op.root) return;

    await this.stop();
    this.op.root = next;
    this.start();

    // The sweep is awaited before treating the change as done: fired without
    // waiting, it could overlap with the flagging of missing files and leave
    // the new folder's counts half finished.
    await this.sweep();
  }

  async stop(): Promise<void> {
    for (const t of this.queue.values()) clearTimeout(t);
    this.queue.clear();
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    await this.watcher?.close();
    this.watcher = null;
    this.state.active = false;
  }
}

/** Absolute path of a document inside the indexed root. */
export function pathOf(root: string, relativePath: string): string {
  return join(root, relativePath);
}
