/**
 * What a phone's page tells the navigation around it. A page that opens a
 * conversation of its own, as Agents does, sets `detail` while it shows one:
 * the bottom bar steps aside for its composer, as it does for a thread.
 */
export const mobileChrome = $state({ detail: false });
