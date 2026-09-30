import { readFileSync, writeFileSync } from 'node:fs';
const path = 'packages/core/test/thread-remove.test.ts';
const original = readFileSync(path, 'utf8');
const checks: [string,string][] = [
  ['baseline', original],
  ['first-matcher', original.replace(".rejects.toThrow('unknown thread')", ".rejects.toMatchObject({ message: expect.stringContaining('unknown thread') })")],
  ['device-matchers', original.replaceAll('.rejects.toThrow();', '.rejects.toMatchObject({ message: expect.stringContaining("for the owner only") });')],
  ['last-matcher', original.replace(".rejects.toThrow('persistent agent sessions')", ".rejects.toMatchObject({ message: expect.stringContaining('persistent agent sessions') })")],
  ['all-matchers', original.replace(".rejects.toThrow('unknown thread')", ".rejects.toMatchObject({ message: expect.stringContaining('unknown thread') })")
    .replaceAll('.rejects.toThrow();', '.rejects.toMatchObject({ message: expect.stringContaining("for the owner only") });')
    .replace(".rejects.toThrow('persistent agent sessions')", ".rejects.toMatchObject({ message: expect.stringContaining('persistent agent sessions') })")],
];
try {
  for (const [label, source] of checks) {
    writeFileSync(path, source);
    for (let i=1;i<=(label==='all-matchers'?10:3);i++) {
      console.log(`PROBE ${label} ${i}`);
      const child = Bun.spawn([process.execPath, 'test', path], {stdout:'pipe',stderr:'pipe',windowsHide:true});
      const timer = setTimeout(() => child.kill(), 15000);
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
      clearTimeout(timer);
      console.log(out+err); console.log(`PROBE RESULT ${label} ${i}: ${code}`);
    }
  }
} finally { writeFileSync(path, original); }
