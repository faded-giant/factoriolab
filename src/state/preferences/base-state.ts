/** One planet (or platform) of a base, backed by a saved build */
export interface BaseTab {
  /** Name of the saved build shown in this tab */
  build: string;
  /** Imported item id -> build name of the tab that supplies it */
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
  /** Build name -> imported item id -> amount */
  imports?: Record<string, Record<string, TabImport>>;
  /** Build name -> totals from its last solve */
  summaries?: Record<string, TabSummary>;
  updatedAt?: number;
}
