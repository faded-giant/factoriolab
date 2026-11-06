import { DialogRef } from '@angular/cdk/dialog';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
} from '@angular/core';
import {
  faArrowUp,
  faRotateLeft,
  faXmark,
} from '@fortawesome/free-solid-svg-icons';

import { Base } from '~/base/base';
import {
  chunkRate,
  distance,
  estimateLap,
  SHATTERED_PLANET,
  SPACE_LOCATIONS,
} from '~/base/route';
import { Button } from '~/components/button/button';
import { DialogData } from '~/components/dialog/dialog';
import { Icon } from '~/components/icon/icon';
import { Select } from '~/components/select/select';
import { Tooltip } from '~/components/tooltip/tooltip';
import { Option } from '~/option/option';
import {
  PlatformRoute,
  RouteFill,
  RouteStop,
} from '~/state/preferences/base-state';
import { SettingsStore } from '~/state/settings/settings-store';
import { TranslatePipe } from '~/translate/translate-pipe';

interface StopRow {
  location: string;
  name: string;
  /** Whether the location has an icon */
  icon: boolean;
  wait?: number;
  /** km to the next stop, undefined if not connected */
  next?: number;
  nextName: string;
  /** Whether the next stop is the first, starting the next lap */
  last: boolean;
  /** Last stop equal to the first, which the route returns to anyway */
  repeatsFirst: boolean;
  /** The shattered planet, which a gatherer can turn back short of */
  canFill: boolean;
  fill?: RouteFill;
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
  private readonly settingsStore = inject(SettingsStore);

  readonly header = 'base.routeHeader';

  protected readonly faArrowUp = faArrowUp;
  protected readonly faRotateLeft = faRotateLeft;
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
    const names = this.names();
    return stops.map((s, i) => {
      const next = stops[(i + 1) % stops.length].location;
      const last = i === stops.length - 1;
      return {
        location: s.location,
        name: names.get(s.location) ?? s.location,
        icon: !(s.location in SPACE_LOCATIONS),
        wait: s.wait,
        next: distance(s.location, next),
        nextName: names.get(next) ?? next,
        last,
        repeatsFirst: last && i > 0 && s.location === stops[0].location,
        canFill: s.location === SHATTERED_PLANET,
        fill: s.fill,
      };
    });
  });

  private readonly names = computed(
    () =>
      new Map([
        ...this.base.planets().map((p): [string, string] => [p.id, p.name]),
        ...Object.entries(SPACE_LOCATIONS),
      ]),
  );

  readonly addOptions = computed((): Option[] => [
    ...this.base.planets().map(
      (p): Option => ({
        label: p.name,
        value: p.id,
        icon: p.id,
        iconType: 'location',
      }),
    ),
    ...Object.entries(SPACE_LOCATIONS).map(
      ([value, label]): Option => ({ label, value }),
    ),
  ]);

  /** One stop: the platform stays there, like a barge */
  readonly parked = computed(() => this.route().stops.length === 1);

  /** Changes after each pick, so the add select resets */
  protected readonly addKey = computed(() => this.route().stops.length);

  readonly estimate = computed(() => {
    const state = this.base.state();
    return estimateLap(this.route(), state ? chunkRate(state, this.id) : 0);
  });

  readonly qualityOptions = computed((): Option<number>[] => {
    const data = this.settingsStore.dataset();
    return data.qualityIds
      .map((id) => data.qualityRecord[id])
      .filter((q) => q != null)
      .map((q) => ({
        label: q.name,
        value: q.level,
        icon: q.id,
        iconType: 'quality',
      }));
  });

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

  /** Turns back when full with these defaults, or flies all the way again */
  toggleFill(index: number, on: boolean): void {
    this.setStops(
      this.route().stops.map((s, i) => {
        if (i !== index) return s;
        const { fill: _, ...rest } = s;
        return on ? { ...rest, fill: { collectors: 8, quality: 5 } } : rest;
      }),
    );
  }

  /** Sets one fill setting; undefined clears the turn back to automatic */
  setFill(index: number, field: keyof RouteFill, n: number | undefined): void {
    if (n == null && field !== 'chunks') return;
    this.setStops(
      this.route().stops.map((s, i) => {
        if (i !== index || !s.fill) return s;
        const fill: RouteFill = { ...s.fill, [field]: n };
        if (fill.chunks == null) delete fill.chunks;
        return { ...s, fill };
      }),
    );
  }

  /** Number typed in a fill field, or undefined if blank or invalid */
  fillValue(value: string): number | undefined {
    return toNumber(value);
  }

  setSpeed(value: string): void {
    this.base.setRoute(this.id, { ...this.route(), speed: toNumber(value) });
  }

  setLap(value: string): void {
    this.base.setRoute(this.id, { ...this.route(), lap: toNumber(value) });
  }

  minutes(seconds: number): string {
    return `${this.minutesValue(seconds / 60)} min`;
  }

  minutesValue(minutes: number): string {
    return Number(minutes.toFixed(1)).toString();
  }

  km(value: number): string {
    return `${value.toLocaleString()} km`;
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
