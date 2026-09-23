import { describe, it, expectTypeOf } from 'vitest';
import type { SubagentParams, SingleResult, SubagentDetails, UsageStats } from '../src/types.js';

describe('types', () => {
  it('SubagentParams has correct optional fields', () => {
    expectTypeOf<SubagentParams>().toMatchTypeOf<{
      agent?: string;
      task?: string;
      tasks?: Array<{ agent: string; task: string; cwd?: string }>;
      chain?: Array<{ agent: string; task: string; cwd?: string }>;
      agentScope?: 'user' | 'project' | 'both';
      confirmProjectAgents?: boolean;
      cwd?: string;
    }>();
  });

  it('SingleResult carries agent + task + messages + usage', () => {
    expectTypeOf<SingleResult['agent']>().toEqualTypeOf<string>();
    expectTypeOf<SingleResult['task']>().toEqualTypeOf<string>();
    expectTypeOf<SingleResult['exitCode']>().toEqualTypeOf<number>();
    expectTypeOf<SingleResult['usage']>().toEqualTypeOf<UsageStats>();
  });

  it('SubagentDetails carries mode + results + agentScope', () => {
    expectTypeOf<SubagentDetails['mode']>().toEqualTypeOf<'single' | 'parallel' | 'chain'>();
    expectTypeOf<SubagentDetails['results']>().toEqualTypeOf<SingleResult[]>();
    expectTypeOf<SubagentDetails['agentScope']>().toEqualTypeOf<'user' | 'project' | 'both'>();
  });
});
