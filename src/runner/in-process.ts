import type { AgentRunner, AgentRunInput } from './runner.js';
import type { SingleResult } from '../types.js';

/**
 * v2 placeholder backend. Exists so the AgentRunner seam is real from day one;
 * the spec defers the in-process implementation until the Aurex SDK pattern is
 * verified (see spec § In-Process Backend).
 */
export class InProcessRunner implements AgentRunner {
  readonly id = 'in-process' as const;

  async run(
    _input: AgentRunInput,
    _signal?: AbortSignal,
    _onUpdate?: (partial: SingleResult) => void,
  ): Promise<SingleResult> {
    throw new Error(
      'InProcessRunner is v2; not implemented in PiSubagent v1. See ' +
        '~/Documents/GulanesKorp/PiSubagent/docs/superpowers/specs/2026-09-08-pisubagent-design.md (In-Process Backend section)',
    );
  }
}
