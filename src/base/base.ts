import {
  computed,
  effect,
  EnvironmentInjector,
  inject,
  Service,
  signal,
  untracked,
} from '@angular/core';
import {
  debounceTime,
  firstValueFrom,
  map,
  Observable,
  race,
  timer,
} from 'rxjs';

import { Library } from '~/library/library';
import { Option } from '~/option/option';
import { Rational, rational } from '~/rational/rational';
import { ObjectiveState } from '~/state/objectives/objective';
import { ObjectiveType } from '~/state/objectives/objective-type';
import { ObjectiveUnit } from '~/state/objectives/objective-unit';
import { ObjectivesStore } from '~/state/objectives/objectives-store';
import {
  BaseState,
  BaseTab,
  PlatformRoute,
} from '~/state/preferences/base-state';
import { PreferencesStore } from '~/state/preferences/preferences-store';
import { RouterSync } from '~/state/router/router-sync';
import { SettingsStore } from '~/state/settings/settings-store';
import { storedSignal } from '~/utils/stored-signal';

import {
  demandsFor,
  findExportObjective,
  importsFrom,
  isStale,
  planReconcile,
  RocketCost,
  SPACE_PLATFORM,
  summarize,
  tabLabel,
  tabsToProcess,
  withTabIds,
} from './base-logic';
import { Headless } from './headless';

export interface ActiveBase {
  modId: string;
  name: string;
}

export const OVERVIEW = '';
const ROCKET_PART = 'rocket-part';
const MAX_PASSES = 8;

function waitFor(source: Observable<unknown>, ms: number): Promise<boolean> {
  return firstValueFrom(
    race(source.pipe(map(() => true)), timer(ms).pipe(map(() => false))),
  );
}

/** The calculator state a tab is solved in: the page, or the hidden copy */
interface Solver {
  objectivesStore: ObjectivesStore;
  settingsStore: SettingsStore;
}

/**
 * Links saved builds as tabs of a base, usually one per planet. What one tab
 * imports, the tab it is linked to exports, kept up to date automatically by
 * solving the other tabs in the background.
 */
@Service()
export class Base {
  private readonly injector = inject(EnvironmentInjector);
  private readonly library = inject(Library);
  private readonly objectivesStore = inject(ObjectivesStore);
  private readonly preferencesStore = inject(PreferencesStore);
  private readonly routerSync = inject(RouterSync);
  private readonly settingsStore = inject(SettingsStore);

  private readonly stored = storedSignal('base');

  readonly active = computed((): ActiveBase | undefined => {
    const stored = this.stored();
    if (!stored) return undefined;
    try {
      return JSON.parse(stored) as ActiveBase;
    } catch {
      return undefined;
    }
  });

  readonly state = computed((): BaseState | undefined => {
    const active = this.active();
    if (!active) return undefined;
    const base = this.preferencesStore.bases()[active.modId]?.[active.name];
    return base ? withTabIds(base) : undefined;
  });

  /** Id of the open tab, or `OVERVIEW` */
  readonly tab = signal(OVERVIEW);
  /** Label of the tab being opened, while switching */
  readonly busy = signal<string | null>(null);
  /** Label of the tab being updated in the background */
  readonly working = signal<string | null>(null);
  readonly error = signal<string | null>(null);

  /** What launching one rocket takes, if the game has rockets */
  readonly rocketCost = computed((): RocketCost | undefined => {
    const data = this.settingsStore.dataset();
    if (!data.itemRecord[ROCKET_PART]) return undefined;
    const silo = data.machineIds
      .map((id) => data.machineRecord[id]?.silo)
      .find((s) => s != null);
    return silo ? { itemId: ROCKET_PART, parts: silo.parts } : undefined;
  });

  readonly staleTabs = computed(() => {
    const state = this.state();
    const rocket = this.rocketCost();
    if (!state) return new Set<string>();
    return new Set(
      state.tabs.map((t) => t.id).filter((id) => isStale(state, id, rocket)),
    );
  });

  /** Base names for the current mod */
  readonly names = computed(() => {
    const modId = this.settingsStore.modId();
    if (!modId) return [];
    return Object.keys(this.preferencesStore.bases()[modId] ?? {}).sort();
  });

  /** Planets of the current game, empty if it has none */
  readonly planets = computed(() => {
    const data = this.settingsStore.dataset();
    return data.locationIds
      .filter((id) => id !== SPACE_PLATFORM)
      .map((id) => ({ id, name: data.locationRecord[id]?.name ?? id }));
  });

  /** Platform tabs, which can carry imports between planets */
  readonly platforms = computed(
    () => this.state()?.tabs.filter((t) => t.location === SPACE_PLATFORM) ?? [],
  );

  readonly hasPlatforms = computed(() =>
    this.settingsStore.dataset().locationIds.includes(SPACE_PLATFORM),
  );

  private headless: Headless | undefined;
  /** Serializes tab switches and background updates */
  private lock: Promise<void> = Promise.resolve();
  private running = false;
  private again = false;

  constructor() {
    // A base belongs to one game; switching game closes it
    effect(() => {
      const active = this.active();
      const modId = this.settingsStore.modId();
      if (active && modId && active.modId !== modId)
        untracked(() => {
          this.close();
        });
    });

    // When the open tab's build is saved, record what it now imports
    effect(() => {
      const id = this.tab();
      const query = this.library.query();
      const build = this.state()?.tabs.find((t) => t.id === id)?.build;
      const saved = this.library.builds().find((b) => b.name === build)?.query;
      this.objectivesStore.steps();
      if (!id || this.busy() || saved == null || saved !== query) return;
      untracked(() => {
        this.capture(id, this.live());
      });
    });

    // Any tab whose exports changed (or that was never solved) gets updated
    effect(() => {
      const state = this.state();
      const rocket = this.rocketCost();
      if (!state || this.busy() || !tabsToProcess(state, rocket).length) return;
      untracked(() => {
        this.schedule();
      });
    });
  }

  /** New base with one tab per planet, or from saved builds if no planets */
  create(name: string, builds: string[] = []): void {
    const modId = this.settingsStore.modId();
    if (!modId || !name) return;
    const tabs: BaseTab[] = builds.length
      ? builds.map((build) => ({ id: build, build }))
      : this.planets().map((p) => ({
          id: p.id,
          label: p.name,
          location: p.id,
        }));
    this.preferencesStore.saveBase(modId, name, {
      tabs,
      updatedAt: Date.now(),
    });
  }

  open(name: string): void {
    const modId = this.settingsStore.modId();
    if (!modId) return;
    this.library.flush();
    this.headless?.destroy();
    this.headless = undefined;
    this.stored.set(JSON.stringify({ modId, name }));
    this.tab.set(OVERVIEW);
    this.error.set(null);
  }

  close(): void {
    this.stored.set(undefined);
    this.tab.set(OVERVIEW);
    this.headless?.destroy();
    this.headless = undefined;
  }

  remove(name: string): void {
    const modId = this.settingsStore.modId();
    if (!modId) return;
    if (this.active()?.name === name) this.close();
    this.preferencesStore.removeBase(modId, name);
  }

  /** Name the next new platform gets if none is given */
  nextPlatformName(): string {
    const labels = new Set(this.state()?.tabs.map(tabLabel));
    let n = 1;
    while (labels.has(`Platform ${n.toString()}`)) n++;
    return `Platform ${n.toString()}`;
  }

  addPlatform(name?: string): void {
    const label = name?.trim() || this.nextPlatformName();
    this.update((s) => {
      let n = 1;
      while (s.tabs.some((t) => t.id === `platform-${n.toString()}`)) n++;
      const tab: BaseTab = {
        id: `platform-${n.toString()}`,
        label,
        location: SPACE_PLATFORM,
      };
      return { ...s, tabs: [...s.tabs, tab] };
    });
  }

  /** Renames a tab, and its build if it still has the name made for it */
  renameTab(id: string, name: string): void {
    const active = this.active();
    const tab = this.findTab(id);
    const label = name.trim();
    if (!active || !tab || !label || label === tabLabel(tab)) return;
    this.updateTab(id, { label });
    if (tab.build !== this.buildName(tab)) return;
    const to = this.buildName({ ...tab, label });
    if (this.savedQuery(to) == null) this.library.rename(tab.build, to);
  }

  /** Adds an existing saved build as a tab */
  addBuild(build: string): void {
    this.update((s) =>
      s.tabs.some((t) => t.build === build)
        ? s
        : { ...s, tabs: [...s.tabs, { id: build, build }] },
    );
  }

  removeTab(id: string): void {
    this.update((s) => ({
      ...s,
      tabs: s.tabs
        .filter((t) => t.id !== id)
        .map((t) => ({
          ...t,
          links: Object.fromEntries(
            Object.entries(t.links ?? {}).filter(([, src]) => src !== id),
          ),
          via: Object.fromEntries(
            Object.entries(t.via ?? {}).filter(([, v]) => v !== id),
          ),
        })),
    }));
    if (this.tab() === id) this.tab.set(OVERVIEW);
  }

  /** Choices for where tab `id` imports an item from */
  sourceOptions(id: string): Option[] {
    return [
      { label: 'base.notLinked', value: '' },
      ...(this.state()?.tabs ?? [])
        .filter((t) => t.id !== id)
        .map(
          (t): Option => ({
            label: tabLabel(t),
            value: t.id,
            icon: t.location,
            iconType: t.location ? 'location' : undefined,
          }),
        ),
    ];
  }

  /** Sets which tab supplies an item imported by tab `id`; null unlinks */
  setLink(id: string, itemId: string, source: string | null): void {
    const tab = this.findTab(id);
    const links = { ...tab?.links };
    const via = { ...tab?.via };
    if (source) links[itemId] = source;
    else {
      delete links[itemId];
      delete via[itemId];
    }
    this.updateTab(id, { links, via });
  }

  /**
   * Whether tab `id` can pick a platform to carry its import of an item: it
   * comes from a planet, to somewhere that is not itself a platform
   */
  canShipVia(id: string, itemId: string): boolean {
    const tab = this.findTab(id);
    const source = this.findTab(tab?.links?.[itemId] ?? '');
    return (
      !!tab &&
      !!source?.location &&
      tab.location !== SPACE_PLATFORM &&
      source.location !== SPACE_PLATFORM &&
      this.platforms().length > 0
    );
  }

  /** Choices for which platform carries an import */
  viaOptions(): Option[] {
    return [
      { label: 'base.direct', value: '' },
      ...this.platforms().map(
        (t): Option => ({
          label: tabLabel(t),
          value: t.id,
          icon: t.location,
          iconType: 'location',
        }),
      ),
    ];
  }

  /** Sets the platform that carries an import of tab `id`; null clears it */
  setVia(id: string, itemId: string, platform: string | null): void {
    const via = { ...this.findTab(id)?.via };
    if (platform) via[itemId] = platform;
    else delete via[itemId];
    this.updateTab(id, { via });
  }

  setRoute(id: string, route: PlatformRoute): void {
    this.updateTab(id, { route });
  }

  setSecondRocket(value: boolean): void {
    this.update((s) => ({ ...s, secondRocket: value || undefined }));
  }

  /** Opens a tab, creating its build first if it is a new planet tab */
  select(id: string): Promise<void> {
    return this.exclusive(async () => {
      this.library.flush();
      if (id === OVERVIEW) {
        this.tab.set(OVERVIEW);
        return;
      }

      const tab = this.findTab(id);
      if (!tab) return;
      this.busy.set(tabLabel(tab));
      try {
        const build = tab.build ?? (await this.materialize(tab));
        await this.showLive(build);
        this.tab.set(id);
        const state = this.state();
        if (state && isStale(state, id, this.rocketCost()))
          await this.reconcileLive(id, build);
        this.capture(id, this.live());
      } catch (err) {
        this.error.set(String(err));
      } finally {
        this.busy.set(null);
      }
    });
  }

  /** Coalesces requests to update stale tabs into one background run */
  private schedule(): void {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    void this.exclusive(async () => {
      try {
        do {
          this.again = false;
          await this.processAll();
        } while (this.again);
        this.error.set(null);
      } catch (err) {
        this.error.set(String(err));
      } finally {
        this.working.set(null);
        this.running = false;
      }
    });
  }

  /** Updates tabs until no exports change; tabs may supply each other */
  private async processAll(): Promise<void> {
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      const state = this.state();
      if (!state) return;
      const todo = tabsToProcess(state, this.rocketCost());
      if (!todo.length) return;
      for (const tab of todo) {
        this.working.set(tabLabel(tab));
        if (tab.id === this.tab() && tab.build)
          await this.reconcileLive(tab.id, tab.build);
        else await this.processHidden(tab);
      }
    }
  }

  /** Brings a tab that is not on screen up to date, in the hidden copy */
  private async processHidden(tab: BaseTab): Promise<void> {
    const modId = this.active()?.modId;
    if (!modId) return;
    const build = tab.build ?? (await this.materialize(tab));
    const saved = this.savedQuery(build);
    if (saved == null) return;

    const headless = this.engine();
    await headless.load(modId, saved);

    const settled = headless.settled();
    if (this.reconcile(tab.id, headless)) await settled;
    if (headless.query && headless.query !== saved)
      this.preferencesStore.saveState(modId, build, headless.query);

    this.capture(tab.id, headless);
  }

  /** Updates the exports of the tab on screen and saves the result */
  private async reconcileLive(id: string, build: string): Promise<void> {
    const settled = this.urlSettled();
    if (this.reconcile(id, this.live())) {
      await settled;
      if (this.library.query() !== this.savedQuery(build))
        this.library.saveCurrent(build);
    }
    this.capture(id, this.live());
  }

  /** Creates the saved build behind a new tab, limited to its location */
  private async materialize(tab: BaseTab): Promise<string> {
    const active = this.active();
    if (!active) throw new Error('No base is open');
    const name = this.buildName(tab);

    if (this.savedQuery(name) == null) {
      const headless = this.engine();
      await headless.load(active.modId, '');
      if (tab.location) {
        const settled = headless.settled();
        headless.settingsStore.apply({ locationIds: new Set([tab.location]) });
        await settled;
      }
      this.preferencesStore.saveState(active.modId, name, headless.query);
      this.preferencesStore.updateBuildMeta(active.modId, name, {
        folder: active.name,
      });
    }

    this.updateTab(tab.id, { build: name });
    return name;
  }

  /** Puts a build on screen and waits until the page has caught up */
  private async showLive(build: string): Promise<void> {
    const saved = this.savedQuery(build);
    if (saved == null || saved === this.library.query()) return;

    const settled = this.urlSettled();
    const loaded = waitFor(this.routerSync.applied, 5000);
    await this.library.open(build);
    await loaded;
    await settled;
    // Nothing was edited yet, so any difference is the app re-encoding an
    // older URL: save it, so the build matches what is on screen
    if (this.library.query() !== this.savedQuery(build))
      this.library.saveCurrent(build);
  }

  /** Updates a tab's export objectives; returns true if any changed */
  private reconcile(id: string, solver: Solver): boolean {
    const state = this.state();
    const tab = state?.tabs.find((t) => t.id === id);
    if (!state || !tab) return false;

    const store = solver.objectivesStore;
    const exports = demandsFor(state, id, this.rocketCost());
    const dispRate = solver.settingsStore.displayRateInfo().value;
    const objectives = (): ObjectiveState[] => Object.values(store.state());
    const plan = planReconcile(
      objectives(),
      exports,
      tab.applied ?? {},
      dispRate,
    );

    for (const { id: objectiveId, value } of plan.updates)
      store.updateRecordField(objectiveId, 'value', value);
    for (const { targetId, value } of plan.adds)
      store.add({
        targetId,
        value,
        unit: ObjectiveUnit.Items,
        type: ObjectiveType.Output,
      });
    // Removing renumbers objectives, so look each one up again
    for (const itemId of plan.removes) {
      const objective = findExportObjective(objectives(), itemId);
      if (objective) store.remove(objective.id);
    }

    const applied = Object.fromEntries(
      Object.entries(exports).map(([itemId, v]) => [itemId, v.toString()]),
    );
    if (JSON.stringify(applied) !== JSON.stringify(tab.applied ?? {}))
      this.updateTab(id, { applied });

    return plan.updates.length + plan.adds.length + plan.removes.length > 0;
  }

  /** Records what a solved tab imports and its totals */
  private capture(id: string, solver: Solver): void {
    const state = this.state();
    if (!state?.tabs.some((t) => t.id === id)) return;

    const dispRate = solver.settingsStore.displayRateInfo().value;
    const imports = importsFrom(
      solver.objectivesStore.steps(),
      solver.settingsStore.settings().excludedItemIds,
      dispRate,
    );
    const totals = solver.objectivesStore.totals();
    const power: Rational = totals.power ?? rational.zero;
    const data = solver.settingsStore.dataset();
    const siloIds = new Set(
      Object.keys(totals.machines).filter(
        (m) => data.machineRecord[m]?.silo != null,
      ),
    );
    const summary = summarize(totals.machines, power, siloIds);

    if (
      JSON.stringify(state.imports?.[id] ?? {}) === JSON.stringify(imports) &&
      JSON.stringify(state.summaries?.[id]) === JSON.stringify(summary)
    )
      return;

    this.update((s) => ({
      ...s,
      imports: { ...s.imports, [id]: imports },
      summaries: { ...s.summaries, [id]: summary },
    }));
  }

  /** Name of the build made for a tab */
  private buildName(tab: BaseTab): string {
    return `${this.active()?.name ?? ''} – ${tabLabel(tab)}`;
  }

  private live(): Solver {
    return {
      objectivesStore: this.objectivesStore,
      settingsStore: this.settingsStore,
    };
  }

  private engine(): Headless {
    this.headless ??= new Headless(this.injector);
    return this.headless;
  }

  private savedQuery(build: string): string | undefined {
    const modId = this.active()?.modId;
    if (!modId) return undefined;
    return this.preferencesStore.states()[modId]?.[build];
  }

  /** Waits until the URL has caught up with the stores */
  private async urlSettled(): Promise<void> {
    await waitFor(this.routerSync.urlUpdated.pipe(debounceTime(300)), 3000);
  }

  /** Runs one task at a time, in order */
  private exclusive(task: () => Promise<void>): Promise<void> {
    const run = this.lock.then(task, task);
    this.lock = run.catch(() => undefined);
    return run;
  }

  private findTab(id: string): BaseTab | undefined {
    return this.state()?.tabs.find((t) => t.id === id);
  }

  private updateTab(id: string, partial: Partial<BaseTab>): void {
    this.update((s) => ({
      ...s,
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...partial } : t)),
    }));
  }

  private update(fn: (state: BaseState) => BaseState): void {
    const active = this.active();
    const state = this.state();
    if (!active || !state) return;
    this.preferencesStore.saveBase(active.modId, active.name, {
      ...fn(state),
      updatedAt: Date.now(),
    });
  }
}
