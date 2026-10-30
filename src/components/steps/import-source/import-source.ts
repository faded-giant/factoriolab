import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
} from '@angular/core';

import { Base, OVERVIEW } from '~/base/base';
import { Option } from '~/option/option';
import { SettingsStore } from '~/state/settings/settings-store';

import { Select } from '../../select/select';

/** On a base tab, picks which tab supplies an excluded (imported) item */
@Component({
  selector: 'lab-import-source',
  imports: [Select],
  templateUrl: './import-source.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex items-center' },
})
export class ImportSource {
  protected readonly base = inject(Base);
  private readonly settingsStore = inject(SettingsStore);

  readonly itemId = input.required<string>();

  protected readonly show = computed(
    () =>
      this.base.state() != null &&
      this.base.tab() !== OVERVIEW &&
      this.settingsStore.settings().excludedItemIds.has(this.itemId()),
  );

  protected readonly options = computed((): Option[] =>
    this.base.sourceOptions(this.base.tab()),
  );

  protected readonly source = computed(
    () =>
      this.base.state()?.tabs.find((t) => t.id === this.base.tab())?.links?.[
        this.itemId()
      ] ?? '',
  );

  protected readonly showVia = computed(
    () =>
      !!this.source() && this.base.canShipVia(this.base.tab(), this.itemId()),
  );

  protected readonly viaOptions = computed(() => this.base.viaOptions());

  protected readonly via = computed(
    () =>
      this.base.state()?.tabs.find((t) => t.id === this.base.tab())?.via?.[
        this.itemId()
      ] ?? '',
  );

  setSource(source: string | undefined): void {
    this.base.setLink(this.base.tab(), this.itemId(), source || null);
  }

  setVia(platform: string | undefined): void {
    this.base.setVia(this.base.tab(), this.itemId(), platform || null);
  }
}
