// An advisory ranking, not a pass/fail complexity threshold.
const run = Bun.spawnSync([
  process.execPath, 'x', '--package', 'oxlint@1.82.0', 'oxlint',
  '--threads', '8', '--config', 'scripts/architecture/complexity.json', '--format', 'json',
  'packages/core/src', 'packages/contracts/src', 'packages/ui/src', 'scripts',
], { stdout: 'pipe', stderr: 'pipe' });
if (run.exitCode !== 0) throw new Error(`oxlint failed: ${run.stderr.toString()}\n${run.stdout.toString()}`);
const report = JSON.parse(run.stdout.toString()) as { diagnostics: {
  code: string; message: string; filename: string;
  labels: { span: { line: number } }[];
}[] };
const rows = report.diagnostics.filter(item => item.code === 'eslint(complexity)').map(item => {
  const match = /(?:`(.+?)` )?has a complexity of (\d+)/.exec(item.message);
  if (!match) throw new Error(`Unexpected oxlint complexity diagnostic: ${item.message}`);
  return { ccn: Number(match[2]), file: item.filename.replaceAll('\\', '/'), line: item.labels[0]?.span.line ?? 1, name: match[1] ?? '(anonymous)' };
}).sort((a, b) => b.ccn - a.ccn || a.file.localeCompare(b.file) || a.line - b.line);
if (process.argv.includes('--json')) console.log(JSON.stringify(rows, null, 2));
else {
  console.log('CCN  Function  Location');
  for (const row of rows.slice(0, 30)) console.log(`${String(row.ccn).padStart(3)}  ${row.name}  ${row.file}:${row.line}`);
  console.log('Inspect responsibilities before refactoring. Dispatch cases and short validation guards can legitimately score high.');
}
