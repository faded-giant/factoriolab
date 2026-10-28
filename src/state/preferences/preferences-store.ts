import { DOCUMENT, effect, inject, Service } from '@angular/core';

import { Store } from '~/state/store';
import { applyBackgroundLightness, applyHue } from '~/utils/color';
import { log } from '~/utils/log';
import { spread } from '~/utils/object';
import { storedSignal, storeValue } from '~/utils/stored-signal';

import { StepDetailSection } from '../objectives/step-detail-section';
import { BuildMeta } from './build-meta';
import { initialPreferencesState, PreferencesState } from './preferences-state';

@Service()
export class PreferencesStore extends Store<PreferencesState> {
  private readonly document = inject(DOCUMENT);

  readonly stored = storedSignal('preferences');

  readonly bypassLanding = this.select('bypassLanding');
  readonly columns = this.select('columns');
  readonly convertObjectiveValues = this.select('convertObjectiveValues');
  readonly flowSettings = this.select('flowSettings');
  readonly language = this.select('language');
  readonly paused = this.select('paused');
  readonly powerUnit = this.select('powerUnit');
  readonly showTechLabels = this.select('showTechLabels');
  readonly states = this.select('states');
  readonly buildMeta = this.select('buildMeta');
  readonly theme = this.select('theme');
  readonly hue = this.select('hue');
  readonly chroma = this.select('chroma');
  readonly backgroundLightness = this.select('backgroundLightness');
  readonly pinObjectives = this.select('pinObjectives');
  readonly glpkAlgorithm = this.select('glpkAlgorithm');

  constructor() {
    super(initialPreferencesState, ['states', 'buildMeta', 'flowSettings']);
    const stored = this.stored();
    if (stored) {
      try {
        const storedState = JSON.parse(stored) as PreferencesState;
        this.load(storedState);
      } catch (ex) {
        console.warn('Failed to parse stored preferences', ex);
      }
    }

    effect(() => {
      storeValue('preferences', JSON.stringify(this.state()));
    });

    // Pick up changes from other tabs, so a stale tab cannot overwrite them
    window.addEventListener('storage', (event) => {
      if (event.key !== 'preferences' || !event.newValue) return;
      try {
        this.load(JSON.parse(event.newValue) as PreferencesState);
      } catch {
        // Ignore unreadable values
      }
    });

    effect(() => {
      const theme = this.theme();
      if (
        theme === 'light' ||
        (theme === 'system' &&
          window.matchMedia('(prefers-color-scheme: light)').matches)
      ) {
        this.document.documentElement.setAttribute('data-theme', 'light');
      } else {
        this.document.documentElement.removeAttribute('data-theme');
      }
    });

    effect(() => {
      const hue = this.hue();
      const chroma = this.chroma();
      applyHue(hue, chroma, 'brand', this.document.documentElement);
      applyHue(hue + 180, chroma, 'complement', this.document.documentElement);
    });

    effect(() => {
      applyBackgroundLightness(
        this.backgroundLightness(),
        this.document.documentElement,
      );
    });

    effect(() => {
      log('set_lang', this.language());
    });
  }

  saveState(modId: string, id: string, value: string): void {
    this.update((state) => {
      const gameStates = spread(state.states[modId], { [id]: value });
      const states = spread(state.states, { [modId]: gameStates });
      const meta = spread(state.buildMeta[modId]?.[id] ?? {}, {
        updatedAt: Date.now(),
      });
      const gameMeta = spread(state.buildMeta[modId], { [id]: meta });
      const buildMeta = spread(state.buildMeta, { [modId]: gameMeta });
      return { states, buildMeta };
    });
  }

  removeState(modId: string, id: string): void {
    this.update((state) => {
      const gameStates = this._removeEntry(state.states[modId], id);
      const states = spread(state.states, { [modId]: gameStates });
      const gameMeta = this._removeEntry(state.buildMeta[modId] ?? {}, id);
      const buildMeta = spread(state.buildMeta, { [modId]: gameMeta });
      return { states, buildMeta };
    });
  }

  /** Renames a saved state, keeping its library details */
  renameState(modId: string, from: string, to: string): void {
    if (from === to) return;
    this.update((state) => {
      const gameStates = this._removeEntry(state.states[modId], from);
      gameStates[to] = state.states[modId][from];
      const states = spread(state.states, { [modId]: gameStates });
      const gameMeta = this._removeEntry(state.buildMeta[modId] ?? {}, from);
      const meta = state.buildMeta[modId]?.[from];
      if (meta) gameMeta[to] = meta;
      const buildMeta = spread(state.buildMeta, { [modId]: gameMeta });
      return { states, buildMeta };
    });
  }

  updateBuildMeta(modId: string, id: string, partial: BuildMeta): void {
    this.update((state) => {
      const meta = spread(state.buildMeta[modId]?.[id] ?? {}, partial);
      const gameMeta = spread(state.buildMeta[modId], { [id]: meta });
      const buildMeta = spread(state.buildMeta, { [modId]: gameMeta });
      return { buildMeta };
    });
  }

  setSectionDefault(section: StepDetailSection, value: boolean): void {
    this.update((state) => {
      return spread(state, {
        sections: spread(state.sections, { [section]: value }),
      });
    });
  }
}
