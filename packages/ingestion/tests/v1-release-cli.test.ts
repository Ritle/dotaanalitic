import {it} from 'vitest';
import {runV1ReleaseCliScenario} from './v1-release-cli-scenario.js';
it('replays release evidence offline and cannot publish evaluation without its journal', () => runV1ReleaseCliScenario(), 90000);
it('replays the exact frozen manifest offline and refuses substitutions or publication without its journal',
  () => runV1ReleaseCliScenario(undefined, true), 90000);
