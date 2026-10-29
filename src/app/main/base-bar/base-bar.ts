import { Dialog } from '@angular/cdk/dialog';
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import {
  faLink,
  faRotate,
  faXmark,
} from '@fortawesome/free-solid-svg-icons';

import { Base, OVERVIEW } from '~/base/base';
import { baseWarnings, exportsFor, perMinute } from '~/base/base-logic';
import { Button } from '~/components/button/button';
import { Select } from '~/components/select/select';
import { Tooltip } from '~/components/tooltip/tooltip';
import { Library } from '~/library/library';
import { Option } from '~/option/option';
import { rational } from '~/rational/rational';
import { SettingsStore } from '~/state/settings/settings-store';
import { TranslatePipe } from '~/translate/translate-pipe';

import { BaseLinksDialog } from '../base-links-dialog/base-links-dialog';

interface OverviewRow {
  build: string;
  missing: boolean;
  stale: boolean;
  buildings?: string;
  power?: string;
  imports: string[];
  exports: string[];
  rockets?: string;
}

@Component({
  selector: 'lab-base-bar',
  imports: [Button, Select, Tooltip, TranslatePipe],
  templateUrl: './base-bar.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block border-b border-gray-600' },
})
export class BaseBar {
  protected readonly base = inject(Base);
  protected readonly dialog = inject(Dialog);
  private readonly library = inject(Library);
  private readonly settingsStore = inject(SettingsStore);

  protected readonly OVERVIEW = OVERVIEW;
  protected readonly BaseLinksDialog = BaseLinksDialog;
  protected readonly faLink = faLink;
  protected readonly faRotate = faRotate;
  protected readonly faXmark = faXmark;

  private readonly buildNames = computed(
    () => new Set(this.library.builds().map((b) => b.name)),
  );

  /** Saved builds not yet in the base */
  readonly addOptions = computed((): Option[] => {
    const tabs = new Set(this.base.state()?.tabs.map((t) => t.build));
    return this.library
      .options()
      .filter((o) => !tabs.has(o.value));
  });

  readonly rows = computed((): OverviewRow[] => {
    const state = this.base.state();
    if (!state) return [];
    const stale = this.base.staleTabs();
    const names = this.buildNames();

    return state.tabs.map((tab) => {
      const summary = state.summaries?.[tab.build];
      const imports = state.imports?.[tab.build] ?? {};
      let rockets = rational.zero;
      for (const i of Object.values(imports))
        if (i.rockets) rockets = rockets.add(rational(i.rockets));

      return {
        build: tab.build,
        missing: !names.has(tab.build),
        stale: stale.has(tab.build),
        buildings: summary?.buildings,
        power: summary
          ? `${Number(rational(summary.power).div(rational(1000n)).toNumber().toFixed(1))} MW`
          : undefined,
        imports: Object.entries(imports).map(([id, i]) => {
          const source = tab.links?.[id];
          return `${this.itemName(id)} ${perMinute(i.rate)}${source ? ` ← ${source}` : ''}`;
        }),
        exports: Object.entries(exportsFor(state, tab.build)).map(
          ([id, rate]) => `${this.itemName(id)} ${perMinute(rate)}`,
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
    const warnings = baseWarnings(state).map((w) =>
      w.kind === 'missingSource'
        ? `${w.build}: ${this.itemName(w.itemId)} is linked to "${w.source}", which is not a tab`
        : `${w.build}: exports ${this.itemName(w.itemId)} but also has it excluded, so it would import it`,
    );

    // Imports with no supplying tab
    for (const tab of state.tabs)
      for (const id of Object.keys(state.imports?.[tab.build] ?? {}))
        if (!tab.links?.[id])
          warnings.push(`${tab.build}: ${this.itemName(id)} is imported but not linked to a tab`);

    return warnings;
  });

  /** Unique key for the select so it resets after each pick */
  protected readonly addKey = computed(() => this.addOptions().length);

  private itemName(id: string): string {
    return this.settingsStore.dataset().itemRecord[id]?.name ?? id;
  }
}
