import { computed, inject, Service } from '@angular/core';
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

function currentQuery(): string {
  return window.location.search.substring(1);
}

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
      filter((e) => e instanceof NavigationEnd),
      map(currentQuery),
    ),
    { initialValue: currentQuery() },
  );

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
    this.preferencesStore.renameState(modId, from, name);
    this.preferencesStore.updateBuildMeta(modId, name, meta);
  }

  remove(name: string): void {
    const modId = this.settingsStore.modId();
    if (!modId) return;
    this.preferencesStore.removeState(modId, name);
  }
}
