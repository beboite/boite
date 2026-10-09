/**
 * What this client says it runs on (`hello` `client.device`), so an agent
 * knows where a prompt came from. The shell names the computer with the name
 * its own core reported: a remote core cannot see it. Until that core has
 * said hello the shell says nothing, and the core on this machine fills in
 * its own name. The web app says `phone` on a touch screen, `browser` otherwise.
 */
let computer: string | null = null;

/** The shell's own core answered hello: its hostname is this computer's. */
export function noteThisComputer(hostname: string | undefined): void {
  if (hostname) computer = hostname;
}

/**
 * The primary pointer is coarse: the question the app's touch rules ask.
 * Its keyboard has no Shift+Enter, so the composer's Enter writes a new line
 * there. An engine with no `matchMedia` is not one, so the composer keeps
 * Enter's send. `hasKeyboard` in `live-input.ts` asks this same question but
 * deliberately defaults the other way there, keeping the live view's
 * on-screen controls.
 */
export function touchScreen(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
}

export function deviceLabel(): string | null {
  if (window.__TAURI_INTERNALS__ !== undefined) return computer;
  return touchScreen() || /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) ? 'phone' : 'browser';
}
