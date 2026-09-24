import { AsyncLocalStorage } from 'node:async_hooks';
export const taskContext = new AsyncLocalStorage();
export function taskSignal(timeoutMs) {
  const signal = taskContext.getStore()?.signal;
  signal?.throwIfAborted();
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
}
export function assertTaskActive() { taskContext.getStore()?.signal.throwIfAborted(); }
