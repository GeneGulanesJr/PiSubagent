import type { ChildProcess } from 'node:child_process';

/**
 * Kill `proc` when `signal` aborts: SIGTERM immediately, SIGKILL after 5s grace.
 * The grace timer is `.unref()`'d so it never keeps the event loop alive
 * after the runner has settled. If the signal is already aborted, kills
 * immediately.
 */
export function killOnAbort(proc: ChildProcess, signal: AbortSignal): void {
  const killProc = () => {
    proc.kill('SIGTERM');
    const sigkill = setTimeout(() => {
      if (!proc.killed) proc.kill('SIGKILL');
    }, 5000);
    sigkill.unref();
  };
  if (signal.aborted) killProc();
  else signal.addEventListener('abort', killProc, { once: true });
}
