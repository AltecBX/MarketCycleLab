/**
 * Owner workspace: watchlist, positions, notes, journal, settings.
 *
 * The store is revisioned. Every write names the revision it was based on and is rejected when
 * another client wrote first, so two browsers cannot silently overwrite each other.
 * This file holds the browser-local implementation used in fixture and offline mode. It is
 * labeled in the UI as stored in this browser only. The server store uses the same interface.
 */
import { useCallback, useSyncExternalStore } from 'react';

export interface WorkspacePosition {
  symbol: string;
  shares: number;
  /** Per-share cost. Null when unknown. Never assumed. */
  cost: number | null;
  acquiredOn: string | null;
  source: 'manual' | 'csv' | 'import' | 'demo';
  note?: string;
}

export interface JournalEntry {
  id: string;
  createdAt: string;
  symbol: string | null;
  kind: 'note' | 'observation' | 'forecast' | 'outcome' | 'correction' | 'import-receipt' | 'alert-ack';
  text: string;
  /** Frozen payload for forecasts and receipts. Never edited. Corrections link through `supersedes`. */
  payload?: unknown;
  supersedes?: string;
}

export interface Workspace {
  revision: number;
  updatedAt: string;
  watchlist: string[];
  positions: WorkspacePosition[];
  archivedPositions: (WorkspacePosition & { archivedAt: string; reason: string })[];
  journal: JournalEntry[];
  notes: Record<string, string>;
  alertsAcknowledged: string[];
  settings: {
    theme: 'system' | 'light' | 'dark';
    capFloorB: number;
    lossBudget: number | null;
    alertRules: { earningsDays: number; downSession: number; drawdown: number; ma200Breach: boolean };
    weather: { enabled: boolean; city: string | null };
  };
}

export const DEFAULT_WORKSPACE: Workspace = {
  revision: 0,
  updatedAt: '',
  watchlist: ['NVDA', 'MU', 'SNDK', 'INTC', 'LLY', 'AAOI', 'SPY'],
  positions: [],
  archivedPositions: [],
  journal: [],
  notes: {},
  alertsAcknowledged: [],
  settings: {
    theme: 'system',
    capFloorB: 2,
    lossBudget: null,
    alertRules: { earningsDays: 7, downSession: 0.05, drawdown: 0.2, ma200Breach: true },
    weather: { enabled: false, city: null },
  },
};

export type PutResult = { ok: true; workspace: Workspace } | { ok: false; conflict: Workspace };

export interface WorkspaceStore {
  get(): Workspace;
  /** Compare-and-swap write. Fails with the current server copy when the base revision is stale. */
  put(next: Omit<Workspace, 'revision' | 'updatedAt'>, baseRevision: number): PutResult;
  subscribe(l: () => void): () => void;
  readonly scope: 'this-browser' | 'owner-account';
}

const KEY = 'mcl.workspace.v1';

const read = (): Workspace => {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (!raw) return DEFAULT_WORKSPACE;
    const parsed = JSON.parse(raw) as Partial<Workspace>;
    return { ...DEFAULT_WORKSPACE, ...parsed, settings: { ...DEFAULT_WORKSPACE.settings, ...(parsed.settings ?? {}) } };
  } catch {
    return DEFAULT_WORKSPACE;
  }
};

class LocalStore implements WorkspaceStore {
  readonly scope = 'this-browser' as const;
  private current = read();
  private listeners = new Set<() => void>();

  constructor() {
    // Another tab wrote: adopt its copy so this tab's next write detects the newer revision.
    globalThis.addEventListener?.('storage', (e: StorageEvent) => {
      if (e.key === KEY) {
        this.current = read();
        this.listeners.forEach((l) => l());
      }
    });
  }

  get(): Workspace {
    return this.current;
  }

  put(next: Omit<Workspace, 'revision' | 'updatedAt'>, baseRevision: number): PutResult {
    const latest = read();
    if (latest.revision !== baseRevision) {
      this.current = latest;
      this.listeners.forEach((l) => l());
      return { ok: false, conflict: latest };
    }
    const ws: Workspace = { ...next, revision: baseRevision + 1, updatedAt: new Date().toISOString() };
    try {
      globalThis.localStorage?.setItem(KEY, JSON.stringify(ws));
    } catch {
      /* storage unavailable: keep the in-memory copy for this session */
    }
    this.current = ws;
    this.listeners.forEach((l) => l());
    return { ok: true, workspace: ws };
  }

  subscribe(l: () => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}

const store: WorkspaceStore = new LocalStore();
export const getWorkspaceStore = (): WorkspaceStore => store;

/** Read the workspace and get an updater. The updater returns false on a revision conflict. */
export function useWorkspace(): [Workspace, (mutate: (w: Workspace) => Omit<Workspace, 'revision' | 'updatedAt'>) => boolean] {
  const ws = useSyncExternalStore(
    (l) => store.subscribe(l),
    () => store.get(),
  );
  const update = useCallback((mutate: (w: Workspace) => Omit<Workspace, 'revision' | 'updatedAt'>) => {
    const base = store.get();
    return store.put(mutate(base), base.revision).ok;
  }, []);
  return [ws, update];
}

export const newId = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
