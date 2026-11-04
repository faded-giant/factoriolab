import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
} from '@angular/core';

import { Base } from '~/base/base';
import { perMinute, tabLabel } from '~/base/base-logic';
import {
  DEFAULT_POWER_QUALITY,
  DEFAULT_TOWER_FUEL,
  POWER_SOURCES,
  powerPlan,
  QUALITY_LEVELS,
} from '~/base/power';
import { DialogData } from '~/components/dialog/dialog';
import { Icon } from '~/components/icon/icon';
import { Select } from '~/components/select/select';
import { Option } from '~/option/option';
import { PowerSource, TabPower } from '~/state/preferences/base-state';
import { SettingsStore } from '~/state/settings/settings-store';
import { TranslatePipe } from '~/translate/translate-pipe';

const NONE = '';

/** Choose how a tab makes its electricity, and see what that takes */
@Component({
  selector: 'lab-base-power-dialog',
  imports: [Icon, Select, TranslatePipe],
  templateUrl: './base-power-dialog.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class:
      'flex w-lg max-w-full flex-col gap-3 overflow-hidden p-3 pt-0 sm:gap-4 sm:p-6 sm:pt-0',
  },
})
export class BasePowerDialog implements DialogData {
  protected readonly dialogRef = inject(DialogRef);
  protected readonly base = inject(Base);
  private readonly settingsStore = inject(SettingsStore);

  readonly header = 'base.powerHeader';

  /** Tab id: passed in from the overview, else the open tab */
  private readonly id =
    inject<string | null>(DIALOG_DATA, { optional: true }) ?? this.base.tab();

  readonly tab = computed(() =>
    this.base.state()?.tabs.find((t) => t.id === this.id),
  );
  readonly label = computed(() => {
    const tab = this.tab();
    return tab ? tabLabel(tab) : '';
  });
  readonly choice = computed(() => this.tab()?.power);

  readonly sourceOptions: Option[] = [
    { label: 'base.powerNone', value: NONE },
    ...POWER_SOURCES.map((s) => ({ label: `base.powerSource.${s}`, value: s })),
  ];

  readonly qualityOptions: Option<number>[] = QUALITY_LEVELS.map((q) => ({
    label: `base.quality.${q.id}`,
    value: q.level,
  }));

  readonly fuelOptions = computed((): Option[] => {
    const data = this.settingsStore.dataset();
    return Object.keys(this.base.fuels()).map((id) => ({
      label: data.itemRecord[id]?.name ?? id,
      value: id,
      icon: id,
      iconType: 'item',
    }));
  });

  readonly plan = computed(() => {
    const state = this.base.state();
    return state ? powerPlan(state, this.id, this.base.fuels()) : undefined;
  });

  readonly lines = computed(() => {
    const data = this.settingsStore.dataset();
    return (this.plan()?.buildings ?? []).map((b) => ({
      itemId: b.itemId,
      text: `${data.itemRecord[b.itemId]?.name ?? b.itemId} × ${b.count.toLocaleString()}`,
    }));
  });

  readonly fuel = computed(() => {
    const fuel = this.plan()?.fuel;
    if (!fuel) return undefined;
    const name =
      this.settingsStore.dataset().itemRecord[fuel.itemId]?.name ?? fuel.itemId;
    return { itemId: fuel.itemId, text: `${name} ${perMinute(fuel.rate)}` };
  });

  readonly summary = computed(() => this.base.state()?.summaries?.[this.id]);

  setSource(value: string): void {
    if (value === NONE) {
      this.base.setPower(this.id, undefined);
      return;
    }
    this.update({ source: value as PowerSource });
  }

  setQuality(quality: number): void {
    this.update({ quality });
  }

  setFuel(fuel: string): void {
    this.update({ fuel });
  }

  private update(change: Partial<TabPower>): void {
    const current: TabPower = this.choice() ?? {
      source: 'solar',
      quality: DEFAULT_POWER_QUALITY,
    };
    const next: TabPower = { ...current, ...change };
    if (next.source === 'heating-tower') next.fuel ??= DEFAULT_TOWER_FUEL;
    else delete next.fuel;
    this.base.setPower(this.id, next);
  }

  protected readonly NONE = NONE;
}
