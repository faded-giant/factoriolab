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
import {
  faExclamationTriangle,
  faLink,
  faPencil,
  faPlus,
  faTrash,
  faXmark,
} from '@fortawesome/free-solid-svg-icons';

import { Base, OVERVIEW } from '~/base/base';
import {
  baseWarnings,
  exportsFor,
  launchesFor,
  perMinute,
  tabLabel,
} from '~/base/base-logic';
import { Button } from '~/components/button/button';
import { Confirm } from '~/components/confirm/confirm';
import { Icon } from '~/components/icon/icon';
import { Select } from '~/components/select/select';
import { Tooltip } from '~/components/tooltip/tooltip';
import { Library } from '~/library/library';
import { Option } from '~/option/option';
import { rational } from '~/rational/rational';
import { SettingsStore } from '~/state/settings/settings-store';
import { TranslatePipe } from '~/translate/translate-pipe';

import { BaseLinksDialog } from '../base-links-dialog/base-links-dialog';

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
}

@Component({
  selector: 'lab-base-bar',
  imports: [Button, Icon, Select, Tooltip, TranslatePipe],
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
  protected readonly faLink = faLink;
  protected readonly faPencil = faPencil;
  protected readonly faPlus = faPlus;
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

    return warnings;
  });

  private itemName(id: string): string {
    return this.settingsStore.dataset().itemRecord[id]?.name ?? id;
  }
}
