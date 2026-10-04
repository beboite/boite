/*
 * What a real terminal has to draw, for the terminal captures. `palette` prints
 * the 16 ANSI colours, the 256-colour cube, a truecolor ramp, text attributes
 * and a hyperlink. `fullscreen` takes the alternate screen as vim or htop do,
 * frames it edge to edge at the size the pty reports, redrawn when it changes,
 * reports mouse clicks and Ctrl+D, and leaves on `q`.
 */

const ESC = '\x1b';
const mode = process.argv[2] ?? 'palette';
const out = (text: string) => process.stdout.write(text);

if (mode === 'palette') {
  let line = '';
  for (let i = 0; i < 8; i++) line += `${ESC}[3${i}m fg${i} ${ESC}[0m`;
  out(`${line}\r\n`);
  line = '';
  for (let i = 0; i < 8; i++) line += `${ESC}[9${i}m br${i} ${ESC}[0m`;
  out(`${line}\r\n`);
  line = '';
  for (let i = 0; i < 16; i++) line += `${ESC}[48;5;${i}m   `;
  out(`${line}${ESC}[0m\r\n`);
  for (let row = 0; row < 6; row++) {
    line = '';
    for (let i = 0; i < 36; i++) line += `${ESC}[48;5;${16 + row * 36 + i}m `;
    out(`${line}${ESC}[0m\r\n`);
  }
  line = '';
  for (let i = 232; i < 256; i++) line += `${ESC}[48;5;${i}m  `;
  out(`${line}${ESC}[0m\r\n`);
  line = '';
  for (let i = 0; i < 64; i++) {
    const r = Math.round(255 * (1 - i / 63));
    const g = Math.round(255 * Math.sin((Math.PI * i) / 63));
    const b = Math.round((255 * i) / 63);
    line += `${ESC}[48;2;${r};${g};${b}m `;
  }
  out(`${line}${ESC}[0m\r\n`);
  out(`${ESC}[1mbold${ESC}[0m ${ESC}[2mdim${ESC}[0m ${ESC}[3mitalic${ESC}[0m ${ESC}[4munderline${ESC}[0m ${ESC}[7mreverse${ESC}[0m ${ESC}[9mstrike${ESC}[0m `);
  out(`${ESC}]8;;https://example.com/boite${ESC}\\hyperlink${ESC}]8;;${ESC}\\ https://example.com/plain\r\n`);
  out('box ┌─┬─┐ │ │ │ └─┴─┘ arrows ← ↑ → ↓ blocks ░▒▓█\r\n');
  process.exit(0);
}

let last = 'none';
let key = 'none';
function draw(): void {
  const { columns: cols = 80, rows = 24 } = process.stdout;
  out(`${ESC}[H${ESC}[2J`);
  const title = ` ansi-screen ${cols}x${rows} `;
  out(`${ESC}[1;1H${ESC}[7m${title.padEnd(cols, ' ')}${ESC}[0m`);
  out(`${ESC}[2;1H${ESC}[36m┌${'─'.repeat(cols - 2)}┐${ESC}[0m`);
  for (let row = 3; row < rows - 1; row++) {
    out(`${ESC}[${row};1H${ESC}[36m│${ESC}[0m${ESC}[${row};${cols}H${ESC}[36m│${ESC}[0m`);
  }
  out(`${ESC}[${rows - 1};1H${ESC}[36m└${'─'.repeat(cols - 2)}┘${ESC}[0m`);
  const lines = [
    `${ESC}[31mred${ESC}[0m ${ESC}[32mgreen${ESC}[0m ${ESC}[33myellow${ESC}[0m ${ESC}[34mblue${ESC}[0m ${ESC}[35mmagenta${ESC}[0m`,
    `${ESC}[38;5;208m256-orange${ESC}[0m ${ESC}[38;2;120;200;255mtruecolor-sky${ESC}[0m`,
    `${ESC}[1;32m● running${ESC}[0m  ${ESC}[2mpress q to leave${ESC}[0m`,
    `mouse: ${last}`,
    `key: ${key}`,
  ];
  lines.forEach((text, i) => out(`${ESC}[${4 + i};3H${text}`));
  out(`${ESC}[${rows};1H${ESC}[44;97m${' NORMAL '.padEnd(cols, ' ')}${ESC}[0m`);
}

// The alternate screen, no cursor, and SGR mouse reports as vim's `mouse=a` asks for them.
out(`${ESC}[?1049h${ESC}[?25l${ESC}[?1000h${ESC}[?1006h`);
draw();
process.stdout.on('resize', draw);
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('data', (data) => {
  const text = String(data);
  const click = /\x1b\[<0;(\d+);(\d+)M/.exec(text);
  if (click) {
    last = `click ${click[1]},${click[2]}`;
    draw();
  }
  // Ctrl+D as a program reads it, the end of input a shell or a REPL takes it for.
  if (text.includes('\x04')) {
    key = 'ctrl-d';
    draw();
  }
  if (!text.includes('q')) return;
  out(`${ESC}[?1006l${ESC}[?1000l${ESC}[?25h${ESC}[?1049l`);
  process.exit(0);
});