/*
 * Inline views: an HTML page an agent publishes with `boite view`, drawn in
 * the conversation at the end of its answer. The core stores the page as an
 * artifact with the bootstrap below at the start of its head; a client shows
 * it in a sandboxed frame and hands it the app's theme. Everything the core
 * and the clients must agree on is here: the route, the content policy, the
 * messages across the frame and what the agent is told.
 */

/** Where a view ticket opens as a page. A file ticket never does: `FILE_ROUTE` only downloads. */
export const VIEW_ROUTE = '/view';
/** The page with its local files embedded. Above it the publish is refused. */
export const VIEW_MAX_BYTES = 4 * 1024 * 1024;
/**
 * The widths a page is measured at when it is published: the answer column on
 * a desktop (`--content` less its 4 px rest), then on a 390 px phone.
 */
export const VIEW_WIDTH = 816;
export const VIEW_NARROW_WIDTH = 330;
/** A frame narrower than this takes the phone measurement. */
export const VIEW_NARROW_BELOW = 520;
export const VIEW_MIN_HEIGHT = 24;
export const VIEW_MAX_HEIGHT = 2400;
/** The room kept for a page nobody measured, until it says its own height. */
export const VIEW_DEFAULT_HEIGHT = 320;
export const VIEW_TITLE_MAX = 120;

/** What an artifact part carries when it is a view: enough to keep its room before the page loads. */
export interface InlineView {
  title: string;
  /** The page's height in CSS pixels at `VIEW_WIDTH`. */
  height: number;
  /** The same at `VIEW_NARROW_WIDTH`, when the page was measured. */
  narrowHeight?: number;
  /**
   * The file it was published from, relative to the working directory. A later
   * view of the same turn from the same file replaces this one on screen.
   */
  source?: string;
}

export function clampViewHeight(height: number): number {
  return Math.min(VIEW_MAX_HEIGHT, Math.max(VIEW_MIN_HEIGHT, Math.round(height)));
}

/** The frame's height at `width`: what the page reported, else what the core measured for that width. */
export function viewFrameHeight(view: InlineView, width: number, reported?: number): number {
  if (reported !== undefined && Number.isFinite(reported) && reported > 0) return clampViewHeight(reported);
  return clampViewHeight(width > 0 && width < VIEW_NARROW_BELOW && view.narrowHeight ? view.narrowHeight : view.height);
}

/**
 * The page loads nothing and calls nothing: scripts and styles are its own,
 * images, media and fonts are embedded. A client's frame adds the sandbox; the
 * route sends both, and the same policy rides in the document so a saved copy
 * keeps it.
 */
export const VIEW_CONTENT_POLICY = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; form-action 'none'; base-uri 'none'";
/** Scripts run on an opaque origin: no storage, no cookie, no reach into the app that frames the page. */
export const VIEW_SANDBOX = 'allow-scripts';

/** The app's tokens a view may style with, read from the client's own stylesheet when the frame mounts. */
export const VIEW_TOKENS = [
  '--color-background', '--color-surface', '--color-surface-2', '--color-surface-3',
  '--color-border', '--color-edge',
  '--color-foreground', '--color-muted-foreground', '--color-subtle',
  '--color-accent', '--color-accent-soft', '--color-accent-ink',
  '--color-success', '--color-live', '--color-danger',
  '--series-1', '--series-2', '--series-3', '--series-4', '--series-5', '--series-6', '--series-7', '--series-8',
  '--radius-sm', '--radius-md', '--radius-lg',
  '--font-sans', '--font-mono',
  '--text-xs', '--text-sm', '--text-reading', '--leading-reading',
] as const;

export interface ViewTheme {
  scheme: 'dark' | 'light';
  vars: Record<string, string>;
  /** The reader asked for less motion: CSS animations end at once and the page is told. */
  reduced?: boolean;
}

const THEME_KEY = 'boite-view';

/** The fragment that themes a page before its first paint. The bootstrap reads it, then drops it. */
export function viewThemeFragment(theme: ViewTheme): string {
  return `#${THEME_KEY}=${encodeURIComponent(JSON.stringify(theme))}`;
}

/** What a client posts into a mounted frame. */
export type ViewHostMessage =
  | { boiteView: 1; type: 'theme'; theme: ViewTheme }
  /** One face of the app's own font, as bytes: the page cannot fetch it. */
  | { boiteView: 1; type: 'font'; family: string; data: ArrayBuffer; descriptors: { weight?: string; style?: string; unicodeRange?: string } };

/** What a page's bootstrap posts to the client that frames it. */
export type ViewPageMessage =
  | { type: 'size'; height: number }
  | { type: 'link'; url: string }
  | { type: 'ready' };

export function readViewMessage(data: unknown): ViewPageMessage | null {
  if (typeof data !== 'object' || data === null) return null;
  const { boiteView, type, height, url } = data as Record<string, unknown>;
  if (boiteView !== 1) return null;
  if (type === 'size') return typeof height === 'number' && Number.isFinite(height) && height > 0 ? { type, height } : null;
  if (type === 'link') return typeof url === 'string' && /^https?:\/\//i.test(url) ? { type, url } : null;
  return type === 'ready' ? { type } : null;
}

/**
 * The app's look for a bare page: the answer's own text size and face, and
 * controls, tables and code drawn as the app draws them. Every rule is under
 * `:where()`, so anything the page says about the same element wins. It is
 * built when a page is stored, like the bootstrap below: a client's bundle,
 * which stores none, then carries neither.
 */
const baseCss = (): string => [
  'html{background:transparent;color:var(--color-foreground);font-family:var(--font-sans);font-size:var(--text-reading);line-height:var(--leading-reading);-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%;scrollbar-width:none}',
  'html::-webkit-scrollbar{display:none}',
  ':where(body){margin:0}',
  ':where(h1,h2,h3,h4){margin:0 0 .5em;font-weight:600;line-height:1.3}',
  ':where(h1){font-size:1.3em}:where(h2){font-size:1.15em}:where(h3,h4){font-size:1em}',
  ':where(p){margin:0 0 .75em}:where(p:last-child){margin-bottom:0}',
  ':where(a){color:var(--color-accent)}',
  ':where(small,figcaption,label){color:var(--color-muted-foreground);font-size:var(--text-sm)}',
  ':where(figure){margin:0}',
  ':where(code,kbd,pre,samp){font-family:var(--font-mono);font-size:.92em}',
  ':where(pre){margin:0 0 .75em;padding:10px 12px;border-radius:var(--radius-md);background:var(--color-surface-2);overflow:auto}',
  ':where(table){width:100%;border-collapse:collapse;font-size:var(--text-sm)}',
  ':where(th,td){padding:6px 10px;border-bottom:1px solid var(--color-border);text-align:left}',
  ':where(th){color:var(--color-muted-foreground);font-weight:500}',
  ':where(hr){margin:12px 0;border:0;border-top:1px solid var(--color-border)}',
  ':where(button,select,input:not([type=range],[type=checkbox],[type=radio],[type=color])){height:30px;padding:0 12px;border:1px solid var(--color-border);border-radius:var(--radius-md);background:var(--color-surface-2);color:var(--color-foreground);font:inherit;font-size:var(--text-sm)}',
  ':where(button){cursor:pointer}:where(button:hover){background:var(--color-surface-3)}:where(button:disabled){opacity:.5;cursor:default}',
  ':where(input[type=range],input[type=checkbox],input[type=radio],progress){accent-color:var(--color-accent)}',
  ':where(button,select,input):focus-visible{outline:2px solid var(--color-accent);outline-offset:2px}',
  ':where(svg){max-width:100%;overflow:visible}:where(svg text){fill:currentColor;font-family:inherit}',
].join('');

const REDUCED_CSS = '*,*::before,*::after{animation-duration:.001ms!important;animation-iteration-count:1!important;transition-duration:.001ms!important}';

/** A saved copy opened by itself, and the headless check, have no client to theme them: the app's two palettes, by the system's scheme. */
const DARK = '--color-background:#101013;--color-surface:#151518;--color-surface-2:#1b1b1f;--color-surface-3:#232327;--color-border:rgba(255,255,255,.07);--color-edge:rgba(255,255,255,.14);--color-foreground:#ececf1;--color-muted-foreground:#a2a2ad;--color-subtle:#8c8c96;--color-accent:oklch(68% .19 260);--color-accent-soft:oklch(68% .19 260/.18);--color-accent-ink:#101013;--color-success:#4ade80;--color-live:#eab308;--color-danger:#f0716f;--series-1:#d95926;--series-2:#3987e5;--series-3:#199e70;--series-4:#9085e9;--series-5:#c98500;--series-6:#d55181;--series-7:#008300;--series-8:#e66767;';
const LIGHT = '--color-background:#f3f3f6;--color-surface:#fafafb;--color-surface-2:#fff;--color-surface-3:#ebebef;--color-border:rgba(0,0,0,.08);--color-edge:rgba(0,0,0,.16);--color-foreground:#1c1c21;--color-muted-foreground:#50505a;--color-subtle:#67676f;--color-accent-ink:#fff;--color-success:#16a34a;--color-live:#ca8a04;--color-danger:#dc2626;--series-1:#eb6834;--series-2:#2a78d6;--series-3:#18a070;--series-4:#4a3aa7;--series-5:#bf8200;--series-6:#e26092;--series-7:#008300;--series-8:#e34948;';
const SHAPE = "--radius-sm:6px;--radius-md:8px;--radius-lg:12px;--font-sans:ui-sans-serif,system-ui,'Segoe UI',sans-serif;--font-mono:ui-monospace,'Cascadia Mono',Consolas,monospace;--text-xs:12px;--text-sm:13px;--text-reading:15px;--leading-reading:1.6;";
const defaultCss = (): string => `:root{color-scheme:dark;${DARK}${SHAPE}}@media (prefers-color-scheme:light){:root{color-scheme:light;${LIGHT}}}${baseCss()}`;

/*
 * Runs in the head before the page's own styles and scripts. It writes the
 * theme into its own <style>, so a later rule of the page still wins; drops
 * the fragment, so a page's own hash never sees it; reports the content
 * height the way the core measures it; and hands a clicked link to the client
 * instead of letting it replace the page inside the conversation.
 */
const bootstrap = (): string => `(function(){var s=document.getElementById("boite-view-theme"),r=document.documentElement,b=${JSON.stringify(baseCss())},q=${JSON.stringify(REDUCED_CSS)},last=0;` +
  'function post(t,d){if(window.parent===window)return;d.boiteView=1;d.type=t;window.parent.postMessage(d,"*");}' +
  'function apply(t){if(!s||!t||typeof t!=="object"||!t.vars||typeof t.vars!=="object")return;var c=":root{color-scheme:"+(t.scheme==="light"?"light":"dark")+";",k;for(k in t.vars){if(/^--[a-z0-9-]+$/.test(k))c+=k+":"+String(t.vars[k]).replace(/[;{}<>]/g,"")+";";}s.textContent=c+"}"+b+(t.reduced?q:"");if(t.reduced)r.setAttribute("data-reduced-motion","");else r.removeAttribute("data-reduced-motion");}' +
  `try{var m=/[#&]${THEME_KEY}=([^&]*)/.exec(location.hash);if(m){apply(JSON.parse(decodeURIComponent(m[1])));history.replaceState(history.state,"",location.pathname+location.search);}}catch(e){}` +
  'function size(){var h=Math.ceil(r.scrollHeight>r.clientHeight?r.scrollHeight:r.getBoundingClientRect().height);if(h>0&&h!==last){last=h;post("size",{height:h});}}' +
  'window.addEventListener("message",function(e){var d=e.data;if(!d||d.boiteView!==1||e.source!==window.parent)return;if(d.type==="theme")apply(d.theme);if(d.type==="font"&&window.FontFace&&d.data){try{var f=new FontFace(String(d.family),d.data,d.descriptors||{});document.fonts.add(f);f.load().then(size,size);}catch(x){}}});' +
  'document.addEventListener("click",function(e){var p=e.composedPath?e.composedPath():[],l=null,i,h,u;for(i=0;i<p.length;i++){if(p[i]&&p[i].tagName&&/^a$/i.test(p[i].tagName)&&(p[i].getAttribute("href")!==null||p[i].getAttribute("xlink:href")!==null)){l=p[i];break;}}if(!l)return;h=l.getAttribute("href")||l.getAttribute("xlink:href")||"";if(h.charAt(0)==="#")return;e.preventDefault();try{u=new URL(h,document.baseURI);}catch(x){return;}if(e.isTrusted&&/^https?:$/.test(u.protocol))post("link",{url:u.href});},true);' +
  'if(window.ResizeObserver){var o=new ResizeObserver(size);o.observe(r);document.addEventListener("DOMContentLoaded",function(){if(document.body)o.observe(document.body);size();});}else document.addEventListener("DOMContentLoaded",size);' +
  'window.addEventListener("load",function(){size();post("ready",{});});})();';

/** The same measure the bootstrap posts, for the core's headless check. */
export const VIEW_HEIGHT_EXPRESSION = '(function(){var r=document.documentElement;return Math.ceil(r.scrollHeight>r.clientHeight?r.scrollHeight:r.getBoundingClientRect().height);})()';

/** Comments and raw-text elements blanked to the same length: offsets still line up and a tag written inside a script is never taken for the page's. */
function markupOnly(html: string): string {
  return html.replace(
    /<!--[\s\S]*?(?:-->|$)|<(script|style|textarea|title|xmp|noscript|template)\b[\s\S]*?(?:<\/\1\s*>|$)/gi,
    (match) => ' '.repeat(match.length),
  );
}

/**
 * The page as it is stored: the policy, the theme and the bootstrap at the
 * very start of its head, on the line the head opens on, so a script error
 * still names the line of the agent's own file.
 */
export function viewDocument(html: string): string {
  const scan = markupOnly(html);
  const head = [
    /<meta\s[^>]*charset/i.test(scan.slice(0, 4096)) ? '' : '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${VIEW_CONTENT_POLICY}">`,
    /<meta\s[^>]*name\s*=\s*["']?viewport/i.test(scan) ? '' : '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<style id="boite-view-theme">${defaultCss()}</style>`,
    `<script>${bootstrap()}</script>`,
  ].join('');
  // Standards mode whatever the file says: in quirks mode the root is as tall as its frame, and the page could never say its own height.
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  const lead = doctype ? '' : '<!doctype html>';
  const opened = /<head(?:\s[^>]*)?>/i.exec(scan);
  if (opened) return lead + html.slice(0, opened.index + opened[0].length) + head + html.slice(opened.index + opened[0].length);
  const root = /<html(?:\s[^>]*)?>/i.exec(scan);
  if (root) return `${lead}${html.slice(0, root.index + root[0].length)}<head>${head}</head>${html.slice(root.index + root[0].length)}`;
  if (doctype) return `${doctype[0]}<head>${head}</head>${html.slice(doctype[0].length)}`;
  return `<!doctype html><head>${head}</head>${html}`;
}

/** The page's own `<title>`, when it has one. */
export function viewTitleOf(html: string): string | null {
  const found = /<title(?:\s[^>]*)?>([\s\S]*?)<\/title\s*>/i.exec(html.replace(/<!--[\s\S]*?(?:-->|$)|<(script|style)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, ''));
  const title = found?.[1]?.replace(/\s+/g, ' ').trim() ?? '';
  return title ? title.slice(0, VIEW_TITLE_MAX) : null;
}

/** One line in the guide every agent reads when its session starts. */
export const VIEW_GUIDE_LINE = '`boite view <file.html>` draws an HTML page under your answer: diagram, chart, animated SVG, simulator. Use it when asked for a visual or a schema, or when a picture explains better than text. Read `boite view help` first.';

/** `boite view help`: everything an agent needs to write a page that looks like part of the app. */
export const VIEW_HELP = `boite view <file.html> [--title <text>]   draw the page at the end of your answer

Write one HTML file per visual, for instance .boite/views/orbit.html, then run
\`boite view\` on it. The user sees it under your final text once your turn ends,
so write the answer as if the visual were already under it: do not announce it,
say where it is, or repeat what it shows.

Several visuals: one file each and one command each. They stack in the order
you published them. Running the command again on the same file in the same
turn replaces that visual, so fix a page in place instead of making a copy.
Split what is read separately; keep in one page what is compared side by side
or driven by the same controls.

The page
- Self-contained: inline <style> and <script>. A local file named by a
  relative path (image, font, script, stylesheet) is embedded when you publish.
  Nothing remote loads: no CDN, no web font, no fetch. Draw with SVG, canvas
  or plain HTML, or point at a library already on disk.
- It sits on the conversation's own background, as wide as the answer: about
  ${VIEW_WIDTH}px on a desktop, ${VIEW_NARROW_WIDTH}px on a phone. Leave html and body without a
  background. No outer card, border, page title or horizontal padding on the
  outermost element: the page is part of your answer.
- A box that must stand apart (a mock screen, a panel) takes
  var(--color-surface), a 1px var(--color-border) line, var(--radius-lg)
  corners and at least 16px of padding.
- Let the content set the height: no 100vh, no height:100% on html or body.
  Give a chart or an animation stage a fixed pixel height or an aspect-ratio.
- It must hold at ${VIEW_NARROW_WIDTH}px: fluid widths, and SVG with a viewBox and width:100%.
- Text, headings, buttons, sliders, inputs, tables and code already look like
  the app. Style only what is specific to your visual.

Theme: CSS variables on :root, following the user's theme live
  --color-foreground --color-muted-foreground --color-subtle    text
  --color-surface --color-surface-2 --color-surface-3           raised boxes
  --color-border --color-edge                                   lines
  --color-accent --color-accent-soft --color-accent-ink         the user's accent
  --color-success --color-live --color-danger                   states
  --series-1 to --series-8                                      chart series
  --radius-sm --radius-md --radius-lg
  --font-sans --font-mono --text-xs --text-sm
Never write a fixed color for text, lines or surfaces. In SVG use
fill="currentColor" or style="stroke:var(--series-1)".

Motion
- Animate with requestAnimationFrame or CSS. It starts when the page loads,
  and the user can replay it from the frame.
- A simulator carries its own controls in the page: play and pause, a slider
  per parameter, the current values written out.
- When the user asked for less motion (prefers-reduced-motion, or the
  data-reduced-motion attribute on <html>), draw the end state and move only
  on a control.

The check at publish
The page is loaded once in a headless browser before anything is shown. A
script error, a console.error, a remote resource or an unreadable local file
refuses the publish and prints the reason with its line: fix the file and run
the command again. The user never sees a page that failed.
`;
