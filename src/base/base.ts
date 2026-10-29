import {
  computed,
  effect,
  inject,
  Service,
  signal,
  untracked,
} from '@angular/core';
import {
  faExclamationTriangle,
  faFloppyDisk,
  faTrash,
  faXmark,
} from '@fortawesome/free-solid-svg-icons';
import {
  debounceTime,
  firstValueFrom,
  map,
  Observable,
  race,
  timer,
} from 'rxjs';

import { Confirm } from '~/components/confirm/confirm';
import { Library } from '~/library/library';
import { rational } from '~/rational/rational';
import { ObjectiveState } from '~/state/objectives/objective';
import { BaseState, BaseTab } from '~/state/preferences/base-state';
import { ObjectiveType } from '~/state/objectives/objective-type';
import { ObjectiveUnit } from '~/state/objectives/objective-unit';
import { ObjectivesStore } from '~/state/objectives/objectives-store';
import { PreferencesStore } from '~/state/preferences/preferences-store';
import { RouterSync } from '~/state/router/router-sync';
import { SettingsStore } from '~/state/settings/settings-store';
import { storedSignal } from '~/utils/stored-signal';

import {
  exportsFor,
  findExportObjective,
  importsFrom,
  isStale,
  planReconcile,
  summarize,
} from './base-logic';

export interface ActiveBase {
  modId: string;
  name: string;
}

export const OVERVIEW = '';
const MAX_PASSES = 6;

function waitFor(source: Observable<unknown>, ms: number): Promise<boolean> {
  return firstValueFrom(
    race(source.pipe(map(() => true)), timer(ms).pipe(map(() => false))),
  );
}

/**
 * Links several saved builds (e.g. one per planet) so that what one tab
 * imports, the tab it is linked to automatically exports.
 */
@Service()
export class Base {
  private readonly confirm = inject(Confirm);
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
    return this.preferencesStore.bases()[active.modId]?.[active.name];
  });

  /** Build name of the open tab, or `OVERVIEW` */
  readonly tab = signal(OVERVIEW);
  /** Progress text while switching tabs or updating, otherwise null */
  readonly busy = signal<string | null>(null);

  readonly staleTabs = computed(() => {
    const state = this.state();
    if (!state) return new Set<string>();
    return new Set(
      state.tabs.map((t) => t.build).filter((b) => isStale(state, b)),
    );
  });

  /** Base names for the current mod */
  readonly names = computed(() => {
    const modId = this.settingsStore.modId();
    if (!modId) return [];
    return Object.keys(this.preferencesStore.bases()[modId] ?? {}).sort();
  });

  constructor() {
    // A base belongs to one game; switching game closes it
    effect(() => {
      const active = this.active();
      const modId = this.settingsStore.modId();
      if (active && modId && active.modId !== modId)
        untracked(() => this.close());
    });

    // When the open tab is saved, refresh what it needs from other tabs
    effect(() => {
      const tab = this.tab();
      const query = this.library.query();
      const saved = this.library.builds().find((b) => b.name === tab)?.query;
      this.objectivesStore.steps();
      if (!tab || this.busy() || saved == null || saved !== query) return;
      untracked(() => this.capture(tab));
    });
  }

  create(name: string, builds: string[]): void {
    const modId = this.settingsStore.modId();
    if (!modId || !name) return;
    const tabs: BaseTab[] = builds.map((build) => ({ build }));
    this.preferencesStore.saveBase(modId, name, { tabs, updatedAt: Date.now() });
  }

  async open(name: string): Promise<void> {
    const modId = this.settingsStore.modId();
    if (!modId || this.busy()) return;
    if (!(await this.leaveCurrent())) return;
    this.stored.set(JSON.stringify({ modId, name }));
    this.tab.set(OVERVIEW);
    const first = this.state()?.tabs[0]?.build;
    if (first) await this.select(first);
  }

  close(): void {
    this.stored.set(undefined);
    this.tab.set(OVERVIEW);
  }

  remove(name: string): void {
    const modId = this.settingsStore.modId();
    if (!modId) return;
    if (this.active()?.name === name) this.close();
    this.preferencesStore.removeBase(modId, name);
  }

  addTab(build: string): void {
    this.update((s) =>
      s.tabs.some((t) => t.build === build)
        ? s
        : { ...s, tabs: [...s.tabs, { build }] },
    );
  }

  removeTab(build: string): void {
    this.update((s) => ({
      ...s,
      tabs: s.tabs
        .filter((t) => t.build !== build)
        .map((t) => ({
          ...t,
          links: Object.fromEntries(
            Object.entries(t.links ?? {}).filter(([, src]) => src !== build),
          ),
        })),
    }));
    if (this.tab() === build) this.tab.set(OVERVIEW);
  }

  /** Sets which tab supplies an item imported by `build`; null unlinks it */
  setLink(build: string, itemId: string, source: string | null): void {
    this.update((s) => ({
      ...s,
      tabs: s.tabs.map((t) => {
        if (t.build !== build) return t;
        const links = { ...t.links };
        if (source) links[itemId] = source;
        else delete links[itemId];
        return { ...t, links };
      }),
    }));
  }

  /** Opens a tab, first offering to save unsaved edits on the current one */
  async select(build: string): Promise<boolean> {
    if (this.busy()) return false;
    if (!(await this.leaveCurrent())) return false;
    if (build === OVERVIEW) {
      this.tab.set(OVERVIEW);
      return true;
    }

    this.busy.set(build);
    try {
      await this.activate(build);
      this.tab.set(build);
    } finally {
      this.busy.set(null);
    }
    return true;
  }

  /**
   * Visits every tab, letting each one update its exports from the others,
   * until nothing changes (tabs can supply each other in both directions)
   */
  async updateAll(): Promise<void> {
    const state = this.state();
    if (!state || this.busy()) return;
    if (!(await this.leaveCurrent())) return;

    const returnTo = this.tab();
    try {
      for (let pass = 1; pass <= MAX_PASSES; pass++) {
        const before = JSON.stringify(this.state()?.imports ?? {});
        for (const tab of this.state()?.tabs ?? []) {
          if (!this.library.builds().some((b) => b.name === tab.build)) continue;
          this.busy.set(`${tab.build} (pass ${pass})`);
          await this.activate(tab.build);
          this.tab.set(tab.build);
        }
        const after = JSON.stringify(this.state()?.imports ?? {});
        if (before === after && this.staleTabs().size === 0) break;
      }
    } finally {
      this.busy.set(null);
    }

    if (returnTo !== this.tab()) await this.select(returnTo);
  }

  /** Returns false if the user cancelled */
  private async leaveCurrent(): Promise<boolean> {
    const tab = this.tab();
    if (!tab) return true;
    const saved = this.library.builds().find((b) => b.name === tab)?.query;
    if (saved == null || saved === this.library.query()) return true;

    const choice = await firstValueFrom(
      this.confirm.open({
        header: 'base.unsavedHeader',
        message: 'base.unsavedMessage',
        icon: faExclamationTriangle,
        actions: [
          { text: 'base.saveChanges', value: 'save', icon: faFloppyDisk },
          { text: 'base.discardChanges', value: 'discard', icon: faTrash },
          { text: 'cancel', value: 'cancel', icon: faXmark },
        ],
      }),
    );

    if (choice === 'save') {
      this.library.saveCurrent(tab);
      this.capture(tab);
      return true;
    }
    return choice === 'discard';
  }

  /** Loads a tab's build, brings its exports up to date, and saves those */
  private async activate(build: string): Promise<void> {
    const saved = this.library.builds().find((b) => b.name === build);
    if (!saved) return;

    // Listen before navigating, so no URL update can slip past
    const settled = this.urlSettled();
    const navigated = saved.query !== this.library.query();
    if (navigated) {
      const loaded = waitFor(this.routerSync.applied, 5000);
      await this.library.open(build);
      await loaded;
    }

    const reconciled = this.reconcile(build);
    if (navigated || reconciled) {
      await settled;
      /**
       * Nothing was edited yet, so any difference is either the export
       * objectives or the app re-encoding an older URL: save it, so the tab
       * does not look unsaved
       */
      if (this.library.query() !== saved.query) this.library.saveCurrent(build);
    }

    this.capture(build);
  }

  /** Updates this tab's export objectives; returns true if any changed */
  private reconcile(build: string): boolean {
    const state = this.state();
    const tab = state?.tabs.find((t) => t.build === build);
    if (!state || !tab) return false;

    const exports = exportsFor(state, build);
    const dispRate = this.settingsStore.displayRateInfo().value;
    const objectives = (): ObjectiveState[] =>
      Object.values(this.objectivesStore.state());
    const plan = planReconcile(objectives(), exports, tab.applied ?? {}, dispRate);

    for (const { id, value } of plan.updates)
      this.objectivesStore.updateRecordField(id, 'value', value);
    for (const { targetId, value } of plan.adds)
      this.objectivesStore.add({
        targetId,
        value,
        unit: ObjectiveUnit.Items,
        type: ObjectiveType.Output,
      });
    // Removing renumbers objectives, so look each one up again
    for (const itemId of plan.removes) {
      const objective = findExportObjective(objectives(), itemId);
      if (objective) this.objectivesStore.remove(objective.id);
    }

    const applied = Object.fromEntries(
      Object.entries(exports).map(([id, v]) => [id, v.toString()]),
    );
    if (JSON.stringify(applied) !== JSON.stringify(tab.applied ?? {}))
      this.updateTab(build, { applied });

    return plan.updates.length + plan.adds.length + plan.removes.length > 0;
  }

  /** Records what the open tab imports and its totals, from the live solve */
  private capture(build: string): void {
    const state = this.state();
    if (!state?.tabs.some((t) => t.build === build)) return;

    const dispRate = this.settingsStore.displayRateInfo().value;
    const imports = importsFrom(
      this.objectivesStore.steps(),
      this.settingsStore.settings().excludedItemIds,
      dispRate,
    );
    const totals = this.objectivesStore.totals();
    const summary = summarize(totals.machines, totals.power ?? rational.zero);

    if (
      JSON.stringify(state.imports?.[build] ?? {}) === JSON.stringify(imports) &&
      JSON.stringify(state.summaries?.[build]) === JSON.stringify(summary)
    )
      return;

    this.update((s) => ({
      ...s,
      imports: { ...s.imports, [build]: imports },
      summaries: { ...s.summaries, [build]: summary },
    }));
  }

  /** Waits until the URL has caught up with the stores */
  private async urlSettled(): Promise<void> {
    await waitFor(
      this.routerSync.urlUpdated.pipe(debounceTime(300)),
      3000,
    );
  }

  private updateTab(build: string, partial: Partial<BaseTab>): void {
    this.update((s) => ({
      ...s,
      tabs: s.tabs.map((t) => (t.build === build ? { ...t, ...partial } : t)),
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
