import { DialogRef } from '@angular/cdk/dialog';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';

import { Button } from '~/components/button/button';
import { DialogData } from '~/components/dialog/dialog';
import { Icon } from '~/components/icon/icon';
import { Select } from '~/components/select/select';
import { Tooltip } from '~/components/tooltip/tooltip';
import { baseId } from '~/data/schema/quality';
import { Option } from '~/option/option';
import {
  allQualities,
  moduleId,
  QUALITY_STRATEGIES,
  QualityStrategy,
  STRATEGY_MACHINES,
  strategyModules,
} from '~/quality/quality-strategy';
import { MachinesStore } from '~/state/machines/machines-store';
import { ObjectivesStore } from '~/state/objectives/objectives-store';
import { RecipesStore } from '~/state/recipes/recipes-store';
import { SettingsStore } from '~/state/settings/settings-store';
import { TranslatePipe } from '~/translate/translate-pipe';

/** Pick how quality is made, and set the build's modules to match */
@Component({
  selector: 'lab-quality-dialog',
  imports: [Button, Icon, Select, Tooltip, TranslatePipe],
  templateUrl: './quality-dialog.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class:
      'flex w-xl max-w-full flex-col gap-3 overflow-hidden p-3 pt-0 sm:gap-4 sm:p-6 sm:pt-0',
  },
})
export class QualityDialog implements DialogData {
  protected readonly dialogRef = inject(DialogRef);
  private readonly machinesStore = inject(MachinesStore);
  private readonly objectivesStore = inject(ObjectivesStore);
  private readonly recipesStore = inject(RecipesStore);
  private readonly settingsStore = inject(SettingsStore);

  readonly header = 'quality.header';

  protected readonly strategies = QUALITY_STRATEGIES;
  protected readonly strategy = signal<QualityStrategy>('upcycle');
  protected readonly tier = signal(3);
  /** Highest quality unlocked, for the modules themselves */
  protected readonly maxQuality = computed(
    () => this.settingsStore.settings().quality?.level ?? 0,
  );
  protected readonly quality = signal(this.maxQuality());
  protected readonly resetRecipes = signal(true);

  protected readonly qualityOptions = computed((): Option<number>[] => {
    const data = this.settingsStore.dataset();
    return data.qualityIds
      .map((id) => data.qualityRecord[id])
      .filter((q) => q != null && q.level <= this.maxQuality())
      .map((q) => ({
        label: q.name,
        value: q.level,
        icon: q.id,
        iconType: 'quality',
      }));
  });

  protected readonly tierOptions = computed((): Option<number>[] => {
    const data = this.settingsStore.dataset();
    return [1, 2, 3].flatMap((tier) => {
      const id = moduleId(data, 'quality', tier, 0);
      return id
        ? [{ label: data.itemRecord[id].name, value: tier, icon: id }]
        : [];
    });
  });

  /** Machines the build uses, plus recyclers and crushers */
  private readonly machineIds = computed(() => {
    const used = this.objectivesStore
      .steps()
      .map((s) => s.recipeSettings?.machineId)
      .filter((id): id is string => id != null);
    return allQualities(this.settingsStore.dataset(), [
      ...used,
      ...STRATEGY_MACHINES,
    ]);
  });

  /** What applying would set, one line per machine kind and module */
  protected readonly preview = computed(() => {
    const data = this.settingsStore.dataset();
    const modules = strategyModules(data, this.machineIds(), {
      strategy: this.strategy(),
      tier: this.tier(),
      quality: this.quality(),
    });
    const lines = new Map<string, { machine: string; module: string }>();
    for (const [machine, [m]] of Object.entries(modules)) {
      // One line per machine; its other qualities get the same
      if (!m.id || baseId(machine) !== machine) continue;
      lines.set(machine, { machine, module: m.id });
    }
    return { modules, lines: [...lines.values()] };
  });

  apply(): void {
    if (this.resetRecipes()) this.recipesStore.resetFields('modules');
    for (const [id, modules] of Object.entries(this.preview().modules))
      this.machinesStore.updateRecord(id, { modules });
    this.dialogRef.close();
  }

  clear(): void {
    for (const id of this.machineIds())
      this.machinesStore.removeRecordFields(id, 'modules');
    this.dialogRef.close();
  }
}
