import { readFileSync, writeFileSync } from 'node:fs';
const path = 'packages/core/test/thread-remove.test.ts';
const fixed = readFileSync(path, 'utf8');
const original = Bun.spawnSync(['git','show','origin/main:'+path]).stdout.toString();
const checks: [string,string][] = [['baseline', original], ['structured-errors', fixed]];
try {
  for (const [label, source] of checks) {
    writeFileSync(path, source);
    for (let i=1;i<=(label==='structured-errors'?10:3);i++) {
      console.log(`PROBE ${label} ${i}`);
      const child = Bun.spawn([process.execPath, 'test', path], {stdout:'pipe',stderr:'pipe',windowsHide:true});
      const timer = setTimeout(() => child.kill(), 15000);
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
      clearTimeout(timer);
      console.log(out+err); console.log(`PROBE RESULT ${label} ${i}: ${code}`);
    }
  }
} finally { writeFileSync(path, fixed); }
