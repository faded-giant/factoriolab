import {
  computed,
  effect,
  inject,
  Service,
  signal,
  untracked,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router } from '@angular/router';
import { filter, map } from 'rxjs';

import { Option } from '~/option/option';
import { BuildMeta } from '~/state/preferences/build-meta';
import { PreferencesStore } from '~/state/preferences/preferences-store';
import { RouterSync } from '~/state/router/router-sync';
import { SettingsStore } from '~/state/settings/settings-store';

export interface LibraryBuild {
  name: string;
  query: string;
  meta: BuildMeta;
}

export interface LibraryFolder {
  /** Empty string for builds without a folder */
  folder: string;
  builds: LibraryBuild[];
}

export interface ActiveBuild {
  modId: string;
  name: string;
}

function currentQuery(): string {
  return window.location.search.substring(1);
}

/** Mod id from a router url like `/spa/list?z=...` */
function urlModId(url: string): string | undefined {
  return url.split('?')[0].split('/')[1] || undefined;
}

function sameBuild(a: ActiveBuild | null, b: ActiveBuild | null): boolean {
  return a?.modId === b?.modId && a?.name === b?.name;
}

const AUTOSAVE_MS = 800;

/** Saved states for the current mod, organized as a library of builds */
@Service()
export class Library {
  private readonly router = inject(Router);
  private readonly preferencesStore = inject(PreferencesStore);
  private readonly routerSync = inject(RouterSync);
  private readonly settingsStore = inject(SettingsStore);

  /** The current URL state, comparable to saved state values */
  readonly query = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map(currentQuery),
    ),
    { initialValue: currentQuery() },
  );

  /** Mod id taken from the URL itself, in step with `query` */
  private readonly urlModId = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map((e) => urlModId(e.urlAfterRedirects)),
    ),
    { initialValue: urlModId(this.router.url) },
  );

  /** The saved build that edits are autosaved into, if any */
  readonly active = signal<ActiveBuild | null>(null);

  private autosave: ReturnType<typeof setTimeout> | undefined;
  private pending: (() => void) | undefined;

  constructor() {
    // Opening or saving a build makes it the autosave target
    effect(() => {
      const name = this.current();
      const modId = this.settingsStore.modId();
      const next = name && modId ? { modId, name } : null;
      if (next && !sameBuild(next, untracked(this.active)))
        this.active.set(next);
    });

    // Write every change to the URL state back into the active build
    effect(() => {
      const query = this.query();
      const modId = this.urlModId();
      const active = this.active();
      const enabled = this.preferencesStore.autosave();
      this.cancelAutosave();
      if (!active) return;

      // Reset, switching game, or deleting the build ends autosave
      const saved = this.preferencesStore.states()[active.modId]?.[active.name];
      if (!query || modId !== active.modId || saved == null) {
        this.active.set(null);
        return;
      }

      if (!enabled || saved === query) return;
      const pending = (): void => {
        this.pending = undefined;
        if (!sameBuild(this.active(), active) || this.query() !== query) return;
        this.preferencesStore.saveState(active.modId, active.name, query);
      };
      this.pending = pending;
      this.autosave = setTimeout(pending, AUTOSAVE_MS);
    });
  }

  /** Stops autosaving into the active build; the current state is kept */
  detach(): void {
    this.cancelAutosave();
    this.active.set(null);
  }

  /** Saves a pending autosave right away, e.g. before switching builds */
  flush(): void {
    const pending = this.pending;
    this.cancelAutosave();
    pending?.();
  }

  private cancelAutosave(): void {
    clearTimeout(this.autosave);
    this.autosave = undefined;
    this.pending = undefined;
  }

  readonly builds = computed((): LibraryBuild[] => {
    const modId = this.settingsStore.modId();
    const states = this.settingsStore.modStates();
    const meta: Record<string, BuildMeta> =
      (modId && this.preferencesStore.buildMeta()[modId]) || {};
    return Object.keys(states)
      .map((name) => ({ name, query: states[name], meta: meta[name] ?? {} }))
      .sort(
        (a, b) =>
          (a.meta.folder ?? '').localeCompare(b.meta.folder ?? '') ||
          a.name.localeCompare(b.name),
      );
  });

  readonly folders = computed((): LibraryFolder[] => {
    const folders: LibraryFolder[] = [];
    for (const build of this.builds()) {
      const folder = build.meta.folder ?? '';
      let last = folders[folders.length - 1];
      if (last?.folder !== folder) {
        last = { folder, builds: [] };
        folders.push(last);
      }
      last.builds.push(build);
    }
    // Unfiled builds last
    return folders.sort((a, b) => (a.folder ? 0 : 1) - (b.folder ? 0 : 1));
  });

  readonly folderNames = computed(() =>
    this.folders()
      .map((f) => f.folder)
      .filter((f) => f),
  );

  /** Name of the saved build matching the current URL, if any */
  readonly current = computed(() => {
    const query = this.query();
    return this.builds().find((b) => b.query === query)?.name;
  });

  readonly options = computed(() =>
    this.builds().map(
      (b): Option => ({
        label: b.meta.folder ? `${b.meta.folder} › ${b.name}` : b.name,
        value: b.name,
      }),
    ),
  );

  async open(name: string): Promise<void> {
    const build = this.builds().find((b) => b.name === name);
    if (!build) return;
    await this.router.navigate([], {
      queryParams: this.routerSync.toParams(build.query),
    });
  }

  /** Saves the current URL state under a name */
  saveCurrent(name: string, folder?: string): void {
    const modId = this.settingsStore.modId();
    if (!modId || !name) return;
    this.preferencesStore.saveState(modId, name, this.query());
    if (folder != null)
      this.preferencesStore.updateBuildMeta(modId, name, {
        folder: folder || undefined,
      });
  }

  /** Updates a build's details, renaming it if `name` changed */
  update(from: string, name: string, meta: BuildMeta): void {
    const modId = this.settingsStore.modId();
    if (!modId || !name) return;
    this.rename(from, name);
    this.preferencesStore.updateBuildMeta(modId, name, meta);
  }

  /** Renames a build, and keeps autosaving into it if it is open */
  rename(from: string, to: string): void {
    const modId = this.settingsStore.modId();
    if (!modId || !to) return;
    this.preferencesStore.renameState(modId, from, to);
    const active = this.active();
    if (active?.modId === modId && active.name === from)
      this.active.set({ modId, name: to });
  }

  remove(name: string): void {
    const modId = this.settingsStore.modId();
    if (!modId) return;
    this.preferencesStore.removeState(modId, name);
  }
}
