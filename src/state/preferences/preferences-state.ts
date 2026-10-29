import { Theme } from '~/state/preferences/theme';
import { Language } from '~/translate/language';

import { StepDetailSection } from '../objectives/step-detail-section';
import { BaseState } from './base-state';
import { BuildMeta } from './build-meta';
import { ColumnsState, initialColumnsState } from './columns-state';
import { FlowSettings, initialFlowSettings } from './flow-settings';
import { GlpkAlgorithm } from './glpk-algorithm';
import { PowerUnit } from './power-unit';

export interface PreferencesState {
  states: Record<string, Record<string, string>>;
  buildMeta: Record<string, Record<string, BuildMeta>>;
  /** Mod id -> base name -> linked builds */
  bases: Record<string, Record<string, BaseState>>;
  columns: ColumnsState;
  language: Language;
  powerUnit: PowerUnit;
  hue: number;
  chroma: number;
  backgroundLightness?: number;
  theme: Theme;
  bypassLanding: boolean;
  showTechLabels: boolean;
  pinObjectives: boolean;
  /** Write edits back into the open saved build automatically */
  autosave: boolean;
  paused: boolean;
  convertObjectiveValues: boolean;
  glpkAlgorithm: GlpkAlgorithm;
  flowSettings: FlowSettings;
  sections: Record<StepDetailSection, boolean>;
}

export const initialPreferencesState: PreferencesState = {
  states: {},
  buildMeta: {},
  bases: {},
  columns: initialColumnsState,
  language: 'en',
  powerUnit: PowerUnit.Auto,
  hue: 256,
  chroma: 100,
  theme: 'system',
  bypassLanding: false,
  showTechLabels: false,
  pinObjectives: false,
  autosave: true,
  paused: false,
  convertObjectiveValues: false,
  glpkAlgorithm: 'simplex',
  flowSettings: initialFlowSettings,
  sections: {
    sources: true,
    destinations: true,
    depletion: true,
    inputs: true,
    outputs: true,
  },
};
