import * as fs from 'node:fs';
import * as path from 'node:path';

export interface PiInvocation {
  command: string;
  args: string[];
}

/**
 * Resolve how to invoke a child `pi` process.
 * - Prefer re-invoking the current entrypoint (process.execPath + current script).
 * - Fall back to bare `pi` on PATH for bun virtual filesystems or missing scripts.
 */
export function resolvePiInvocation(args: string[]): PiInvocation {
  const currentScript = process.argv[1];
  const isBunVirtual = currentScript?.startsWith('/$bunfs/root/');
  if (currentScript && !isBunVirtual && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args };
  }
  return { command: 'pi', args };
}
