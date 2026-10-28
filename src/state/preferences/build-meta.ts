/** Library details for a saved state, keyed like `PreferencesState.states` */
export interface BuildMeta {
  folder?: string;
  tags?: string[];
  notes?: string;
  /** Epoch ms of the last save */
  updatedAt?: number;
}
