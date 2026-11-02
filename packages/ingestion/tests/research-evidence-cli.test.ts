import { it } from 'vitest';
import { runEvidenceCliScenario } from './research-evidence-cli-scenario.js';
it('verifies evidence offline but requires a journal database before publishing evaluation', () => runEvidenceCliScenario(), 90000);
