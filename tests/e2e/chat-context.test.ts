import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp';
import { startDevUi } from './lib/ui.ts';
let server: { close(): Promise<void> };
let page: BrowserPage;
beforeAll(async () => {
  const port = await freePort();
  server = await startDevUi(port);
  page = await BrowserPage.launch({url:`http://127.0.0.1:${port}/?fake=1&open=recent`,windowSize:{width:1300,height:850}});
  await page.waitFor(`document.querySelector('[data-thread-id]')`);
}, 90000);
afterAll(async () => { await page?.close(); await server?.close(); }, 15_000);

async function update(code: string) {
  await page.evaluate(`(async () => { const {workspace} = await import('/src/lib/workspace.svelte.ts'); const store = workspace.active; const thread = store.openThread; ${code} })()`);
}
async function capture(name: string) {
  await page.evaluate(`Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))`);
  await page.screenshot(join(import.meta.dir,'.artifacts',name + '.png'));
}
test('silent work has no typing bubble, live text stays visible, and receipts follow actual activity', async () => {
  await update(`window.__answer = JSON.parse(JSON.stringify(thread.messages.at(-1)));`);
  await update(`thread.messages = thread.messages.filter(m => m.role === 'user'); const turn = thread.turns[0]; turn.status = 'running'; turn.startedAt = Date.now(); turn.finishedAt = null; thread.status = 'running';`);
  await page.waitFor(`document.querySelector('[data-testid="turn-summary"][data-status="running"]')`);
  expect(await page.evaluate(`document.querySelector('.author') === null`)).toBe(true);
  expect(await page.evaluate(`document.querySelectorAll('.receipts .received').length`)).toBe(1);
  expect(await page.evaluate(`document.querySelector('[data-testid="turn-elapsed"]').textContent`)).toMatch(/^Working for \d+s$/);
  expect(await page.evaluate(`document.querySelector('[data-testid="turn-finished-at"]') === null`)).toBe(true);
  expect(await page.evaluate(`document.querySelector('[data-testid="turn-summary"]').getBoundingClientRect().left < document.querySelector('.bubble').getBoundingClientRect().left`)).toBe(true);
  expect(await page.evaluate(`document.querySelector('[data-testid="typing-indicator"]') === null`)).toBe(true);
  expect(await page.evaluate(`document.querySelector('.reply-pending') === null`)).toBe(true);
  await update(`thread.turns[0].status = 'queued'; thread.status = 'queued';`);
  await page.waitFor(`!document.querySelector('[data-testid="typing-indicator"]')`);
  await update(`thread.turns[0].status = 'running'; thread.status = 'running'; store.connection = 'closed';`);
  expect(await page.evaluate(`document.querySelector('[data-testid="typing-indicator"]') === null`)).toBe(true);
  await update(`store.connection = 'ready';`);
  expect(await page.evaluate(`document.querySelector('[data-testid="typing-indicator"]') === null`)).toBe(true);
  await capture('quiet-chat-waiting');
  await update(`const answer = window.__answer; answer.parts = [{type:'text',text:''}]; answer.state = 'streaming'; thread.messages.push(answer);`);
  await page.waitFor(`document.querySelector('[data-role="assistant"]')`);
  expect(await page.evaluate(`document.querySelector('[data-testid="typing-indicator"]') === null`)).toBe(true);
  expect(await page.evaluate(`document.querySelector('.answer-bubble') === null`)).toBe(true);
  await update(`thread.messages.at(-1).parts[0].text = 'A complete answer.';`);
  await page.waitFor(`document.querySelectorAll('.receipts .received').length === 2`);
  expect(await page.evaluate(`document.querySelector('[data-testid="paragraph"]') === null`)).toBe(true);
  expect(await page.evaluate(`document.querySelector('[data-testid="paragraph-pending"]').textContent`)).toBe('A complete answer.');
  expect(await page.evaluate(`document.querySelectorAll('[data-testid="typing-indicator"]').length`)).toBe(1);
  expect(await page.evaluate(`document.querySelectorAll('[data-testid="typing-dot"]').length`)).toBe(3);
  expect(await page.evaluate(`document.querySelector('[data-testid="typing-indicator"]').getAttribute('aria-label')`)).toBe('Writing');
  await page.send('Emulation.setEmulatedMedia', {features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  expect(await page.evaluate(`getComputedStyle(document.querySelector('[data-testid="typing-dot"]')).animationName`)).toBe('none');
  await page.send('Emulation.setEmulatedMedia', {features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
  await page.evaluate(`document.documentElement.dataset.motion = 'reduced'`);
  expect(await page.evaluate(`getComputedStyle(document.querySelector('[data-testid="typing-dot"]')).animationName`)).toBe('none');
  await page.evaluate(`delete document.documentElement.dataset.motion`);
  await page.evaluate(`Object.defineProperty(document,'hidden',{value:true,configurable:true}); document.dispatchEvent(new Event('visibilitychange'));`);
  await page.waitFor(`getComputedStyle(document.querySelector('[data-testid="typing-dot"]')).animationPlayState === 'paused'`);
  await page.evaluate(`delete document.hidden; document.dispatchEvent(new Event('visibilitychange'));`);

  await page.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await page.send('Emulation.setTouchEmulationEnabled',{enabled:true});
  await capture('quiet-chat-live-text-phone');
  expect(await page.evaluate(`(() => { const bubble = document.querySelector('.answer-bubble').getBoundingClientRect(), composer = document.querySelector('[data-testid="composer"]').getBoundingClientRect(); return bubble.left >= 0 && bubble.right <= innerWidth && bubble.bottom <= composer.top; })()`)).toBe(true);
  await page.send('Emulation.setDeviceMetricsOverride',{width:1300,height:850,deviceScaleFactor:1,mobile:false});
  await page.send('Emulation.setTouchEmulationEnabled',{enabled:false});
  await update(`thread.messages.at(-1).parts[0].text += '\\n\\nStill **writing';`);
  await page.waitFor(`document.querySelector('[data-testid="paragraph"]')`);
  expect(await page.evaluate(`document.querySelectorAll('[data-testid="typing-indicator"]').length`)).toBe(1);
  expect(await page.evaluate(`document.querySelector('[data-testid="paragraph"]').textContent`)).toBe('A complete answer.');
  expect(await page.evaluate(`document.querySelector('[data-testid="paragraph-pending"]').textContent`)).toBe('Still **writing');
  expect(await page.evaluate(`document.querySelector('[data-testid="paragraph-pending"] strong') === null`)).toBe(true);
  await update(`thread.messages.push({...thread.messages[0],id:'typing-steer',createdAt:Date.now(),parts:[{type:'text',text:'Check the phone layout too.'}]});`);
  await page.waitFor(`!document.querySelector('[data-testid="typing-indicator"]')`);
  expect(await page.evaluate(`document.querySelector('.reply-pending') === null`)).toBe(true);
  expect(await page.evaluate(`document.querySelector('[data-testid="paragraph-pending"]').textContent`)).toBe('Still **writing');
  await update(`thread.messages.pop();`);
  await page.waitFor(`document.querySelector('.answer-bubble [data-testid="typing-indicator"]')`);
  await update(`thread.status = 'waiting';`);
  await page.waitFor(`!document.querySelector('[data-testid="typing-indicator"]')`);
  await update(`thread.status = 'running'; thread.messages.at(-1).parts.push({type:'tool',toolId:'typing-tool',name:'Read',input:{file_path:'src/app.css'},output:null,status:'running'});`);
  await page.waitFor(`document.querySelector('[data-kind="tool"]')`);
  expect(await page.evaluate(`document.querySelector('[data-testid="typing-indicator"]') === null`)).toBe(true);
  await update(`thread.messages.push({...thread.messages[0],id:'tool-steer',createdAt:Date.now(),parts:[{type:'text',text:'Keep checking the layout.'}]});`);
  expect(await page.evaluate(`document.querySelector('[data-testid="typing-indicator"]') === null`)).toBe(true);
  await capture('quiet-chat-tool-steering');
  await update(`thread.messages.at(-2).parts.at(-1).status = 'done';`);
  await page.waitFor(`!document.querySelector('[data-testid="typing-indicator"]')`);
  await update(`thread.messages.pop();`);
  await update(`thread.messages.at(-1).parts.at(-1).status = 'done';`);
  await page.waitFor(`!document.querySelector('[data-testid="typing-indicator"]')`);
  await update(`thread.messages.at(-1).parts.push({type:'thinking',text:'Checking the result',startedAt:Date.now()});`);
  // Reasoning right after a call folds into that call's line, which says it is thinking.
  await page.waitFor(`document.querySelector('[data-testid="tool-group"][data-live="true"] [data-testid="tool-group-label"]')?.textContent === 'Thinking'`);
  expect(await page.evaluate(`document.querySelector('[data-testid="thinking-part"]') === null`)).toBe(true);
  expect(await page.evaluate(`document.querySelector('[data-testid="typing-indicator"]') === null`)).toBe(true);
  await update(`thread.messages.push({...thread.messages[0],id:'thinking-steer',createdAt:Date.now(),parts:[{type:'text',text:'Check the desktop too.'}]});`);
  expect(await page.evaluate(`document.querySelector('[data-testid="tool-group"][data-live="true"] .shimmer') !== null`)).toBe(true);
  expect(await page.evaluate(`document.querySelector('[data-testid="typing-indicator"]') === null`)).toBe(true);
  await capture('quiet-chat-thinking-steering');
  await page.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await capture('quiet-chat-thinking-steering-phone');
  expect(await page.evaluate(`document.querySelector('[data-testid="typing-indicator"]') === null`)).toBe(true);
  await page.send('Emulation.setDeviceMetricsOverride',{width:1300,height:850,deviceScaleFactor:1,mobile:false});
  await update(`thread.messages.at(-2).parts.at(-1).finishedAt = Date.now();`);
  await page.waitFor(`!document.querySelector('[data-testid="typing-indicator"]')`);
  await update(`thread.messages.pop();`);
  await update(`thread.messages.at(-1).parts = [{type:'text',text:'A complete answer.'}];`);
  await page.waitFor(`document.querySelectorAll('.receipts .received').length === 2`);
  await update(`thread.turns[0].status = 'stopped'; thread.status = 'idle';`);
  await page.waitFor(`!document.querySelector('[data-testid="typing-indicator"]')`);
  await update(`const turn = thread.turns[0]; turn.status = 'done'; turn.finishedAt = turn.startedAt + 3800; thread.status = 'idle'; thread.messages.at(-1).state = 'complete';`);
  await page.waitFor(`document.querySelector('[data-testid="turn-summary"]').dataset.status === 'done'`);
  expect(await page.evaluate(`document.querySelector('[data-testid="typing-indicator"]') === null`)).toBe(true);
  expect(await page.evaluate(`document.querySelector('[data-testid="turn-elapsed"]').textContent`)).toBe('Worked for 3s');
  expect(await page.evaluate(`document.querySelector('[data-testid="turn-finished-at"]').textContent`)).toMatch(/^done \d{1,2}:\d{2}/);
  expect(await page.evaluate(`document.querySelector('[data-testid="turn-tokens"]').textContent`)).toContain('tokens');
  await capture('quiet-chat-done');
}, 30000);
test('context opens on hover, shows exact segments, and compaction needs its own click', async () => {
  await update(`thread.context = {tokens:31000,window:200000,at:Date.now(),breakdown:{input:18000,cache:10000,output:3000}}; thread.sessionId = 'test-session'; window.__compactCalls = 0; store.compact = async () => {window.__compactCalls++;};`);
  await page.evaluate(`document.querySelector('[data-testid="context-meter"]').dispatchEvent(new MouseEvent('mouseenter'))`);
  await page.waitFor(`document.querySelector('[data-testid="context-popup"]')`);
  expect(await page.evaluate(`window.__compactCalls`)).toBe(0);
  expect(await page.evaluate(`document.querySelectorAll('[data-testid="context-popup"] .bar span').length`)).toBe(3);
  expect(await page.evaluate(`document.querySelector('[data-testid="context-popup"]').textContent.includes((31000).toLocaleString())`)).toBe(true);
  await capture('quiet-context-desktop');
  await page.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await capture('quiet-context-phone');
  expect(await page.evaluate(`(() => {const r = document.querySelector('[data-testid="context-popup"]').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth;})()`)).toBe(true);
  await page.evaluate(`document.documentElement.dataset.theme = 'light'`);
  await capture('quiet-context-light');
  await page.click('[data-testid="context-compact"]');
  await page.waitFor(`!document.querySelector('[data-testid="context-popup"]')`);
  expect(await page.evaluate(`window.__compactCalls`)).toBe(1);
}, 30000);

test('compaction stays distinct on desktop and phone, then yields to normal work', async () => {
  await update(`
    window.__compactionAnswer = JSON.parse(JSON.stringify(thread.messages.find(m=>m.role==='assistant')));
    const turn = thread.turns[0];
    turn.status = 'running'; turn.startedAt = Date.now() - 9000; turn.finishedAt = null; turn.usage = null;
    turn.execution = {...turn.execution, operation:'compact', automatic:true};
    thread.status = 'running'; thread.background = [];
    thread.messages = [{...thread.messages[0],role:'system',parts:[{type:'text',text:'Automatic compaction'}]}];
    thread.progress = null;
  `);
  await page.waitFor(`document.querySelector('[data-testid="turn-summary"].compacting')`);
  for (const phone of [false, true]) {
    await page.send('Emulation.setDeviceMetricsOverride', {width:phone?390:1280,height:phone?844:900,deviceScaleFactor:1,mobile:phone});
    expect(await page.evaluate(`document.querySelector('[data-testid="turn-summary"]').getAttribute('aria-label')`)).toBe('Compacting conversation');
    expect(await page.evaluate(`document.querySelector('[data-testid="compaction-elapsed"]').textContent`)).toMatch(/^Elapsed: \d+s$/);
    expect(await page.evaluate(`document.querySelector('[data-testid="typing-indicator"], [data-testid="turn-elapsed"], [role="progressbar"]') === null`)).toBe(true);
    expect(await page.evaluate(`(() => {const r=document.querySelector('[data-testid="turn-summary"]').getBoundingClientRect(); return r.left>=0 && r.right<=innerWidth;})()`)).toBe(true);
    await capture(phone ? 'compaction-phone' : 'compaction-desktop');
  }
  await update(`thread.turns[0].status='done'; thread.turns[0].finishedAt=thread.turns[0].startedAt+11000; thread.status='idle';`);
  await page.waitFor(`!document.querySelector('[data-testid="turn-summary"].compacting')`);
  expect(await page.evaluate(`document.querySelector('[data-testid="turn-elapsed"]').textContent`)).toBe('Compacted in 11s');
  await update(`
    const turn=thread.turns[0]; delete turn.execution.operation; turn.status='running'; turn.startedAt=Date.now()-120000; turn.finishedAt=null; thread.status='running';
    thread.progress={turnId:turn.id,phase:'compacting',detail:null,at:Date.now(),providerAt:Date.now()};
    thread.messages[0].role='user'; thread.messages[0].parts=[{type:'text',text:'Continue checking the layout.'}];
    thread.messages.push({...window.__compactionAnswer,state:'streaming',parts:[{type:'text',text:'A **finished** paragraph.\\n\\nAn **unfinished paragraph'}]});
  `);
  await page.waitFor(`document.querySelector('[data-testid="turn-summary"].compacting')`);
  expect(await page.evaluate(`document.querySelector('[data-testid="typing-indicator"], [data-testid="compaction-elapsed"], [data-testid="turn-provider-signal"]') === null`)).toBe(true);
  await update(`thread.progress.phase='working';`);
  await page.waitFor(`!document.querySelector('[data-testid="turn-summary"].compacting') && document.querySelector('[data-testid="typing-indicator"]')`);
  expect(await page.evaluate(`document.querySelector('[data-testid="turn-elapsed"]').textContent`)).toMatch(/^Working for /);
  expect(await page.evaluate(`document.querySelector('[data-testid="paragraph"] strong').textContent`)).toBe('finished');
  expect(await page.evaluate(`document.querySelector('[data-testid="paragraph-pending"]').textContent`)).toBe('An **unfinished paragraph');
  expect(await page.evaluate(`document.querySelector('[data-testid="paragraph-pending"] strong') === null`)).toBe(true);
  await update(`thread.turns[0].status='done';thread.turns[0].finishedAt=Date.now();thread.messages.at(-1).state='complete';thread.status='idle';thread.progress=null;`);
}, 30000);

test('running edits group by default and expose successful files and diffs on demand', async () => {
  await page.send('Emulation.setDeviceMetricsOverride', {width:1300,height:850,deviceScaleFactor:1,mobile:false});
  await update(`
    const {chatPrefs, readChatPrefs, CHAT_PREFS_STORAGE_KEY} = await import('/src/lib/chat-prefs.svelte.ts');
    window.__savedChatPrefs = {...chatPrefs};
    localStorage.removeItem(CHAT_PREFS_STORAGE_KEY);
    Object.assign(chatPrefs, readChatPrefs());
    const turn = thread.turns[0];
    turn.status = 'running'; turn.startedAt = Date.now(); turn.finishedAt = null;
    thread.status = 'running'; thread.progress = null; thread.background = [];
    const edit = (toolId, path, oldText, newText, status = 'done') => ({
      type:'tool', toolId, name:'Edit', input:{file_path:path,old_string:oldText,new_string:newText},
      output:null, status, documents:[{kind:'diff',path,oldText,newText}]
    });
    thread.messages = [
      {...thread.messages[0],role:'user',turnId:turn.id,parts:[{type:'text',text:'Update the two files.'}]},
      {...window.__answer,id:'running-edits',turnId:turn.id,state:'streaming',parts:[
        edit('edit-a1','a.ts','before','first'),
        edit('edit-b','b.ts','','created'),
        edit('edit-a2','a.ts','first','second'),
        edit('edit-pending','pending.ts','pending old','pending new','running'),
        edit('edit-failed','failed.ts','failed old','failed new','error')
      ]}
    ];
  `);
  try {
    await page.waitFor(`document.querySelector('[data-testid="turn-files"]') && document.querySelector('[data-testid="tool-group"][data-count="5"]')`);
    expect(await page.evaluate(`document.querySelectorAll('[data-testid="tool-group"]').length`)).toBe(1);
    expect(await page.evaluate(`document.querySelectorAll('[data-testid="turn-files"]').length`)).toBe(1);
    expect(await page.evaluate(`document.querySelector('[data-testid="turn-summary"]') === null`)).toBe(true);
    expect(await page.evaluate(`document.querySelector('[data-testid="tool-group-toggle"]').getAttribute('aria-expanded')`)).toBe('false');
    expect(await page.evaluate(`document.querySelector('[data-testid="turn-files-toggle"]').getAttribute('aria-expanded')`)).toBe('false');
    expect(await page.evaluate(`document.querySelector('[data-testid="turn-files-toggle"] .count').textContent`)).toBe('2');
    expect(await page.evaluate(`document.querySelector('[data-testid="turn-files-tree"], [data-testid="diff-view"]') === null`)).toBe(true);
    expect(await page.evaluate(`document.querySelector('[data-testid="turn-diff-toggle"]').getAttribute('aria-expanded')`)).toBe('false');
    expect(await page.evaluate(`document.querySelector('[data-testid="turn-files"] header .added').textContent`)).toBe('+3');
    expect(await page.evaluate(`document.querySelector('[data-testid="turn-files"] header .removed').textContent`)).toBe('-2');
    await capture('running-edits-desktop');
    await page.send('Emulation.setDeviceMetricsOverride', {width:390,height:844,deviceScaleFactor:1,mobile:true});
    await capture('running-edits-phone');
    expect(await page.evaluate(`(() => {const r=document.querySelector('[data-testid="turn-files"]').getBoundingClientRect(); return r.left>=0 && r.right<=innerWidth;})()`)).toBe(true);
    await page.send('Emulation.setDeviceMetricsOverride', {width:1300,height:850,deviceScaleFactor:1,mobile:false});

    await page.click('[data-testid="tool-group-toggle"]');
    await page.waitFor(`document.querySelectorAll('[data-testid="tool-card"]').length === 5`);
    expect(await page.evaluate(`Array.from(document.querySelectorAll('[data-testid="tool-toggle"]')).every(button => button.getAttribute('aria-expanded') === 'false')`)).toBe(true);
    expect(await page.evaluate(`document.querySelector('[data-testid="tool-document"][data-kind="diff"]') === null`)).toBe(true);
    await page.click('[data-testid="tool-group-toggle"]');
    await page.click('[data-testid="turn-files-toggle"]');
    await page.waitFor(`document.querySelectorAll('[data-testid="turn-file"]').length === 2`);
    expect(await page.evaluate(`Array.from(document.querySelectorAll('[data-testid="turn-file"] .name')).map(node => node.textContent)`)).toEqual(['a.ts', 'b.ts']);
    expect(await page.evaluate(`Array.from(document.querySelectorAll('[data-testid="turn-files-tree"] .row')).map(node => [node.querySelector('.name').textContent,node.querySelector('.added').textContent,node.querySelector('.removed').textContent])`)).toEqual([['a.ts', '+2', '-2'], ['b.ts', '+1', '-0']]);

    await update(`const {setChatPref} = await import('/src/lib/chat-prefs.svelte.ts'); setChatPref('expandDiffs',true);`);
    await page.waitFor(`document.querySelectorAll('[data-testid="turn-diff"] [data-testid="diff-view"]').length === 3`);
    await update(`const {setChatPref} = await import('/src/lib/chat-prefs.svelte.ts'); setChatPref('expandDiffs',false);`);
    await page.waitFor(`!document.querySelector('[data-testid="turn-diff"]')`);
    await page.click('[data-testid="turn-diff-toggle"]');
    await page.waitFor(`document.querySelectorAll('[data-testid="turn-diff"] [data-testid="diff-view"]').length === 3`);
    expect(await page.evaluate(`Array.from(document.querySelectorAll('[data-testid="turn-diff"] [data-testid="diff-view"]')).map(node => node.dataset.path)`)).toEqual(['a.ts', 'b.ts', 'a.ts']);
    expect(await page.evaluate(`document.querySelector('[data-testid="turn-diff"]').textContent.includes('second')`)).toBe(true);
    await page.click('[data-testid="turn-diff-toggle"]');
    await page.waitFor(`!document.querySelector('[data-testid="turn-diff"]')`);

    await update(`const {setChatPref} = await import('/src/lib/chat-prefs.svelte.ts'); setChatPref('groupChanges',false);`);
    await page.waitFor(`!document.querySelector('[data-testid="turn-files"]')`);
    await update(`const {setChatPref} = await import('/src/lib/chat-prefs.svelte.ts'); setChatPref('groupChanges',true);`);
    await page.waitFor(`document.querySelector('[data-testid="turn-files-toggle"][aria-expanded="false"]') && document.querySelector('[data-testid="tool-group"][data-count="5"]')`);
    await update(`thread.turns[0].status='done';thread.turns[0].finishedAt=Date.now();thread.status='idle';thread.messages.at(-1).state='complete';`);
    await page.waitFor(`document.querySelector('[data-testid="turn-summary"]').dataset.status === 'done'`);
    expect(await page.evaluate(`document.querySelectorAll('[data-testid="turn-files"]').length`)).toBe(1);
    expect(await page.evaluate(`document.querySelector('[data-testid="turn-files-toggle"] .count').textContent`)).toBe('2');
  } finally {
    await update(`const {setChatPref} = await import('/src/lib/chat-prefs.svelte.ts'); for (const [key,value] of Object.entries(window.__savedChatPrefs)) setChatPref(key,value);`);
  }
}, 30000);
