import { Dialog } from '@angular/cdk/dialog';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  faExclamationTriangle,
  faLink,
  faPencil,
  faPlus,
  faRoute,
  faTrash,
  faXmark,
} from '@fortawesome/free-solid-svg-icons';

import { Base, OVERVIEW } from '~/base/base';
import {
  baseWarnings,
  exportsFor,
  launchesFor,
  perMinute,
  SPACE_PLATFORM,
  tabLabel,
} from '~/base/base-logic';
import {
  BufferLine,
  buffers,
  carriedBy,
  lapMinutes,
  routeWarnings,
  siloPlan,
  SPACE_LOCATIONS,
  spoilWarnings,
  stationAt,
} from '~/base/route';
import { Button } from '~/components/button/button';
import { Checkbox } from '~/components/checkbox/checkbox';
import { Confirm } from '~/components/confirm/confirm';
import { Icon } from '~/components/icon/icon';
import { Select } from '~/components/select/select';
import { Tooltip } from '~/components/tooltip/tooltip';
import { Library } from '~/library/library';
import { Option } from '~/option/option';
import { rational } from '~/rational/rational';
import { BaseState } from '~/state/preferences/base-state';
import { SettingsStore } from '~/state/settings/settings-store';
import { TranslatePipe } from '~/translate/translate-pipe';

import { BaseLinksDialog } from '../base-links-dialog/base-links-dialog';
import { BaseRouteDialog } from '../base-route-dialog/base-route-dialog';

interface OverviewItem {
  itemId: string;
  text: string;
}

interface OverviewRow {
  id: string;
  label: string;
  location?: string;
  /** No saved build yet */
  unused: boolean;
  /** Has a build name, but that build was deleted */
  missing: boolean;
  stale: boolean;
  buildings?: string;
  power?: string;
  imports: OverviewItem[];
  exports: OverviewItem[];
  rockets?: string;
  /** Silos to build, with how that number was reached */
  silos?: { total: number; lines: string[] };
  /** For platforms */
  lap?: string;
  cargo?: string;
  buffers: BufferRow[];
}

interface BufferRow {
  itemId: string;
  text: string;
  detail: string;
}

@Component({
  selector: 'lab-base-bar',
  imports: [
    Button,
    Checkbox,
    FormsModule,
    Icon,
    Select,
    Tooltip,
    TranslatePipe,
  ],
  templateUrl: './base-bar.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block border-b border-gray-600' },
})
export class BaseBar {
  protected readonly base = inject(Base);
  protected readonly dialog = inject(Dialog);
  private readonly confirm = inject(Confirm);
  private readonly library = inject(Library);
  private readonly settingsStore = inject(SettingsStore);

  protected readonly OVERVIEW = OVERVIEW;
  protected readonly BaseLinksDialog = BaseLinksDialog;
  protected readonly BaseRouteDialog = BaseRouteDialog;

  /** Whether the open tab is a platform, which has a route */
  protected readonly onPlatform = computed(
    () =>
      this.base.platforms().some((t) => t.id === this.base.tab()) &&
      !this.base.busy(),
  );
  protected readonly faLink = faLink;
  protected readonly faPencil = faPencil;
  protected readonly faPlus = faPlus;
  protected readonly faRoute = faRoute;
  protected readonly faTrash = faTrash;
  protected readonly faXmark = faXmark;
  protected readonly tabLabel = tabLabel;

  /** Id of the tab being renamed */
  protected readonly renaming = signal<string | null>(null);
  /** Whether a new platform is being named */
  protected readonly naming = signal(false);
  private readonly nameInput =
    viewChild<ElementRef<HTMLInputElement>>('nameInput');

  constructor() {
    // Name inputs take focus as soon as they appear
    effect(() => {
      const input = this.nameInput()?.nativeElement;
      input?.focus();
      input?.select();
    });
  }

  protected rename(id: string, name: string): void {
    if (this.renaming() !== id) return;
    this.renaming.set(null);
    this.base.renameTab(id, name);
  }

  /** Adds a platform with the typed name, or cancels if nothing was typed */
  protected addPlatform(name: string): void {
    if (!this.naming()) return;
    this.naming.set(false);
    if (name.trim()) this.base.addPlatform(name);
  }

  protected removeTab(id: string): void {
    this.confirm
      .open({
        header: 'base.deleteTabHeader',
        message: 'base.deleteTabMessage',
        icon: faExclamationTriangle,
        actions: [
          { text: 'delete', value: true, icon: faTrash },
          { text: 'cancel', value: false, icon: faXmark },
        ],
      })
      .subscribe((res) => {
        if (res) this.base.removeTab(id);
      });
  }

  private readonly buildNames = computed(
    () => new Set(this.library.builds().map((b) => b.name)),
  );

  /** Saved builds not yet in the base */
  readonly addOptions = computed((): Option[] => {
    const builds = new Set(this.base.state()?.tabs.map((t) => t.build));
    return this.library.options().filter((o) => !builds.has(o.value));
  });

  /** Changes after each pick, so the add select resets */
  protected readonly addKey = computed(() => this.addOptions().length);

  readonly rows = computed((): OverviewRow[] => {
    const state = this.base.state();
    if (!state) return [];
    const stale = this.base.staleTabs();
    const names = this.buildNames();
    const labels = new Map(state.tabs.map((t) => [t.id, tabLabel(t)]));
    const held = buffers(state);

    return state.tabs.map((tab) => {
      const summary = state.summaries?.[tab.id];
      const imports = state.imports?.[tab.id] ?? {};
      const rockets = launchesFor(state, tab.id).mul(rational(60n));

      const power = summary
        ? rational(summary.power).div(rational(1000n)).toNumber()
        : undefined;

      return {
        id: tab.id,
        label: tabLabel(tab),
        location: tab.location,
        unused: tab.build == null,
        missing: tab.build != null && !names.has(tab.build),
        stale: stale.has(tab.id),
        buildings: summary?.buildings,
        power: power != null ? `${Number(power.toFixed(1))} MW` : undefined,
        imports: Object.entries(imports).map(([itemId, i]) => {
          const source = tab.links?.[itemId];
          const from = source ? ` ← ${labels.get(source) ?? source}` : '';
          return {
            itemId,
            text: `${this.itemName(itemId)} ${perMinute(i.rate)}${from}`,
          };
        }),
        exports: Object.entries(exportsFor(state, tab.id)).map(
          ([itemId, rate]) => ({
            itemId,
            text: `${this.itemName(itemId)} ${perMinute(rate)}`,
          }),
        ),
        rockets: rockets.nonzero()
          ? `${Number(rockets.toNumber().toFixed(2))}/min`
          : undefined,
        silos: this.silos(state, tab.id, labels),
        buffers: (held[tab.id] ?? []).map((b) => this.bufferRow(b, labels)),
        ...this.lapAndCargo(state, tab.id),
      };
    });
  });

  readonly warnings = computed((): string[] => {
    const state = this.base.state();
    if (!state) return [];
    const label = (id: string): string => {
      const tab = state.tabs.find((t) => t.id === id);
      return tab ? tabLabel(tab) : id;
    };

    const warnings = baseWarnings(state).map((w) =>
      w.kind === 'missingSource'
        ? `${label(w.tab)}: ${this.itemName(w.itemId)} is linked to a tab that no longer exists`
        : `${label(w.tab)}: exports ${this.itemName(w.itemId)} but also has it excluded, so it would import it`,
    );

    // Imports with no supplying tab
    for (const tab of state.tabs)
      for (const id of Object.keys(state.imports?.[tab.id] ?? {}))
        if (!tab.links?.[id])
          warnings.push(
            `${tabLabel(tab)}: ${this.itemName(id)} is imported but not linked to a tab`,
          );

    for (const w of routeWarnings(state))
      warnings.push(
        w.kind === 'missedStop'
          ? `${label(w.platform)}: carries items for ${this.locationName(w.location)} but its route does not stop there`
          : `${label(w.platform)}: hands items to ${label(w.other)}, which also moves, so both have to be in the same orbit at once. Park one of them (a route with one stop).`,
      );

    for (const w of spoilWarnings(state))
      warnings.push(
        `${label(w.tab)}: ${this.itemName(w.itemId)} can be up to ${Math.round(w.age).toString()} min old when used, but spoils after ${w.spoils.toString()} min`,
      );

    return warnings;
  });

  private silos(
    state: BaseState,
    id: string,
    labels: Map<string, string>,
  ): OverviewRow['silos'] {
    const plan = siloPlan(state, id);
    if (!plan) return undefined;
    const lines: string[] = [];
    if (plan.production) lines.push(`${plan.production.toString()} to keep up`);
    for (const b of plan.buffers)
      lines.push(
        `${b.silos.toString()} to hold ${b.rockets.toString()} rocket${b.rockets === 1 ? '' : 's'} for ${labels.get(b.platform) ?? b.platform}`,
      );
    for (const p of plan.unknown)
      lines.push(`${labels.get(p) ?? p}: no lap time yet`);
    return { total: plan.total, lines };
  }

  private bufferRow(b: BufferLine, labels: Map<string, string>): BufferRow {
    const stack = this.settingsStore
      .dataset()
      .itemRecord[b.itemId]?.stack?.toNumber();
    const amount = Math.ceil(b.amount - 1e-9);
    const stacks = stack
      ? ` (${Math.ceil(amount / stack).toString()} stacks)`
      : '';
    const platform = labels.get(b.platform) ?? b.platform;
    const lap = `${Number(b.lap.toFixed(1)).toString()} min`;
    const detail =
      b.kind === 'pickup'
        ? `ready for ${platform}, ${lap} lap`
        : b.kind === 'dropoff'
          ? `between ${platform} drops, ${lap} lap`
          : `carried per ${lap} lap`;
    return {
      itemId: b.itemId,
      text: `${this.itemName(b.itemId)} ${amount.toLocaleString()}${stacks}`,
      detail,
    };
  }

  private lapAndCargo(
    state: BaseState,
    id: string,
  ): Pick<OverviewRow, 'lap' | 'cargo'> {
    const tab = state.tabs.find((t) => t.id === id);
    if (tab?.location !== SPACE_PLATFORM) return {};
    const station = stationAt(tab);
    if (station)
      return {
        lap: `parked at ${SPACE_LOCATIONS[station] ?? this.locationName(station)}`,
      };
    const lap = lapMinutes(tab.route);
    if (lap == null) return {};
    const items = this.settingsStore.dataset().itemRecord;
    let stacks = 0;
    for (const s of carriedBy(state, id)) {
      const stack = items[s.itemId]?.stack?.toNumber();
      if (stack) stacks += (s.rate * lap * 60) / stack;
    }
    return {
      lap: `${Number(lap.toFixed(1)).toString()} min`,
      cargo: stacks
        ? `${Math.ceil(stacks - 1e-9).toString()} stacks/lap`
        : undefined,
    };
  }

  private locationName(id: string): string {
    return this.settingsStore.dataset().locationRecord[id]?.name ?? id;
  }

  private itemName(id: string): string {
    return this.settingsStore.dataset().itemRecord[id]?.name ?? id;
  }
}
