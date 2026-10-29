# Experimental view kit

This is an opt-in, executable prototype of reusable view interactions. It is
not a native message format or a runtime automatically supplied by Boite.
Existing HTML views and their saved snapshots keep their current behavior.

From an agent thread whose working directory is this checkout:

```sh
boite view check examples/view-kit/example.html --script examples/view-kit/checks.js
boite view examples/view-kit/example.html
```

The [example](../examples/view-kit/example.html) includes its
[script](../examples/view-kit/view-kit.js) and
[styles](../examples/view-kit/view-kit.css) through relative paths. The existing
view command embeds them and the local media in the published snapshot. To
reuse the prototype in another project, copy the script and styles alongside
the authored page and include them explicitly. Ordinary HTML, CSS, SVG and
JavaScript remain available.

## Authoring

Named inputs feed a scope; a single ordinary JavaScript function derives its
outputs. Matching text, including SVG text, uses `data-value`. Numeric values
also become CSS variables named `--view-<name>` for geometry or animation.

```html
<section id="scene">
  <label>Speed <input name="speed" type="range" min="1" max="8" value="3"></label>
  <output data-value="total"></output>
  <button type="button" data-set='{"speed":8}'>Fast</button>
  <button type="button" data-reset>Reset</button>
</section>
<script src="view-kit.js"></script>
<script>
  View.bind('#scene', ({ speed }) => ({ total: speed * 60 }));
</script>
```

Bind after the scope's markup exists. The handle offers `set`, `reset`,
`values` and `dispose`. Bound child scopes are isolated; bind a child before
its parent when both initially contain controls. This is a synchronous helper,
not a persistent store or an expression language.

| Element | Authored children | Supplied behavior |
| --- | --- | --- |
| `view-choices` | Arbitrary elements with `data-label` | Direct selection, arrow/Home/End keys, inactive panels hidden |
| `view-steps` | The same | Previous/next, play/pause, count; optional `interval` in milliseconds |
| `view-compare` | Exactly two images with alt text | Before/after wipe, range and endpoint buttons |
| `view-media` | Video/audio and arbitrary surrounding markup | Common play/pause, seek, rate and restart; muted playback |

`view-steps` accepts `selected` (zero-based) and `autoplay`, which is suppressed
when reduced motion is requested. The example uses manual playback.
`view-media` uses the shortest media duration and corrects coarse drift; it is
not frame-accurate synchronization. Use its common controls, without independent
native player controls. `View.bind` and `view-compare` emit `view:change`;
Choices/Steps and Media do not expose that event in this prototype.
The labels default to English; an explicit French document language selects
French control labels. This is a prototype convention, not app localization.

The sample images are synthetic SVG diagrams. The two silent WebM clips are
generated test patterns, not recordings or performance comparisons:

```sh
ffmpeg -f lavfi -i testsrc2=size=320x180:rate=12:duration=4 -an -c:v libvpx-vp9 -deadline realtime -cpu-used 8 -crf 40 -b:v 0 before.webm
ffmpeg -f lavfi -i testsrc2=size=320x180:rate=12:duration=4 -vf hue=h=60 -an -c:v libvpx-vp9 -deadline realtime -cpu-used 8 -crf 40 -b:v 0 after.webm
```

## What the prototype establishes

The browser-backed test uses fresh test data and the real view-check RPC at
816 and 330 pixels, in dark and light. It exercises derived SVG geometry,
presets/reset, nested scope isolation, wipe controls, choices, steps, shared
media playback/seeking/rate, reconnect cleanup and reduced motion.

```sh
bun test packages/core/test/view-kit.test.ts
```

These are examples of shared behavior the current HTML/JS format could already
express. The intended saving comes from supplying that behavior once, rather
than rewriting its handlers for every view. It does not establish a universal
token reduction or end-to-end generation-time improvement. The current page
still explicitly includes the runtime and uses the existing file/publication
path. Mermaid remains suitable for diagrams and simple static charts; LaTeX
remains suitable for mathematical notation.

## Improvements still needed

This is a first iteration, with room to improve both authoring and capability:

1. Supply a versioned runtime and short, component-specific guidance centrally,
   so agents do not copy library code or reread the full guide.
2. Support native HTML/SVG fragments in assistant messages with immutable local
   assets, streaming boundaries and historical compatibility.
3. Prepare/check a private draft once, inspect its captures, then publish that
   exact draft; retain theme, resize and initial-height checks.
4. Validate pool lifecycle, concurrency, failure cleanup and safe snapshot reuse
   before selecting backend optimizations from benchmarks.
5. Make annotations, linked zoom/pan and a seekable SVG timeline easy to compose;
   consider Mermaid/LaTeX within a view and immutable local CSV/JSON input.
6. Finish library lifecycle, nested composition, localization, accessibility and
   installed-client acceptance; the prototype is not a stable component API.

None of these integration items is implemented by this example. Existing
full-size viewing, replay and HTML download already belong to Boite.
