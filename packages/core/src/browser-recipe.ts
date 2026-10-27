/*
 * `boite browser recipe`: `browser run` scripts kept on this machine under a
 * name, so the next agent with the same task on the same site runs it in one
 * call instead of driving the pages again. A script is kept only once a run
 * of it passed. A run that fails is recorded on the recipe and prints the
 * page it stopped on with the way to repair it: the agent that hit the
 * failure fixes the script against that page and saves it again, with no one
 * else involved.
 */
import { browserActionError, browserRecipeNameError, type BrowserAction, type BrowserRecipe } from '@boite/contracts';
import type { CoreClient } from './client.ts';
import type { CliIo } from './cli.ts';
import { ago } from './agents-cli.ts';
import { option } from './browser-cli.ts';
import { BrowserScriptFailure, readScript, runBrowserScript, takeScriptTab } from './browser-run.ts';

type Stored = BrowserRecipe & { source: string };
const RECIPE_SITES_MAX = 20;
const NOT_A_COMMAND = 'use list, run, save, show or delete; boite browser help describes them';

/** What `recipe list` shows of one recipe: what it does, how to run it and whether it still works. */
export function recipeLines(recipe: BrowserRecipe, now = Date.now()): string[] {
  const last = recipe.lastRun;
  const state = !last ? 'never run'
    : last.ok ? `${recipe.runs} ${recipe.runs === 1 ? 'run' : 'runs'}, last passed ${ago(last.at, now)}`
    : `broken since ${ago(last.at, now)}: ${last.error ?? 'a step failed'}; repair it before relying on it`;
  return [
    `${recipe.name}  ${recipe.about}`,
    `  boite browser recipe run ${recipe.name}${recipe.usage ? ` ${recipe.usage}` : ''}`,
    `  ${recipe.sites.length ? recipe.sites.join(', ') : 'any site'}; ${state}`,
  ];
}

export async function browserRecipe(args: string[], io: CliIo, client: CoreClient, threadId: string): Promise<{ lines: string[]; value: unknown }> {
  const [sub, ...rest] = args;
  const call = async (action: BrowserAction) => (await client.call('browser.command', { threadId, action })).value;
  const name = (command: string) => {
    const word = rest.shift();
    if (word === undefined) throw new Error(`browser recipe ${command} needs a recipe name; browser recipe list shows them`);
    const problem = browserRecipeNameError(word);
    if (problem) throw new Error(problem);
    return word;
  };
  const none = (command: string) => { if (rest.length) throw new Error(`browser recipe ${command} takes no ${rest[0]}`); };
  switch (sub) {
    case undefined: case 'list': {
      none('list');
      const { recipes } = await call({ kind: 'recipes' }) as { recipes: BrowserRecipe[] };
      if (!recipes.length) return { lines: ['no recipe on this machine yet; once a task works as a script, keep it with browser recipe save'], value: { recipes } };
      return { lines: recipes.flatMap(recipe => recipeLines(recipe)), value: { recipes } };
    }
    case 'show': {
      const recipe = await call({ kind: 'recipe-get', name: name('show') }) as Stored;
      none('show');
      return { lines: [...recipeLines(recipe), '', recipe.source], value: recipe };
    }
    case 'delete': {
      const recipe = name('delete');
      none('delete');
      await call({ kind: 'recipe-delete', name: recipe });
      return { lines: [`✓ Deleted recipe ${recipe}`], value: { name: recipe, deleted: true } };
    }
    case 'save': return save(rest, io, client, threadId);
    case 'run': return run(rest, io, client, threadId);
    default: throw new Error(`browser recipe ${sub} is not a command; ${NOT_A_COMMAND}`);
  }
}

/**
 * Runs the script with the given words first: a recipe is kept only once it
 * worked, under the sites that run visited.
 */
async function save(words: string[], io: CliIo, client: CoreClient, threadId: string): Promise<{ lines: string[]; value: unknown }> {
  const rest = [...words];
  let about = option(rest, '--about', 'recipe save');
  let usage = option(rest, '--usage', 'recipe save');
  const tab = option(rest, '--tab', 'recipe save');
  const name = rest.shift();
  if (name === undefined) throw new Error('browser recipe save needs a name, then the script file or - for stdin');
  const problem = browserRecipeNameError(name);
  if (problem) throw new Error(problem);
  const file = rest.shift();
  if (file === undefined || file === '') throw new Error(`browser recipe save ${name} needs the script file, or - to read it from stdin`);
  if (about === undefined || usage === undefined) {
    // Saving a repaired script again keeps what the recipe said about itself.
    const previous = await client.call('browser.command', { threadId, action: { kind: 'recipe-get', name } }).then(reply => reply.value as Stored).catch(() => null);
    about ??= previous?.about;
    usage ??= previous?.usage;
  }
  if (about === undefined) throw new Error(`browser recipe save ${name} needs --about "<what it does>": no recipe of that name to keep it from`);
  const { source } = await readScript(file, io, 'recipe save');
  const draft = { kind: 'recipe-save' as const, name, about, ...(usage ? { usage } : {}), source, sites: [] as string[] };
  const refused = browserActionError(draft);
  if (refused) throw new Error(refused);
  let ran: Awaited<ReturnType<typeof runBrowserScript>>;
  try { ran = await runBrowserScript({ source, name: `${name}.js`, args: rest, ...(tab ? { tab } : {}) }, io, client, threadId); }
  catch (error) {
    if (!(error instanceof BrowserScriptFailure)) throw error;
    throw new Error(`recipe ${name} not saved: its run stopped at ${error.where}; fix the script and save it again`);
  }
  const sites = ran.sites.length ? ran.sites : await endSite(client, threadId, tab);
  const saved = await client.call('browser.command', { threadId, action: { ...draft, sites: sites.slice(0, RECIPE_SITES_MAX) } }).then(reply => reply.value as BrowserRecipe);
  return { lines: [...ran.lines, `✓ Kept recipe ${name}`, ...recipeLines(saved).slice(1)], value: { recipe: saved, run: ran.value } };
}

/** The site a script that opened nothing ended on: the one it worked in. */
async function endSite(client: CoreClient, threadId: string, tab: string | undefined): Promise<string[]> {
  const status = await client.call('browser.command', { threadId, action: { kind: 'status' } }).catch(() => null);
  const tabs = (status?.value as { tabs?: Array<{ tabId: string; url: string; active: boolean }> } | undefined)?.tabs ?? [];
  const url = tabs.find(one => tab ? one.tabId === tab : one.active)?.url;
  try { return url && /^https?:$/.test(new URL(url).protocol) ? [new URL(url).hostname.toLowerCase()] : []; } catch { return []; }
}

async function run(words: string[], io: CliIo, client: CoreClient, threadId: string): Promise<{ lines: string[]; value: unknown }> {
  const rest = [...words];
  const { word: name, tab } = takeScriptTab(rest, 'recipe run', 'a recipe name; browser recipe list shows them');
  const problem = browserRecipeNameError(name);
  if (problem) throw new Error(problem);
  const recipe = (await client.call('browser.command', { threadId, action: { kind: 'recipe-get', name: name! } })).value as Stored;
  const record = (ok: boolean, error?: string) => client.call('browser.command', { threadId, action: { kind: 'recipe-result', name: name!, ok, ...(error ? { error: error.slice(0, 2000) } : {}) } }).catch(() => null);
  try {
    const ran = await runBrowserScript({ source: recipe.source, name: `${name}.js`, args: rest, ...(tab ? { tab } : {}) }, io, client, threadId);
    await record(true);
    return { lines: ran.lines, value: ran.value };
  } catch (error) {
    const failure = error instanceof BrowserScriptFailure ? error : null;
    const reason = failure ? `${failure.where}: ${failure.reason}` : error instanceof Error ? error.message : String(error);
    await record(false, reason);
    io.out([
      `recipe ${name} needs a repair: the site changed or the script missed a case.`,
      `boite browser recipe show ${name} prints its script; fix it against the page above, then`,
      `boite browser recipe save ${name} <file|-> ${recipe.usage ?? '[args...]'} runs it and keeps it under the same name.`,
    ].join('\n') + '\n');
    throw new Error(`recipe ${name} stopped at ${failure ? failure.where : reason}`);
  }
}
