/**
 * Owner workspace repository. Writes are compare-and-swap on a revision so two clients cannot
 * silently overwrite each other. Captures are append-only.
 */

export interface StoredWorkspace {
  revision: number;
  updatedAt: string;
  /** Opaque owner document. Validated for shape and size before it reaches the repository. */
  data: unknown;
}

export type PutOutcome = { ok: true; stored: StoredWorkspace } | { ok: false; current: StoredWorkspace | null };

export interface MonitorRow {
  type: 'alert' | 'forecast' | 'source-health';
  key: string;
  at: string;
  payload: unknown;
}

export interface WorkspaceRepo {
  get(owner: string): Promise<StoredWorkspace | null>;
  /** `baseRevision` 0 creates the document. Any other value must equal the stored revision. */
  put(owner: string, data: unknown, baseRevision: number, now: string): Promise<PutOutcome>;
  /** Append a monitor row. A row with an existing key is ignored, so reruns never duplicate. */
  appendMonitor(owner: string, row: MonitorRow): Promise<{ inserted: boolean }>;
  listMonitor(owner: string): Promise<MonitorRow[]>;
}

/** In-memory repository for tests and local development. A deployment swaps in a durable one. */
export class MemoryRepo implements WorkspaceRepo {
  private docs = new Map<string, StoredWorkspace>();
  private rows = new Map<string, Map<string, MonitorRow>>();

  async get(owner: string): Promise<StoredWorkspace | null> {
    return this.docs.get(owner) ?? null;
  }

  async put(owner: string, data: unknown, baseRevision: number, now: string): Promise<PutOutcome> {
    const current = this.docs.get(owner) ?? null;
    const currentRev = current?.revision ?? 0;
    if (baseRevision !== currentRev) return { ok: false, current };
    const stored: StoredWorkspace = { revision: currentRev + 1, updatedAt: now, data };
    this.docs.set(owner, stored);
    return { ok: true, stored };
  }

  async appendMonitor(owner: string, row: MonitorRow): Promise<{ inserted: boolean }> {
    let m = this.rows.get(owner);
    if (!m) {
      m = new Map();
      this.rows.set(owner, m);
    }
    const k = `${row.type}:${row.key}`;
    if (m.has(k)) return { inserted: false };
    m.set(k, row);
    return { inserted: true };
  }

  async listMonitor(owner: string): Promise<MonitorRow[]> {
    return [...(this.rows.get(owner)?.values() ?? [])];
  }
}
