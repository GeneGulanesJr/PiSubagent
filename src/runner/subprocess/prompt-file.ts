import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { withFileMutationQueue } from '@earendil-works/pi-coding-agent';

/**
 * Write an agent's system prompt to a mode-0600 temp file for
 * `--append-system-prompt`. Caller owns cleanup of the returned dir.
 * On write failure, self-cleans its own tmpdir to avoid orphan leaks
 * and rethrows.
 */
export async function writePromptFile(
  agentName: string,
  prompt: string,
): Promise<{ dir: string; filePath: string }> {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pi-subagent-'));
  const safeName = agentName.replace(/[^\w.-]+/g, '_');
  const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
  try {
    await withFileMutationQueue(filePath, async () => {
      await fs.promises.writeFile(filePath, prompt, { encoding: 'utf-8', mode: 0o600 });
    });
    return { dir: tmpDir, filePath };
  } catch (err) {
    // Best-effort orphan cleanup; never mask the original error.
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    throw err;
  }
}
