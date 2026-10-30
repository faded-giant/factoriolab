/** A stop on a platform's route */
export interface RouteStop {
  /** Location id, e.g. 'fulgora' */
  location: string;
  /** Seconds spent in orbit before leaving */
  wait?: number;
}

/** Where a platform flies, to estimate how long a lap takes */
export interface PlatformRoute {
  /** In order; the platform returns to the first after the last */
  stops: RouteStop[];
  /** Cruise speed in km/s, as shown on the platform hub */
  speed?: number;
  /** Minutes per lap, used instead of the estimate */
  lap?: number;
}

/** One planet (or platform) of a base, backed by a saved build */
export interface BaseTab {
  /** Stable key used by links, imports and summaries */
  id: string;
  /** Shown in the tab bar; falls back to the build name */
  label?: string;
  /** Location id the tab is limited to, e.g. 'fulgora' or 'space-platform' */
  location?: string;
  /** Name of the saved build behind this tab, once it has been created */
  build?: string;
  /** Imported item id -> id of the tab that supplies it */
  links?: Record<string, string>;
  /** Imported item id -> id of the platform tab that carries it */
  via?: Record<string, string>;
  /** For platform tabs */
  route?: PlatformRoute;
  /**
   * Export amounts (item id -> items per second) last written into this tab's
   * objectives, used to find and update those objectives later
   */
  applied?: Record<string, string>;
}

/** What a tab needs from elsewhere, from its last solve */
export interface TabImport {
  /** Items per second */
  rate: string;
  /** Rocket launches per minute to ship it, if the game has rockets */
  rockets?: string;
}

export interface TabSummary {
  buildings: string;
  /** kW */
  power: string;
  /** Rocket silos the build needs to keep up, if any */
  silos?: string;
}

/** Several builds linked by shipments, e.g. one tab per planet */
export interface BaseState {
  tabs: BaseTab[];
  /** Tab id -> imported item id -> amount */
  imports?: Record<string, Record<string, TabImport>>;
  /** Tab id -> totals from its last solve */
  summaries?: Record<string, TabSummary>;
  /**
   * Whether each silo counts for two rockets when a platform arrives: the one
   * waiting, and the next one whose parts are already made
   */
  secondRocket?: boolean;
  updatedAt?: number;
}
