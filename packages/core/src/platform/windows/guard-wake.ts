/**
 * Ends the guard pump's wait from the main thread: a `WM_NULL` posted to the
 * pump's thread is input `MsgWaitForMultipleObjects` returns on. `user32.dll`
 * is opened on the first wake, which only comes after a Windows Worker said
 * where its pump runs.
 */
import { dlopen, FFIType } from 'bun:ffi';

const WM_NULL = 0x0000;

let postThreadMessage: ((threadId: number) => boolean) | null | undefined;

/** False when the message could not be posted: the pump then polls again. */
export function wakePump(threadId: number): boolean {
  if (postThreadMessage === undefined) {
    try {
      const user32 = dlopen('user32.dll', {
        PostThreadMessageW: { args: [FFIType.u32, FFIType.u32, FFIType.u64, FFIType.i64], returns: FFIType.i32 },
      }).symbols;
      postThreadMessage = (id: number): boolean => user32.PostThreadMessageW(id, WM_NULL, 0, 0) !== 0;
    } catch {
      postThreadMessage = null;
    }
  }
  return postThreadMessage?.(threadId) ?? false;
}
