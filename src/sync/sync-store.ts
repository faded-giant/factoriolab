import { computed, effect, inject, Service, signal } from '@angular/core';

import { PreferencesStore } from '~/state/preferences/preferences-store';
import {
  initialPreferencesState,
  PreferencesState,
} from '~/state/preferences/preferences-state';
import { spread } from '~/utils/object';
import { getStoredValue, storedSignal, storeValue } from '~/utils/stored-signal';

import { GitHubClient, GitHubConfig, GitHubError } from './github-client';

export type SyncStatus = 'off' | 'idle' | 'syncing' | 'error';

/** Contents of a build file in the sync repo */
export interface BuildFile {
  name: string;
  modId: string;
  query: string;
}

/** Path -> file contents */
type Files = Record<string, string>;

/** What each file looked like the last time this browser synced it */
type SyncBase = Record<string, { sha: string; content: string }>;

const BUILDS_DIR = 'builds/';
const PREFERENCES_FILE = 'preferences.json';
const DEBOUNCE_MS = 3000;
const FOCUS_THROTTLE_MS = 10000;

/** Escapes only characters that are unsafe in file names, keeping it readable */
export function buildPath(modId: string, name: string): string {
  const safe = name
    .replace(/[%/\\:*?"<>|]/g, (c) => `%${c.charCodeAt(0).toString(16)}`)
    .replace(/^\./, '%2e');
  return `${BUILDS_DIR}${modId}/${safe}.json`;
}

function isManaged(path: string): boolean {
  return path === PREFERENCES_FILE || path.startsWith(BUILDS_DIR);
}

function toJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n';
}

/**
 * Keeps saved states and preferences in sync with a private GitHub repo, so
 * every machine signed in to the same repo sees the same builds.
 */
@Service()
export class SyncStore {
  private readonly preferencesStore = inject(PreferencesStore);

  private readonly stored = storedSignal('sync');

  readonly config = computed((): GitHubConfig | undefined => {
    const stored = this.stored();
    if (!stored) return undefined;
    try {
      return JSON.parse(stored) as GitHubConfig;
    } catch {
      return undefined;
    }
  });

  readonly status = signal<SyncStatus>(this.config() ? 'idle' : 'off');
  readonly error = signal<string | undefined>(undefined);
  readonly lastSynced = signal<Date | undefined>(undefined);

  private running: Promise<void> | undefined;
  private again = false;
  private debounce: ReturnType<typeof setTimeout> | undefined;
  private lastFocusSync = 0;

  constructor() {
    // Push local changes shortly after they happen
    effect(() => {
      const files = this.localFiles(this.preferencesStore.state());
      if (!this.config() || !this.differsFromBase(files)) return;
      clearTimeout(this.debounce);
      this.debounce = setTimeout(() => void this.sync(), DEBOUNCE_MS);
    });

    // Pull changes made on other machines when coming back to this tab
    const onFocus = (): void => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - this.lastFocusSync < FOCUS_THROTTLE_MS) return;
      this.lastFocusSync = Date.now();
      void this.sync();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    window.addEventListener('online', () => void this.sync());

    // Flush pending changes before the tab goes away
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && this.debounce) {
        clearTimeout(this.debounce);
        this.debounce = undefined;
        void this.sync();
      }
    });

    if (this.config()) void this.sync();
  }

  /** Validates the token and repo, then saves them and runs a first sync */
  async connect(config: GitHubConfig): Promise<void> {
    config = {
      owner: config.owner.trim(),
      repo: config.repo.trim(),
      token: config.token.trim(),
    };
    this.status.set('syncing');
    this.error.set(undefined);
    try {
      await new GitHubClient(config).verify();
    } catch (err) {
      this.status.set(this.config() ? 'error' : 'off');
      this.error.set(this.describe(err));
      throw err;
    }

    // A different repo has a different history, so start from scratch
    storeValue('syncBase', undefined);
    this.stored.set(JSON.stringify(config));
    await this.sync();
  }

  /** Forgets the token on this machine; local saved states are kept */
  disconnect(): void {
    clearTimeout(this.debounce);
    this.stored.set(undefined);
    storeValue('syncBase', undefined);
    this.status.set('off');
    this.error.set(undefined);
    this.lastSynced.set(undefined);
  }

  /** Runs a sync, or queues one more if a sync is already running */
  sync(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }

    this.running = (async (): Promise<void> => {
      do {
        this.again = false;
        await this.syncOnce();
      } while (this.again);
    })().finally(() => {
      this.running = undefined;
    });

    return this.running;
  }

  private async syncOnce(): Promise<void> {
    const config = this.config();
    if (!config) return;

    const client = new GitHubClient(config);
    this.status.set('syncing');

    try {
      const conflicted = await this.reconcile(client);
      // Another machine wrote between our list and our write; go again
      if (conflicted) await this.reconcile(client);
      this.status.set('idle');
      this.error.set(undefined);
      this.lastSynced.set(new Date());
    } catch (err) {
      this.status.set('error');
      this.error.set(this.describe(err));
    }
  }

  /**
   * Three-way merge of each file: the last synced version (base), this
   * browser's version (local), and GitHub's version (remote). Returns true if
   * a write was rejected because the remote changed underneath us.
   */
  private async reconcile(client: GitHubClient): Promise<boolean> {
    const tree = await client.getTree();
    const local = this.localFiles(this.preferencesStore.state());
    const base = this.readBase();

    const paths = new Set(
      [...Object.keys(local), ...Object.keys(tree), ...Object.keys(base)].filter(
        isManaged,
      ),
    );

    const upserts: BuildFile[] = [];
    const removals: BuildFile[] = [];
    let remotePreferences: string | undefined;
    let conflicted = false;

    const takeRemote = (path: string, content: string | undefined): void => {
      if (path === PREFERENCES_FILE) {
        if (content != null) remotePreferences = content;
        return;
      }

      if (content != null) upserts.push(JSON.parse(content) as BuildFile);
      else {
        const previous = base[path]?.content;
        if (previous) removals.push(JSON.parse(previous) as BuildFile);
      }
    };

    for (const path of paths) {
      const b = base[path];
      const l = local[path];
      const r = tree[path];
      const localChanged = l !== b?.content;
      const remoteChanged = r !== b?.sha;

      try {
        if (!localChanged && !remoteChanged) continue;

        if (localChanged && !remoteChanged) {
          // Only this machine changed it: push
          if (l == null) {
            if (r) await client.deleteFile(path, r, this.message('Delete', l, b));
            delete base[path];
          } else {
            const sha = await client.putFile(path, l, r, this.message('Save', l));
            base[path] = { sha, content: l };
          }
        } else if (!localChanged && remoteChanged) {
          // Only another machine changed it: pull
          const content = r ? await client.getBlob(r) : undefined;
          takeRemote(path, content);
          if (r && content != null) base[path] = { sha: r, content };
          else delete base[path];
        } else if (r == null) {
          // Deleted remotely but edited here: keep the edit
          if (l != null) {
            const sha = await client.putFile(path, l, undefined, this.message('Save', l));
            base[path] = { sha, content: l };
          } else delete base[path];
        } else {
          // Both changed
          const remote = await client.getBlob(r);
          if (l != null && remote !== l && path !== PREFERENCES_FILE) {
            // Keep both versions of a build: remote under its name, ours as a copy
            const ours = JSON.parse(l) as BuildFile;
            upserts.push({ ...ours, name: `${ours.name} (conflict ${this.today()})` });
          }

          if (l != null && b != null && path === PREFERENCES_FILE) {
            // For preferences, this machine's latest choice wins, unless this
            // machine never synced: then its defaults must not clobber yours
            const sha = await client.putFile(path, l, r, this.message('Save', l));
            base[path] = { sha, content: l };
          } else {
            takeRemote(path, remote);
            base[path] = { sha: r, content: remote };
          }
        }
      } catch (err) {
        if (err instanceof GitHubError && err.isConflict) conflicted = true;
        else {
          this.writeBase(base);
          throw err;
        }
      }
    }

    this.writeBase(base);
    this.applyRemote(upserts, removals, remotePreferences);
    return conflicted;
  }

  /** Applies remote changes on top of the current state, not the snapshot */
  private applyRemote(
    upserts: BuildFile[],
    removals: BuildFile[],
    preferences: string | undefined,
  ): void {
    if (preferences != null) {
      try {
        const { states: _states, ...initial } = initialPreferencesState;
        const remote = JSON.parse(preferences) as Partial<PreferencesState>;
        delete remote.states;
        this.preferencesStore.apply(spread(initial, remote));
      } catch {
        // Ignore an unreadable remote preferences file
      }
    }

    if (!upserts.length && !removals.length) return;

    const states = { ...this.preferencesStore.states() };
    for (const build of removals) {
      if (!states[build.modId]) continue;
      states[build.modId] = { ...states[build.modId] };
      delete states[build.modId][build.name];
    }
    for (const build of upserts)
      states[build.modId] = { ...states[build.modId], [build.name]: build.query };

    this.preferencesStore.apply({ states });
  }

  /** The files this browser's state maps to */
  private localFiles(state: PreferencesState): Files {
    const { states, ...preferences } = state;
    const files: Files = { [PREFERENCES_FILE]: toJson(preferences) };
    for (const modId of Object.keys(states))
      for (const name of Object.keys(states[modId] ?? {})) {
        const build: BuildFile = { name, modId, query: states[modId][name] };
        files[buildPath(modId, name)] = toJson(build);
      }

    return files;
  }

  private differsFromBase(files: Files): boolean {
    const base = this.readBase();
    const paths = new Set([...Object.keys(files), ...Object.keys(base)]);
    for (const path of paths) if (files[path] !== base[path]?.content) return true;
    return false;
  }

  /** Read from storage each time, so several open tabs share one base */
  private readBase(): SyncBase {
    try {
      return JSON.parse(getStoredValue('syncBase') ?? '{}') as SyncBase;
    } catch {
      return {};
    }
  }

  private writeBase(base: SyncBase): void {
    storeValue('syncBase', JSON.stringify(base));
  }

  private message(
    action: string,
    content: string | undefined,
    base?: { content: string },
  ): string {
    const raw = content ?? base?.content;
    if (raw) {
      try {
        const build = JSON.parse(raw) as Partial<BuildFile>;
        if (build.name) return `${action} ${build.name} (${build.modId})`;
      } catch {
        // Fall through
      }
    }
    return `${action} preferences`;
  }

  private today(): string {
    return new Date().toISOString().substring(0, 10);
  }

  private describe(err: unknown): string {
    if (err instanceof GitHubError) {
      if (err.status === 401) return 'Token rejected; it may be expired';
      if (err.status === 404) return 'Repo not found, or token lacks access';
      if (err.status === 403) return `GitHub refused: ${err.message}`;
      return `GitHub error ${err.status}: ${err.message}`;
    }
    if (err instanceof TypeError) return 'Offline or GitHub unreachable';
    return String(err);
  }
}
