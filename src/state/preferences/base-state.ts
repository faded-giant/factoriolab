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
}

/** Several builds linked by shipments, e.g. one tab per planet */
export interface BaseState {
  tabs: BaseTab[];
  /** Tab id -> imported item id -> amount */
  imports?: Record<string, Record<string, TabImport>>;
  /** Tab id -> totals from its last solve */
  summaries?: Record<string, TabSummary>;
  updatedAt?: number;
}
