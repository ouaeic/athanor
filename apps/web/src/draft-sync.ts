import type { Draft } from './model';

export interface DraftWrite {
  draft: Draft;
  key: string;
  expectedRevision: number;
}
export interface DraftRecovery {
  id: string;
  version: string;
  revision: number;
  updatedAt: number;
  head?: DraftWrite;
  latest?: Draft;
  submission?: { signature: string; key: string; draft: Draft };
  sources?: Array<{ id: string; version: string }>;
}
export interface DraftStorage {
  save(record: DraftRecovery): Promise<void>;
  remove(id: string, version?: string): Promise<void>;
}
export class DraftConflict extends Error {
  constructor(readonly server: Draft) {
    super('A newer draft exists. Choose which version to keep.');
  }
}
class DraftStorageFailure extends Error {
  constructor(cause: unknown) {
    super(`Draft storage failed: ${cause instanceof Error ? cause.message : 'unknown error'}`, {
      cause
    });
  }
}
export type DraftSyncStatus =
  | 'saving'
  | 'device'
  | 'synced'
  | 'conflict'
  | 'unsaved'
  | 'pending_delivery';
interface DraftSyncOptions {
  draft: Draft;
  recovery?: DraftRecovery | undefined;
  storage: DraftStorage;
  write(input: DraftWrite): Promise<{ revision: number; updatedAt: string }>;
  onStatus(status: DraftSyncStatus, error?: unknown): void;
  onSynced(draft: Draft): void;
}

/** Persist the unanswered request separately from edits made while its outcome is unknown. */
export class DraftSync {
  private record: DraftRecovery;
  private persistence = Promise.resolve();
  private running: Promise<void> | null = null;
  private conflict: DraftConflict | null = null;
  private sourceRemoved = false;
  private paused = false;

  constructor(private readonly options: DraftSyncOptions) {
    const prior = options.recovery;
    this.record = prior
      ? {
          ...structuredClone(prior),
          id: crypto.randomUUID(),
          version: crypto.randomUUID(),
          sources: [...(prior.sources ?? []), { id: prior.id, version: prior.version }]
        }
      : {
          id: crypto.randomUUID(),
          version: crypto.randomUUID(),
          revision: options.draft.revision ?? 0,
          updatedAt: Date.now()
        };
  }
  get pendingSubmission(): Readonly<NonNullable<DraftRecovery['submission']>> | null {
    return this.record.submission ?? null;
  }
  get serverConflict(): Draft | null {
    return this.conflict?.server ?? null;
  }
  get recoveredDraft(): Draft | null {
    return this.record.submission?.draft ?? this.record.latest ?? this.record.head?.draft ?? null;
  }
  private persist(): Promise<void> {
    this.record.version = crypto.randomUUID();
    this.record.updatedAt = Date.now();
    const snapshot = structuredClone(this.record);
    const next = this.persistence
      .catch(() => undefined)
      .then(() =>
        snapshot.head || snapshot.latest || snapshot.submission
          ? this.options.storage.save(snapshot)
          : this.options.storage.remove(snapshot.id)
      )
      .catch((cause: unknown) => {
        throw new DraftStorageFailure(cause);
      });
    this.persistence = next;
    return next;
  }
  async stage(draft: Draft): Promise<void> {
    this.record.latest = structuredClone(draft);
    this.options.onStatus('saving');
    try {
      await this.persist();
    } catch (error) {
      this.options.onStatus('unsaved', error);
      throw error;
    }
    this.options.onStatus(this.conflict ? 'conflict' : 'device', this.conflict);
  }
  async save(draft: Draft): Promise<void> {
    await this.stage(draft);
    return this.flush();
  }
  async prepareSubmission(signature: string, draft: Draft): Promise<string> {
    if (this.record.submission && this.record.submission.signature !== signature)
      throw new Error('Recover the previous send before starting another.');
    if (!this.record.submission)
      this.record.submission = {
        signature,
        draft: structuredClone(draft),
        key: crypto.randomUUID()
      };
    await this.persist();
    return this.record.submission.key;
  }
  async abandonSubmission(): Promise<void> {
    if (!this.record.submission) return;
    this.record.latest ??= this.record.submission.draft;
    delete this.record.submission;
    await this.persist();
    for (const source of this.record.sources ?? [])
      await this.options.storage.remove(source.id, source.version);
    this.sourceRemoved = true;
  }
  async finishSubmission(draft: Draft): Promise<void> {
    await this.save(draft);
    delete this.record.submission;
    await this.persist();
  }
  flush(): Promise<void> {
    if (this.paused) return Promise.reject(new Error('Draft synchronization is paused.'));
    if (this.conflict) return Promise.reject(this.conflict);
    if (this.running) return this.running;
    const run = this.pump();
    this.running = run;
    void run
      .finally(() => {
        if (this.running === run) this.running = null;
      })
      .catch(() => undefined);
    return run;
  }
  private async pump(): Promise<void> {
    try {
      await this.persistence;
      while (!this.paused && (this.record.head || this.record.latest)) {
        if (!this.record.head) {
          this.record.head = {
            draft: this.record.latest!,
            key: crypto.randomUUID(),
            expectedRevision: this.record.revision
          };
          delete this.record.latest;
          await this.persist();
        }
        const head = this.record.head;
        const receipt = await this.options.write(head);
        this.record.revision = receipt.revision;
        delete this.record.head;
        await this.persist();
        if (!this.sourceRemoved && this.record.sources) {
          for (const source of this.record.sources)
            await this.options.storage.remove(source.id, source.version);
          this.sourceRemoved = true;
        }
        this.options.onSynced({ ...head.draft, ...receipt });
      }
      if (!this.paused)
        this.options.onStatus(this.record.submission ? 'pending_delivery' : 'synced');
    } catch (error) {
      if (error instanceof DraftConflict) {
        this.conflict = error;
        this.options.onStatus('conflict', error);
      } else
        this.options.onStatus(error instanceof DraftStorageFailure ? 'unsaved' : 'device', error);
      throw error;
    }
  }
  async resolve(choice: 'device' | 'server'): Promise<Draft> {
    const server = this.conflict?.server;
    if (!server) throw new Error('There is no draft conflict to resolve.');
    const draft = choice === 'server' ? server : (this.record.latest ?? this.record.head?.draft);
    if (!draft) throw new Error('The local draft is unavailable.');
    this.conflict = null;
    delete this.record.head;
    delete this.record.latest;
    this.record.revision = server.revision ?? 0;
    if (choice === 'device') this.record.latest = draft;
    await this.persist();
    if (choice === 'device') await this.flush();
    else {
      for (const source of this.record.sources ?? [])
        await this.options.storage.remove(source.id, source.version);
      this.options.onSynced(server);
      this.options.onStatus('synced');
    }
    return { ...draft, revision: this.record.revision };
  }
  pause(): void {
    this.paused = true;
  }
}
