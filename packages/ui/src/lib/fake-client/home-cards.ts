/** The owner's home cards as the core lists them (`packages/core/src/home-cards.ts`), on `?fake=1&home=1`. */
import { RpcErrorCode, type HomeCard } from '@boite/contracts';
import { RpcFailure } from '../client';
import { refusal } from './shared';
import type { FakeContext, FakeMethods } from './context';

/**
 * One card with every part the view draws: a status, figures in each tone,
 * two lists whose rows carry details, a note, and a refresh every 30 minutes.
 * Measured from the page's clock, so it reads as fresh.
 */
export function seedHomeCards(now = Date.now()): HomeCard[] {
  return [{
    id: 'release-train',
    changedAt: now - 4 * 60_000,
    error: null,
    refresh: { everyMinutes: 30, running: false, lastRun: { at: now - 4 * 60_000, ok: true, message: null } },
    content: {
      title: { en: 'Release train', fr: 'Train de release' },
      status: { tone: 'ok', text: { en: 'Pipeline healthy', fr: 'Pipeline en forme' } },
      updatedAt: now - 4 * 60_000,
      stats: [
        { label: { en: 'Shipped', fr: 'Livrés' }, value: 12, tone: 'ok' },
        { label: { en: 'Ready', fr: 'Prêts' }, value: 3, tone: null },
        { label: { en: 'Running', fr: 'En cours' }, value: 2, tone: 'warn' },
        { label: { en: 'Failing', fr: 'En échec' }, value: 0, tone: 'bad' },
      ],
      lists: [
        {
          title: { en: 'Ready to start', fr: 'Prêts à partir' },
          items: [
            { label: 'android-store', detail: { en: 'Signed bundle built, waiting for the store review slot.', fr: 'Bundle signé, en attente du créneau de revue.' }, tone: null },
            { label: 'docs-site', detail: { en: 'Preview approved; publish after the changelog lands.', fr: 'Aperçu validé ; publier après le changelog.' }, tone: null },
            { label: 'cli-arm64', detail: null, tone: null },
          ],
        },
        {
          title: { en: 'Running', fr: 'En cours' },
          items: [
            { label: 'desktop-win', detail: { en: 'Started 12 minutes ago on runner 2.', fr: 'Lancé il y a 12 minutes sur le runner 2.' }, tone: 'warn' },
            { label: 'server-image', detail: { en: 'Pushing layers.', fr: 'Envoi des couches.' }, tone: 'warn' },
          ],
        },
      ],
      note: {
        en: 'Your call: the store listing still uses last month\'s screenshots.\nNothing else waits on you.',
        fr: 'À toi de voir : la fiche du store garde les captures du mois dernier.\nRien d\'autre ne t\'attend.',
      },
    },
  }];
}

export function homeCardMethods(ctx: FakeContext) {
  const runs = new Map<string, Promise<HomeCard>>();
  const publish = () => ctx.emit('homeCards.updated', structuredClone(ctx.homeCards));
  return {
    'homeCards.list': async () => structuredClone(ctx.homeCards),
    'homeCards.refresh': async ({ id }) => {
      const running = runs.get(id);
      if (running) return running;
      const card = ctx.homeCards.find(entry => entry.id === id);
      if (!card) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: `id: no home card "${id}" in home-cards` });
      if (!card.refresh) throw refusal(`${id} has no usable refresh.json in home-cards/${id}`);
      const refresh = card.refresh;
      const run = (async () => {
        refresh.running = true;
        publish();
        await new Promise(resolve => setTimeout(resolve, Math.max(ctx.delayMs * 30, 0)));
        const now = Date.now();
        refresh.running = false;
        refresh.lastRun = { at: now, ok: true, message: null };
        card.changedAt = now;
        if (card.content) card.content.updatedAt = now;
        runs.delete(id);
        publish();
        return structuredClone(card);
      })();
      runs.set(id, run);
      return run;
    },
  } satisfies Partial<FakeMethods>;
}
