/**
 * The inline script the build puts in index.html's head (`localePreload` in
 * vite.config.ts). Every language but English is a chunk of its own
 * (`lib/i18n.svelte.ts`), and the boot awaits the one the device speaks before
 * the first frame. This script starts that fetch beside the entry's, so a
 * French device does not pay a second round trip after the entry has run.
 *
 * It reads the setting the way `i18n.svelte.ts` does: the stored `boite.locale`,
 * or for `system` the first of the machine's languages this build carries.
 * Plain ES5, because it also runs on a browser too old for the app.
 */
export function localePreloadScript(chunks: Record<string, string>): string {
  const known = JSON.stringify(['en', ...Object.keys(chunks)]);
  return `(function(){try{var c=${JSON.stringify(chunks)},k=${known},s=null;` +
    `try{s=localStorage.getItem('boite.locale')}catch(e){}` +
    `if(k.indexOf(s)<0){s='en';var l=[].concat(navigator.languages||[],navigator.language);` +
    `for(var i=0;i<l.length;i++){if(typeof l[i]!=='string')continue;var b=l[i].trim().toLowerCase().split('-')[0];if(k.indexOf(b)>=0){s=b;break}}}` +
    `if(c[s]){var n=document.createElement('link');n.rel='modulepreload';n.href=c[s];document.head.appendChild(n)}}catch(e){}})()`;
}
