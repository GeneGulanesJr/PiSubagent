import type { ChildProcess } from 'node:child_process';

/**
 * Emit 'close' once a listener is attached. A real child's exit is always
 * observable by the parent (the runner subscribes synchronously after
 * spawn); the fake can fire close BEFORE subscription when real-fs awaits
 * (e.g. writePromptFile) delay spawn on slow machines — delivering then
 * would hang the run promise until the 60s test timeout (seen on CI
 * ubuntu/node22). Sticky delivery removes that race.
 */
export function emitCloseSticky(proc: ChildProcess, code: number | null): void {
  const fire = () => proc.emit('close', code);
  if (proc.listenerCount('close') > 0) {
    fire();
    return;
  }
  const timer = setInterval(() => {
    if (proc.listenerCount('close') > 0) {
      clearInterval(timer);
      fire();
    }
  }, 1);
  timer.unref();
}

/**
 * Poll until the runner has subscribed to 'close'. Throws (instead of
 * letting the test hang for 60s) when the runner never subscribes.
 */
export async function waitForCloseListener(proc: ChildProcess, maxMs = 5000): Promise<void> {
  const start = Date.now();
  while (proc.listenerCount('close') === 0) {
    if (Date.now() - start > maxMs) {
      throw new Error('runner never subscribed to close — spawn did not happen?');
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
