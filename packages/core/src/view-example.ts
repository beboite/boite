/*
 * `boite view example`: one complete page in the app's look, for an agent to
 * read before it writes its own. It is the kit used as intended: no color, no
 * font and almost no CSS of its own, the drawing in the accent, the controls
 * and the figures from the classes `boite view help` lists. The end-to-end
 * test publishes this same text, so what an agent copies is what was checked.
 */
export const VIEW_EXAMPLE = `<!doctype html>
<html lang="en">
<head>
<title>Pendulum</title>
<style>
  /* Only what this drawing needs. Everything else is the kit: see boite view help. */
  .stage { height: clamp(180px, 60vw, 300px); }
</style>
</head>
<body>
<svg class="stage" viewBox="0 0 400 250" role="img" aria-label="A pendulum swinging from a fixed point">
  <line class="guide" x1="200" y1="16" x2="200" y2="242"/>
  <path class="stroke accent soft" id="sweep" stroke-width="3"/>
  <line class="stroke muted" id="rod" x1="200" y1="16" x2="200" y2="156" stroke-width="1.5"/>
  <circle class="fill muted" cx="200" cy="16" r="3.5"/>
  <circle class="fill accent" id="bob" cx="200" cy="156" r="13"/>
</svg>

<div class="controls">
  <button id="toggle" type="button">Pause</button>
  <label class="field">Length <input id="length" type="range" min="0.5" max="3" step="0.1" value="2"><output id="lengthOut">2.0 m</output></label>
  <label class="field">Start <input id="angle" type="range" min="5" max="60" step="1" value="35"><output id="angleOut">35°</output></label>
  <div class="segmented" role="group" aria-label="Gravity">
    <button type="button" data-g="9.81" aria-pressed="true">Earth</button>
    <button type="button" data-g="3.71" aria-pressed="false">Mars</button>
    <button type="button" data-g="1.62" aria-pressed="false">Moon</button>
  </div>
</div>

<div class="row" style="margin-top: 16px; gap: 8px 32px">
  <div class="stat"><span class="label">Period</span><b id="period"></b></div>
  <div class="stat"><span class="label">Angle</span><b id="now"></b></div>
  <div class="stat"><span class="label">Speed</span><b id="speed"></b></div>
</div>

<script>
  const PIVOT = { x: 200, y: 16 }, SCALE = 70;
  const $ = (id) => document.getElementById(id);
  // The user asked for less motion: the page waits for Play instead of starting by itself.
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.hasAttribute('data-reduced-motion');
  let gravity = 9.81, length = 2, start = 35 * Math.PI / 180, theta = start, velocity = 0, playing = !still, last = 0;

  const point = (angle) => ({ x: PIVOT.x + Math.sin(angle) * length * SCALE, y: PIVOT.y + Math.cos(angle) * length * SCALE });
  function draw() {
    const bob = point(theta), from = point(-start), to = point(start), radius = length * SCALE;
    $('rod').setAttribute('x2', bob.x); $('rod').setAttribute('y2', bob.y);
    $('bob').setAttribute('cx', bob.x); $('bob').setAttribute('cy', bob.y);
    $('sweep').setAttribute('d', 'M ' + from.x + ' ' + from.y + ' A ' + radius + ' ' + radius + ' 0 0 0 ' + to.x + ' ' + to.y);
    $('period').textContent = (2 * Math.PI * Math.sqrt(length / gravity)).toFixed(2) + ' s';
    $('now').textContent = (theta * 180 / Math.PI).toFixed(0) + '°';
    $('speed').textContent = Math.abs(velocity * length).toFixed(2) + ' m/s';
  }
  function reset() { theta = start; velocity = 0; draw(); }
  function frame(now) {
    const dt = Math.min(0.032, (now - last) / 1000 || 0);
    last = now;
    if (playing) {
      // Semi-implicit Euler: the swing keeps its energy over time.
      velocity += -(gravity / length) * Math.sin(theta) * dt;
      theta += velocity * dt;
      draw();
    }
    requestAnimationFrame(frame);
  }

  $('toggle').textContent = playing ? 'Pause' : 'Play';
  $('toggle').addEventListener('click', () => { playing = !playing; $('toggle').textContent = playing ? 'Pause' : 'Play'; });
  $('length').addEventListener('input', (event) => { length = Number(event.target.value); $('lengthOut').textContent = length.toFixed(1) + ' m'; reset(); });
  $('angle').addEventListener('input', (event) => { start = Number(event.target.value) * Math.PI / 180; $('angleOut').textContent = event.target.value + '°'; reset(); });
  for (const choice of document.querySelectorAll('.segmented button')) {
    choice.addEventListener('click', () => {
      for (const other of document.querySelectorAll('.segmented button')) other.setAttribute('aria-pressed', String(other === choice));
      gravity = Number(choice.dataset.g);
      reset();
    });
  }
  draw();
  requestAnimationFrame(frame);
</script>
</body>
</html>
`;
