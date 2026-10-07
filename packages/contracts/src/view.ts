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
  '--color-border', '--color-edge', '--color-hover', '--color-active',
  '--color-foreground', '--color-muted-foreground', '--color-subtle',
  '--color-accent', '--color-accent-soft', '--color-accent-ink',
  '--color-success', '--color-live', '--color-danger',
  '--series-1', '--series-2', '--series-3', '--series-4', '--series-5', '--series-6', '--series-7', '--series-8',
  '--radius-sm', '--radius-md', '--radius-lg',
  '--font-sans', '--font-mono',
  '--text-xs', '--text-sm', '--text-base', '--text-md', '--text-lg', '--text-reading', '--leading-reading',
  // What the kit draws the app's own controls with.
  '--control', '--control-sm', '--input', '--control-glaze', '--color-control-surface', '--color-control-hover', '--color-reasoning-on',
  '--shadow-e1', '--shadow-e2',
  '--dur-1', '--dur-2', '--dur-3', '--ease-out-quint',
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
 * The kit: the app's look for a page. Bare elements are drawn as the app
 * draws its own (text, buttons, the slider, the switch, tables, code), and a
 * few classes give the pieces a visual is usually made of: layout, a raised
 * box, labels, a stat, a legend, strokes and fills in the series colors.
 * Every rule is under `:where()`, so anything the page says about the same
 * element wins: the kit is where a page starts, never a limit on it.
 * `VIEW_HELP` lists it for the agent. It is put together when a page is
 * stored, not when the module loads.
 */
const baseCss = (): string => [
  // The page: the answer's own text, on the conversation's own background.
  'html{background:transparent;color:var(--color-foreground);font-family:var(--font-sans);font-size:var(--text-reading);line-height:var(--leading-reading);-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%;scrollbar-width:none}',
  'html::-webkit-scrollbar{display:none}',
  ':where(*,*::before,*::after){box-sizing:border-box}',
  ':where(body){margin:0}',
  // Text.
  ':where(h1,h2,h3,h4){margin:0 0 .5em;font-weight:600;line-height:1.3}',
  ':where(h1){font-size:var(--text-lg)}:where(h2){font-size:var(--text-md)}:where(h3,h4){font-size:var(--text-reading)}',
  ':where(p){margin:0 0 .75em}:where(p:last-child){margin-bottom:0}',
  ':where(a){color:var(--color-accent);text-underline-offset:3px}',
  ':where(small,figcaption,label,summary){color:var(--color-muted-foreground);font-size:var(--text-sm)}',
  ':where(figure){margin:0}:where(figcaption){margin-top:8px}:where(summary){cursor:pointer}',
  ':where(hr){margin:16px 0;border:0;border-top:1px solid var(--color-border)}',
  ':where(code,kbd,pre,samp,output){font-family:var(--font-mono);font-size:.92em;font-variant-numeric:tabular-nums}',
  ':where(code){padding:1px 5px;border-radius:var(--radius-sm);background:var(--color-surface-2)}',
  ':where(pre){margin:0 0 .75em;padding:10px 12px;border:1px solid var(--color-border);border-radius:var(--radius-md);background:var(--color-surface-2);overflow:auto}:where(pre code){padding:0;background:none}',
  ':where(kbd){padding:0 5px;border:1px solid var(--color-edge);border-bottom-width:2px;border-radius:var(--radius-sm);background:var(--color-surface-2);color:var(--color-muted-foreground);font-size:var(--text-xs);line-height:18px}',
  ':where(table){width:100%;border-collapse:collapse;font-size:var(--text-sm)}',
  ':where(th,td){padding:7px 10px;border-bottom:1px solid var(--color-border);text-align:left;vertical-align:top}',
  ':where(th){color:var(--color-muted-foreground);font-size:var(--text-xs);font-weight:600;text-transform:uppercase;letter-spacing:.06em}',
  ':where(tbody tr:last-child td){border-bottom:0}:where(td.num,th.num){text-align:right;font-variant-numeric:tabular-nums}',
  // Controls, as the app draws its own.
  ':where(button){display:inline-flex;align-items:center;justify-content:center;gap:6px;height:var(--control);padding:0 10px;border:1px solid var(--color-edge);border-radius:var(--radius-md);background:var(--control-glaze) var(--color-control-surface);color:var(--color-foreground);font:inherit;font-size:var(--text-base);font-weight:500;line-height:1;white-space:nowrap;cursor:pointer;transition:background var(--dur-2) var(--ease-out-quint),border-color var(--dur-2) var(--ease-out-quint),color var(--dur-2) var(--ease-out-quint),transform var(--dur-1) var(--ease-out-quint)}',
  ':where(button:hover:not(:disabled)){background:var(--control-glaze) var(--color-control-hover)}:where(button:active:not(:disabled)){transform:scale(.97)}:where(button:disabled){opacity:.45;cursor:default}',
  ':where(button.primary){border-color:var(--color-accent);background:var(--control-glaze) var(--color-accent);color:var(--color-accent-ink);box-shadow:var(--shadow-e1)}',
  ':where(button.ghost){border-color:transparent;background:transparent;color:var(--color-muted-foreground)}:where(button.ghost:hover:not(:disabled)){background:var(--color-surface-3);color:var(--color-foreground)}',
  ':where(button.small){height:var(--control-sm);padding:0 8px;font-size:var(--text-sm)}',
  ':where(input:not([type=range],[type=checkbox],[type=radio],[type=color]),select,textarea){height:var(--input);padding:0 10px;border:1px solid var(--color-edge);border-radius:var(--radius-md);background:var(--color-surface);color:var(--color-foreground);font:inherit;font-size:var(--text-base);caret-color:var(--color-accent);transition:border-color var(--dur-2) var(--ease-out-quint)}',
  ':where(textarea){height:auto;padding:8px 10px}:where(input,textarea)::placeholder{color:var(--color-subtle)}',
  ':where(input:not([type=range],[type=checkbox],[type=radio]),select,textarea):focus-visible{outline:none;border-color:color-mix(in srgb,var(--color-foreground) 35%,var(--color-edge))}',
  ':where(button,summary,[tabindex]):focus-visible{outline:2px solid var(--color-accent);outline-offset:2px}',
  ':where(input[type=checkbox],input[type=radio]){accent-color:var(--color-foreground)}',
  ':where(input[type=checkbox][role=switch]){appearance:none;-webkit-appearance:none;position:relative;flex:none;width:40px;height:24px;margin:0;border:1px solid var(--color-edge);border-radius:999px;background:var(--color-surface-3);cursor:pointer;transition:background var(--dur-2),border-color var(--dur-2)}',
  ':where(input[type=checkbox][role=switch])::after{content:"";position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:var(--color-muted-foreground);transition:transform var(--dur-2) var(--ease-out-quint)}',
  ':where(input[type=checkbox][role=switch]:checked){border-color:var(--color-foreground);background:var(--color-foreground)}:where(input[type=checkbox][role=switch]:checked)::after{transform:translateX(16px);background:var(--color-background)}',
  // The slider: a pill filled with the accent up to a round thumb. The bootstrap keeps --fill at the value.
  ':where(input[type=range]){appearance:none;-webkit-appearance:none;width:160px;height:20px;margin:0;padding:0;border:0;background:transparent;cursor:pointer;touch-action:pan-y;--fill:50%}',
  ':where(input[type=range])::-webkit-slider-runnable-track{height:6px;border-radius:999px;background:linear-gradient(to right,var(--color-accent) var(--fill),var(--color-edge) var(--fill))}',
  ':where(input[type=range])::-webkit-slider-thumb{-webkit-appearance:none;width:16px;height:16px;margin-top:-5px;border:0;border-radius:50%;background:var(--color-reasoning-on);box-shadow:var(--shadow-e1),0 0 0 1px var(--color-edge);transition:transform var(--dur-1) var(--ease-out-quint),box-shadow var(--dur-2) var(--ease-out-quint)}',
  ':where(input[type=range]:hover)::-webkit-slider-thumb{transform:scale(1.12)}',
  ':where(input[type=range]:focus-visible){outline:none}:where(input[type=range]:focus-visible)::-webkit-slider-thumb{box-shadow:var(--shadow-e1),0 0 0 4px var(--color-accent-soft)}',
  ':where(input[type=range])::-moz-range-track{height:6px;border-radius:999px;background:var(--color-edge)}:where(input[type=range])::-moz-range-progress{height:6px;border-radius:999px;background:var(--color-accent)}',
  ':where(input[type=range])::-moz-range-thumb{width:16px;height:16px;border:0;border-radius:50%;background:var(--color-reasoning-on);box-shadow:var(--shadow-e1),0 0 0 1px var(--color-edge)}',
  '@media (pointer:coarse){:where(input[type=range]){height:28px}:where(input[type=range])::-webkit-slider-thumb{width:22px;height:22px;margin-top:-8px}:where(input[type=range])::-moz-range-thumb{width:22px;height:22px}}',
  ':where(progress){appearance:none;-webkit-appearance:none;width:160px;height:6px;border:0;border-radius:999px;background:var(--color-edge);overflow:hidden;vertical-align:middle}',
  ':where(progress)::-webkit-progress-bar{background:transparent}:where(progress)::-webkit-progress-value{border-radius:999px;background:var(--color-accent)}:where(progress)::-moz-progress-bar{border-radius:999px;background:var(--color-accent)}',
  // The kit's classes: layout, a raised box, labels and small data pieces.
  ':where(.row){display:flex;flex-wrap:wrap;align-items:center;gap:8px 16px}:where(.stack){display:flex;flex-direction:column;gap:12px}:where(.grid){display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px}:where(.spread){justify-content:space-between}',
  ':where(.card){padding:14px 16px;border:1px solid var(--color-border);border-radius:var(--radius-lg);background:var(--color-surface);box-shadow:var(--shadow-e1)}',
  ':where(.controls){display:flex;flex-wrap:wrap;align-items:center;gap:10px 20px;margin-top:12px;padding-top:12px;border-top:1px solid var(--color-border)}',
  ':where(.field){display:inline-flex;align-items:center;gap:8px;color:var(--color-muted-foreground);font-size:var(--text-sm)}:where(.field output){min-width:4.5ch;color:var(--color-foreground)}',
  ':where(.segmented){display:inline-flex;gap:2px;padding:3px;border-radius:var(--radius-md);background:var(--color-edge)}',
  ':where(.segmented>button){height:24px;padding:0 10px;border:0;border-radius:var(--radius-sm);background:transparent;color:var(--color-muted-foreground);font-size:var(--text-sm);box-shadow:none}',
  ':where(.segmented>button:hover:not(:disabled)){background:var(--color-hover);color:var(--color-foreground)}:where(.segmented>button[aria-pressed=true]){background:var(--color-active);color:var(--color-foreground)}',
  ':where(.label){color:var(--color-muted-foreground);font-size:var(--text-xs);font-weight:600;line-height:1.4;text-transform:uppercase;letter-spacing:.06em}',
  ':where(.num){font-family:var(--font-mono);font-variant-numeric:tabular-nums}',
  ':where(.stat){display:flex;flex-direction:column;gap:2px;min-width:0}:where(.stat>b,.stat>strong){font-family:var(--font-mono);font-size:var(--text-md);font-weight:600;font-variant-numeric:tabular-nums;line-height:1.3}',
  ':where(.chip){display:inline-flex;align-items:center;gap:5px;height:var(--control-sm);padding:0 8px;border:1px solid var(--color-border);border-radius:var(--radius-sm);background:var(--color-surface-2);color:var(--color-muted-foreground);font-size:var(--text-sm);font-weight:500;white-space:nowrap}',
  ':where(.legend){display:flex;flex-wrap:wrap;gap:6px 16px;color:var(--color-muted-foreground);font-size:var(--text-sm)}:where(.legend>*){display:inline-flex;align-items:center;gap:6px}',
  ':where(.key){flex:none;width:12px;height:3px;border-radius:2px;background:currentColor}',
  ':where(.bar){height:6px;border-radius:999px;background:linear-gradient(to right,currentColor var(--value,0%),var(--color-edge) var(--value,0%));color:var(--color-accent)}',
  ':where(.stage){display:block;width:100%}',
  // Drawings: a color is set once and the strokes and fills take it.
  ':where(svg){max-width:100%;overflow:visible}:where(svg text){color:var(--color-muted-foreground);fill:currentColor;font-family:inherit;font-size:var(--text-xs);font-variant-numeric:tabular-nums}',
  ':where(.node){fill:var(--color-surface-2);stroke:var(--color-edge);stroke-width:1}',
  ':where(.stroke){fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}:where(.fill){fill:currentColor;stroke:none}:where(.soft){opacity:.2}',
  ':where(.gridline){fill:none;stroke:var(--color-border);stroke-width:1}:where(.baseline){fill:none;stroke:var(--color-edge);stroke-width:1}:where(.guide){fill:none;stroke:var(--color-edge);stroke-width:1;stroke-dasharray:3 4}',
  // Colors last, so one of them on a chip, a key or a shape wins over that piece's own.
  ':where(.ink){color:var(--color-foreground)}:where(.muted){color:var(--color-muted-foreground)}:where(.subtle){color:var(--color-subtle)}:where(.accent){color:var(--color-accent)}:where(.success){color:var(--color-success)}:where(.live){color:var(--color-live)}:where(.danger){color:var(--color-danger)}',
  [1, 2, 3, 4, 5, 6, 7, 8].map((series) => `:where(.series-${series}){color:var(--series-${series})}`).join(''),
].join('');

const REDUCED_CSS = '*,*::before,*::after{animation-duration:.001ms!important;animation-iteration-count:1!important;transition-duration:.001ms!important}';

/** A saved copy opened by itself, and the headless check, have no client to theme them: the app's two palettes, by the system's scheme. */
const DARK = '--color-background:#101013;--color-surface:#151518;--color-surface-2:#1b1b1f;--color-surface-3:#232327;--color-border:rgba(255,255,255,.07);--color-edge:rgba(255,255,255,.14);--color-hover:rgba(255,255,255,.05);--color-active:rgba(255,255,255,.09);--color-foreground:#ececf1;--color-muted-foreground:#a2a2ad;--color-subtle:#8c8c96;--color-accent:oklch(68% .19 260);--color-accent-soft:oklch(68% .19 260/.18);--color-accent-ink:#101013;--color-success:#4ade80;--color-live:#eab308;--color-danger:#f0716f;--series-1:#d95926;--series-2:#3987e5;--series-3:#199e70;--series-4:#9085e9;--series-5:#c98500;--series-6:#d55181;--series-7:#008300;--series-8:#e66767;--control-glaze:linear-gradient(145deg,rgb(255 255 255/.055),rgb(255 255 255/.012) 48%,transparent);--color-control-surface:#1b1b1f;--color-control-hover:#232327;--shadow-e1:0 1px 2px rgb(0 0 0/.35),inset 0 1px 0 rgb(255 255 255/.05);--shadow-e2:0 8px 24px rgb(0 0 0/.45),0 0 0 1px rgb(255 255 255/.05);';
const LIGHT = '--color-background:#f3f3f6;--color-surface:#fafafb;--color-surface-2:#fff;--color-surface-3:#ebebef;--color-border:rgba(0,0,0,.08);--color-edge:rgba(0,0,0,.16);--color-hover:rgba(0,0,0,.045);--color-active:rgba(0,0,0,.08);--color-foreground:#1c1c21;--color-muted-foreground:#50505a;--color-subtle:#67676f;--color-accent-ink:#fff;--color-success:#16a34a;--color-live:#ca8a04;--color-danger:#dc2626;--series-1:#eb6834;--series-2:#2a78d6;--series-3:#18a070;--series-4:#4a3aa7;--series-5:#bf8200;--series-6:#e26092;--series-7:#008300;--series-8:#e34948;--control-glaze:none;--color-control-surface:#fff;--color-control-hover:#ebebef;--shadow-e1:0 1px 2px rgb(0 0 0/.08),inset 0 1px 0 rgb(255 255 255/.6);--shadow-e2:0 8px 24px rgb(0 0 0/.12),0 0 0 1px rgb(0 0 0/.06);';
const SHAPE = "--radius-sm:6px;--radius-md:8px;--radius-lg:12px;--font-sans:ui-sans-serif,system-ui,'Segoe UI',sans-serif;--font-mono:ui-monospace,'Cascadia Mono',Consolas,monospace;--text-xs:12px;--text-sm:13px;--text-base:14px;--text-md:16px;--text-lg:20px;--text-reading:15px;--leading-reading:1.6;--control:30px;--control-sm:26px;--input:34px;--color-reasoning-on:#fff;--dur-1:90ms;--dur-2:150ms;--dur-3:220ms;--ease-out-quint:cubic-bezier(.22,1,.36,1);";
const DEFAULT_THEME = `:root{color-scheme:dark;${DARK}${SHAPE}}@media (prefers-color-scheme:light){:root{color-scheme:light;${LIGHT}}}`;

/*
 * Runs in the head before the page's own styles and scripts. It writes the
 * theme into its own <style>, so a later rule of the page still wins; drops
 * the fragment, so a page's own hash never sees it; reports the content
 * height the way the core measures it; and hands a clicked link to the client
 * instead of letting it replace the page inside the conversation.
 */
const BOOTSTRAP = `(function(){var s=document.getElementById("boite-view-theme"),r=document.documentElement,q=${JSON.stringify(REDUCED_CSS)},last=0;` +
  'function post(t,d){if(window.parent===window)return;d.boiteView=1;d.type=t;window.parent.postMessage(d,"*");}' +
  'function apply(t){if(!s||!t||typeof t!=="object"||!t.vars||typeof t.vars!=="object")return;var c=":root{color-scheme:"+(t.scheme==="light"?"light":"dark")+";",k;for(k in t.vars){if(/^--[a-z0-9-]+$/.test(k))c+=k+":"+String(t.vars[k]).replace(/[;{}<>]/g,"")+";";}s.textContent=c+"}"+(t.reduced?q:"");if(t.reduced)r.setAttribute("data-reduced-motion","");else r.removeAttribute("data-reduced-motion");}' +
  `try{var m=/[#&]${THEME_KEY}=([^&]*)/.exec(location.hash);if(m){apply(JSON.parse(decodeURIComponent(m[1])));history.replaceState(history.state,"",location.pathname+location.search);}}catch(e){}` +
  'function size(){var h=Math.ceil(r.scrollHeight>r.clientHeight?r.scrollHeight:r.getBoundingClientRect().height);if(h>0&&h!==last){last=h;post("size",{height:h});}}' +
  'window.addEventListener("message",function(e){var d=e.data;if(!d||d.boiteView!==1||e.source!==window.parent)return;if(d.type==="theme")apply(d.theme);if(d.type==="font"&&window.FontFace&&d.data){try{var f=new FontFace(String(d.family),d.data,d.descriptors||{});document.fonts.add(f);f.load().then(size,size);}catch(x){}}});' +
  'document.addEventListener("click",function(e){var p=e.composedPath?e.composedPath():[],l=null,i,h,u;for(i=0;i<p.length;i++){if(p[i]&&p[i].tagName&&/^a$/i.test(p[i].tagName)&&(p[i].getAttribute("href")!==null||p[i].getAttribute("xlink:href")!==null)){l=p[i];break;}}if(!l)return;h=l.getAttribute("href")||l.getAttribute("xlink:href")||"";if(h.charAt(0)==="#")return;e.preventDefault();try{u=new URL(h,document.baseURI);}catch(x){return;}if(e.isTrusted&&/^https?:$/.test(u.protocol))post("link",{url:u.href});},true);' +
  // A slider is filled up to its thumb: --fill follows the value, whether the reader or the page's script moved it.
  'function fill(e){var a=parseFloat(e.min)||0,z=e.max===""?100:parseFloat(e.max),v=parseFloat(e.value);e.style.setProperty("--fill",(z>a?(v-a)/(z-a)*100:0)+"%");}function fills(){var l=document.querySelectorAll("input[type=range]"),i;for(i=0;i<l.length;i++)fill(l[i]);}' +
  'try{var vd=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value");if(vd&&vd.set)Object.defineProperty(HTMLInputElement.prototype,"value",{configurable:true,enumerable:vd.enumerable,get:vd.get,set:function(v){vd.set.call(this,v);if(this.type==="range")fill(this);}});}catch(x){}' +
  'document.addEventListener("input",function(e){var t=e.target;if(t&&t.type==="range")fill(t);},true);document.addEventListener("DOMContentLoaded",function(){fills();if(window.MutationObserver&&document.body)new MutationObserver(fills).observe(document.body,{childList:true,subtree:true});});' +
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
    // The theme's variables, which the bootstrap rewrites, then the kit, which never changes.
    `<style id="boite-view-theme">${DEFAULT_THEME}</style><style id="boite-view-kit">${baseCss()}</style>`,
    `<script>${BOOTSTRAP}</script>`,
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
boite view example                        a complete page in the app's look, to start from

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
- Let the content set the height: no 100vh, no height:100% on html or body.
  Give a chart or an animation stage a fixed pixel height or an aspect-ratio.
- It must hold at ${VIEW_NARROW_WIDTH}px: fluid widths, and SVG with a viewBox and width:100%.

The look
The page wears the app's look, and most of it comes for free: plain HTML
elements and the classes below are already drawn the way the app draws its
own. Write CSS only for what is specific to your visual, and keep to this:
- Quiet and flat. Neutral text and lines, surfaces one step apart, hairline
  borders. No gradient, glow or drop shadow on content.
- One accent, the user's own color, for the thing to look at: the moving
  part, the current value, the main action. Everything else stays neutral.
  --series-1 to --series-8 are for data series, taken in that order.
- Calm type: body text as given, labels small and muted, numbers in the mono
  face, weights 400, 500 and 600. No emoji. An icon is an inline SVG with a
  1.75 stroke and no fill.
- Spacing in steps of 4 (4, 8, 12, 16, 24). Corners from --radius-sm to
  --radius-lg.
- Drawings: 2px strokes with round ends, hairline grid lines, no frame around
  the drawing, nothing decorative.

Drawn for you, no CSS needed
  button  button.primary  button.ghost  button.small
  input  select  textarea  progress
  input[type=range]                    the app's slider
  input[type=checkbox][role=switch]    the app's switch
  table (td.num for numbers)  code  pre  kbd  hr  details

Classes
  .row .stack .grid .spread   wrapping row, column, auto-fit grid, ends apart
  .card                       a raised box, for what must stand apart
  .controls                   the row of controls under a drawing
  .field                      <label class="field">Length <input type="range"> <output>2.0 m</output></label>
  .segmented                  a group of buttons; the chosen one has aria-pressed="true"
  .stat                       <div class="stat"><span class="label">Period</span><b>2.84 s</b></div>
  .chip                       a small tag; add .accent .success .live or .danger
  .legend .key                <div class="legend"><span><i class="key series-1"></i>Requests</span></div>
  .bar                        a meter: <div class="bar" style="--value:62%"></div>
  .label .muted .subtle .num  small caps label, quieter text, mono numbers
In SVG
  .stroke .fill .soft         a 2px round line, a solid shape, a faint one
  .series-1 to .series-8, .accent, .muted
                              the color .stroke and .fill draw in
  .gridline .baseline .guide  hairline, axis line, dashed helper line
  .node                       a box or a dot of a diagram: raised fill, thin edge
  <text> is small and muted; .ink makes it the text color.
  A diagram: <rect class="node" x="20" y="40" width="140" height="44" rx="8"/>
             <text class="ink" x="90" y="67" text-anchor="middle">Client</text>
             <path class="stroke muted" d="M160 62 H240"/>

Variables, on :root, following the user's theme live
  --color-foreground --color-muted-foreground --color-subtle    text
  --color-surface --color-surface-2 --color-surface-3           raised boxes
  --color-border --color-edge --color-hover --color-active      lines and states
  --color-accent --color-accent-soft --color-accent-ink         the user's accent
  --color-success --color-live --color-danger                   states
  --series-1 to --series-8                                      chart series
  --radius-sm --radius-md --radius-lg  --shadow-e1 --shadow-e2 (floating things)
  --font-sans --font-mono  --text-xs --text-sm --text-base --text-md --text-lg
  --dur-1 --dur-2 --dur-3 --ease-out-quint
Never write a fixed color or a font name. On a canvas, read a variable with
getComputedStyle(document.documentElement).getPropertyValue('--color-accent').

Motion
- Animate with requestAnimationFrame or CSS. It starts when the page loads,
  and the user can replay it from the frame.
- A transition takes var(--dur-2) with var(--ease-out-quint). Nothing bounces.
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
It also prints advice that does not stop the publish, such as a fixed color
that will not follow the user's theme. Fix what it names, then publish again.
`;
