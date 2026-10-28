/*
 * Recipes: `boite browser run` scripts kept on this machine under a name
 * (`boite browser recipe`). The core only stores them, one JSON file each in
 * `<data>/browser-recipes/`, outside `browser/` whose unknown folders the
 * profile cleanup removes. A recipe runs in the agent's CLI process, as any
 * script of its own would, never in the core.
 */
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BROWSER_RECIPES_MAX, browserRecipeNameError, type BrowserAction, type BrowserRecipe } from '@boite/contracts';
import { notFound, refused } from '../errors.ts';

type Stored = BrowserRecipe & { source: string };

export class BrowserRecipes {
  constructor(private readonly dataDir: () => string) {}

  #dir(): string { return join(this.dataDir(), 'browser-recipes'); }
  #file(name: string): string {
    const problem = browserRecipeNameError(name);
    if (problem) throw refused(problem);
    return join(this.#dir(), `${name}.json`);
  }

  #read(name: string): Stored | null {
    // A bad name is refused with the pattern, not reported missing.
    const path = this.#file(name);
    try {
      const stored = JSON.parse(readFileSync(path, 'utf8')) as Stored;
      return stored && stored.name === name && typeof stored.source === 'string' ? stored : null;
    } catch { return null; }
  }

  #write(recipe: Stored): void {
    mkdirSync(this.#dir(), { recursive: true });
    const path = this.#file(recipe.name), temporary = `${path}.${crypto.randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(recipe, null, 2), { mode: 0o600, flag: 'wx' });
    try { renameSync(temporary, path); }
    catch (error) { rmSync(temporary, { force: true }); throw error; }
  }

  #names(): string[] {
    try { return readdirSync(this.#dir()).filter(file => file.endsWith('.json')).map(file => file.slice(0, -5)).filter(name => browserRecipeNameError(name) === null).sort(); }
    catch { return []; }
  }

  list(): BrowserRecipe[] {
    return this.#names().flatMap(name => {
      const stored = this.#read(name);
      if (!stored) return [];
      const { source: _source, ...recipe } = stored;
      return [recipe];
    });
  }

  get(name: string): Stored {
    const stored = this.#read(name);
    if (!stored) throw notFound(`no recipe ${name} on this machine; browser recipe list shows them`);
    return stored;
  }

  /** Replacing a recipe keeps its run count; the run that proved the new script is one more. */
  save(action: Extract<BrowserAction, { kind: 'recipe-save' }>): BrowserRecipe {
    const previous = this.#read(action.name);
    if (!previous && this.#names().length >= BROWSER_RECIPES_MAX) throw refused(`this machine keeps at most ${BROWSER_RECIPES_MAX} recipes; delete one first`);
    const now = Date.now();
    const recipe: Stored = {
      name: action.name, about: action.about.trim(), ...(action.usage?.trim() ? { usage: action.usage.trim() } : {}),
      sites: [...new Set(action.sites.map(site => site.toLowerCase()))], savedAt: now,
      runs: (previous?.runs ?? 0) + 1, lastRun: { at: now, ok: true }, source: action.source,
    };
    this.#write(recipe);
    const { source: _source, ...saved } = recipe;
    return saved;
  }

  delete(name: string): void {
    if (!this.#read(name)) throw notFound(`no recipe ${name} on this machine; browser recipe list shows them`);
    rmSync(this.#file(name), { force: true });
  }

  result(name: string, ok: boolean, error?: string): BrowserRecipe {
    const stored = this.get(name);
    const updated: Stored = { ...stored, runs: stored.runs + 1, lastRun: { at: Date.now(), ok, ...(error ? { error } : {}) } };
    this.#write(updated);
    const { source: _source, ...recipe } = updated;
    return recipe;
  }
}
