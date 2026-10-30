import { DialogRef } from '@angular/cdk/dialog';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
} from '@angular/core';
import { faArrowUp, faXmark } from '@fortawesome/free-solid-svg-icons';

import { Base } from '~/base/base';
import { distance, estimateLap } from '~/base/route';
import { Button } from '~/components/button/button';
import { DialogData } from '~/components/dialog/dialog';
import { Icon } from '~/components/icon/icon';
import { Select } from '~/components/select/select';
import { Tooltip } from '~/components/tooltip/tooltip';
import { Option } from '~/option/option';
import { PlatformRoute, RouteStop } from '~/state/preferences/base-state';
import { TranslatePipe } from '~/translate/translate-pipe';

interface StopRow {
  location: string;
  name: string;
  wait?: number;
  /** km to the next stop, undefined if not connected */
  next?: number;
}

/** Edit the stops, waits and speed of the open platform tab */
@Component({
  selector: 'lab-base-route-dialog',
  imports: [Button, Icon, Select, Tooltip, TranslatePipe],
  templateUrl: './base-route-dialog.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class:
      'flex w-xl max-w-full flex-col gap-3 overflow-hidden p-3 pt-0 sm:gap-4 sm:p-6 sm:pt-0',
  },
})
export class BaseRouteDialog implements DialogData {
  protected readonly dialogRef = inject(DialogRef);
  protected readonly base = inject(Base);

  readonly header = 'base.routeHeader';

  protected readonly faArrowUp = faArrowUp;
  protected readonly faXmark = faXmark;

  private readonly id = this.base.tab();

  readonly route = computed(
    (): PlatformRoute =>
      this.base.state()?.tabs.find((t) => t.id === this.id)?.route ?? {
        stops: [],
      },
  );

  readonly stops = computed((): StopRow[] => {
    const stops = this.route().stops;
    const names = new Map(this.base.planets().map((p) => [p.id, p.name]));
    return stops.map((s, i) => ({
      location: s.location,
      name: names.get(s.location) ?? s.location,
      wait: s.wait,
      next:
        stops.length > 1
          ? distance(s.location, stops[(i + 1) % stops.length].location)
          : undefined,
    }));
  });

  readonly addOptions = computed((): Option[] =>
    this.base.planets().map((p) => ({
      label: p.name,
      value: p.id,
      icon: p.id,
      iconType: 'location',
    })),
  );

  /** Changes after each pick, so the add select resets */
  protected readonly addKey = computed(() => this.route().stops.length);

  readonly estimate = computed(() => estimateLap(this.route()));

  addStop(location: string | undefined): void {
    if (!location) return;
    this.setStops([...this.route().stops, { location }]);
  }

  removeStop(index: number): void {
    this.setStops(this.route().stops.filter((_, i) => i !== index));
  }

  moveUp(index: number): void {
    if (index < 1) return;
    const stops = [...this.route().stops];
    [stops[index - 1], stops[index]] = [stops[index], stops[index - 1]];
    this.setStops(stops);
  }

  setWait(index: number, value: string): void {
    const wait = toNumber(value);
    this.setStops(
      this.route().stops.map((s, i) => (i === index ? { ...s, wait } : s)),
    );
  }

  setSpeed(value: string): void {
    this.base.setRoute(this.id, { ...this.route(), speed: toNumber(value) });
  }

  setLap(value: string): void {
    this.base.setRoute(this.id, { ...this.route(), lap: toNumber(value) });
  }

  minutes(seconds: number): string {
    return `${Number((seconds / 60).toFixed(1)).toString()} min`;
  }

  private setStops(stops: RouteStop[]): void {
    this.base.setRoute(this.id, { ...this.route(), stops });
  }
}

/** Positive number typed in a field, or undefined if blank or invalid */
function toNumber(value: string): number | undefined {
  const n = Number(value);
  return value.trim() && Number.isFinite(n) && n > 0 ? n : undefined;
}
