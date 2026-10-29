import { DialogRef } from '@angular/cdk/dialog';
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';

import { Base } from '~/base/base';
import { exportsFor, importsFrom, perMinute } from '~/base/base-logic';
import { DialogData } from '~/components/dialog/dialog';
import { Select } from '~/components/select/select';
import { Option } from '~/option/option';
import { ObjectivesStore } from '~/state/objectives/objectives-store';
import { SettingsStore } from '~/state/settings/settings-store';
import { TranslatePipe } from '~/translate/translate-pipe';

interface ImportRow {
  itemId: string;
  name: string;
  rate: string;
  source: string;
}

/** Choose which tab supplies each item the open tab imports */
@Component({
  selector: 'lab-base-links-dialog',
  imports: [Select, TranslatePipe],
  templateUrl: './base-links-dialog.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class:
      'flex w-xl max-w-full flex-col gap-3 overflow-hidden p-3 pt-0 sm:gap-4 sm:p-6 sm:pt-0',
  },
})
export class BaseLinksDialog implements DialogData {
  protected readonly dialogRef = inject(DialogRef);
  protected readonly base = inject(Base);
  private readonly objectivesStore = inject(ObjectivesStore);
  private readonly settingsStore = inject(SettingsStore);

  readonly header = 'base.linksHeader';

  /** From the live solve, so newly excluded items show up right away */
  readonly imports = computed((): ImportRow[] => {
    const tab = this.base.state()?.tabs.find((t) => t.build === this.base.tab());
    if (!tab) return [];
    const imports = importsFrom(
      this.objectivesStore.steps(),
      this.settingsStore.settings().excludedItemIds,
      this.settingsStore.displayRateInfo().value,
    );
    return Object.entries(imports).map(([itemId, i]) => ({
      itemId,
      name: this.itemName(itemId),
      rate: perMinute(i.rate),
      source: tab.links?.[itemId] ?? '',
    }));
  });

  readonly exports = computed(() => {
    const state = this.base.state();
    if (!state) return [];
    return Object.entries(exportsFor(state, this.base.tab())).map(
      ([id, rate]) => `${this.itemName(id)} ${perMinute(rate)}`,
    );
  });

  readonly sourceOptions = computed((): Option[] => [
    { label: 'base.notLinked', value: '' },
    ...(this.base.state()?.tabs ?? [])
      .filter((t) => t.build !== this.base.tab())
      .map((t) => ({ label: t.build, value: t.build })),
  ]);

  setSource(itemId: string, source: string | undefined): void {
    this.base.setLink(this.base.tab(), itemId, source || null);
  }

  private itemName(id: string): string {
    return this.settingsStore.dataset().itemRecord[id]?.name ?? id;
  }
}
