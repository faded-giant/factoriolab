import {
  createEnvironmentInjector,
  EnvironmentInjector,
  inject,
  Injectable,
  signal,
} from '@angular/core';
import { Title } from '@angular/platform-browser';
import { Router } from '@angular/router';
import { debounceTime, firstValueFrom, map, race, Subject, timer } from 'rxjs';

import { ItemsStore } from '~/state/items/items-store';
import { MachinesStore } from '~/state/machines/machines-store';
import { Normalization } from '~/state/normalization';
import { ObjectivesStore } from '~/state/objectives/objectives-store';
import { RecipesStore } from '~/state/recipes/recipes-store';
import { Migration } from '~/state/router/migration';
import { RouterSync, ZipState } from '~/state/router/router-sync';
import { SettingsStore } from '~/state/settings/settings-store';
import { TableStore } from '~/state/table/table-store';

/**
 * A RouterSync that never touches the browser URL. Instead of navigating, it
 * publishes the query string the state would have.
 */
@Injectable()
class HeadlessRouterSync extends RouterSync {
  private readonly appRouter = inject(Router);
  readonly query = signal('');
  readonly queryChanged = new Subject<void>();

  override async updateUrl(zState: ZipState): Promise<void> {
    const params = await this.getHash(zState);
    // Serialize like the router does, so queries match real URLs exactly
    const url = this.appRouter.serializeUrl(
      this.appRouter.createUrlTree(['/'], { queryParams: params }),
    );
    const index = url.indexOf('?');
    this.query.set(index === -1 ? '' : url.substring(index + 1));
    this.queryChanged.next();
  }
}

const NO_TITLE: Pick<Title, 'setTitle' | 'getTitle'> = {
  setTitle: () => undefined,
  getTitle: () => '',
};

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A second, invisible copy of the calculator state. Loads any saved build,
 * lets the caller change it, and solves it, without affecting the page.
 */
export class Headless {
  private readonly injector: EnvironmentInjector;
  private readonly routerSync: HeadlessRouterSync;
  private readonly migration: Migration;
  readonly objectivesStore: ObjectivesStore;
  readonly settingsStore: SettingsStore;

  constructor(parent: EnvironmentInjector) {
    this.injector = createEnvironmentInjector(
      [
        SettingsStore,
        ItemsStore,
        MachinesStore,
        RecipesStore,
        ObjectivesStore,
        TableStore,
        Normalization,
        HeadlessRouterSync,
        { provide: RouterSync, useExisting: HeadlessRouterSync },
        { provide: Title, useValue: NO_TITLE },
      ],
      parent,
      'Headless',
    );
    this.routerSync = this.injector.get(HeadlessRouterSync);
    this.migration = this.injector.get(Migration);
    this.objectivesStore = this.injector.get(ObjectivesStore);
    this.settingsStore = this.injector.get(SettingsStore);
  }

  /** The query string for the current state, as the URL would show it */
  get query(): string {
    return this.routerSync.query();
  }

  /** Loads a saved build's query string (empty for a fresh build) */
  async load(modId: string, query: string): Promise<void> {
    const queryParams = query ? this.routerSync.toParams(query) : {};
    const unzipped = await this.routerSync.unzipQueryParams(queryParams);
    const result = this.migration.migrate(modId, unzipped);

    this.settingsStore.apply({ modId: result.modId });
    const { modData, modHash } = await this.dataReady();

    const settled = this.settled();
    this.routerSync.updateState(
      result.modId,
      result.params,
      result.isBare,
      modData,
      modHash,
    );
    await settled;
  }

  /** Waits until the query string has caught up with changes to the stores */
  settled(): Promise<boolean> {
    return firstValueFrom(
      race(
        this.routerSync.queryChanged.pipe(
          debounceTime(200),
          map(() => true),
        ),
        timer(5000).pipe(map(() => false)),
      ),
    );
  }

  destroy(): void {
    this.injector.destroy();
  }

  private async dataReady(): Promise<{
    modData: NonNullable<ReturnType<SettingsStore['modData']>>;
    modHash: NonNullable<ReturnType<SettingsStore['modHash']>>;
  }> {
    for (let i = 0; i < 300; i++) {
      const modData = this.settingsStore.modData();
      const modHash = this.settingsStore.modHash();
      if (modData && modHash) return { modData, modHash };
      await wait(50);
    }
    throw new Error('Game data did not load for background solve');
  }
}
