import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

let promptText: string;

beforeAll(() => {
  const promptPath = path.resolve(process.cwd(), 'prompts/pisubagent-doctor.md');
  promptText = fs.readFileSync(promptPath, 'utf-8');
});

describe('/pisubagent-doctor prompt', () => {
  it('exists and is non-empty', () => {
    expect(promptText).toBeDefined();
    expect(promptText.length).toBeGreaterThan(0);
  });

  it('is under 150 lines', () => {
    const lineCount = promptText.split('\n').length;
    expect(lineCount).toBeLessThan(150);
  });

  describe('mentions all 6 diagnostic checks', () => {
    it('mentions Node version check', () => {
      // Catches "Node version" (check name) and tolerates either "node -v"
      // or "node --version" style phrasing within a few characters.
      expect(promptText).toMatch(/node.{0,8}(version|-v\b)/i);
    });

    it('mentions test suite run', () => {
      expect(promptText).toContain('npm test');
    });

    it('mentions agent discovery', () => {
      expect(promptText.toLowerCase()).toContain('agents');
    });

    it('mentions security audit', () => {
      expect(promptText).toContain('npm audit');
    });

    it('mentions settings registration', () => {
      expect(promptText).toContain('settings.json');
    });

    it('mentions a smoke test', () => {
      expect(promptText.toLowerCase()).toMatch(/smoke/);
    });
  });

  it('is read-only (instructs not to mutate)', () => {
    // Phrasing variants the prompt is allowed to use. The prompt must
    // somewhere forbid mutation so the LLM doesn't auto-fix issues.
    expect(promptText.toLowerCase()).toMatch(/read-only|do not modify|do not mutate/);
  });
});
