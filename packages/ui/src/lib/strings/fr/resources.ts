import type { Translation } from '../../i18n.svelte';

export const fr: Translation = {
  resources: {
    memory: 'Mémoire',
    resolved: (mb: number) => `${Math.round(mb)} Mo`,
    auto: (mb: number) => `Auto : ${Math.round(mb)} Mo`,
    agents: 'Agents / budget',
    available: 'Disponible / réserve',
    unknown: 'Indisponible',
    state: 'État de la protection',
    states: { ok: 'Mémoire suffisante', critical: 'Limite de mémoire dépassée' },
    killTitle: 'Processus arrêté pour libérer de la mémoire',
    killCount: (count: number) => `${count} processus arrêtés pour libérer de la mémoire`,
    stoppedProcesses: (count: number) => `Voir les ${count} processus arrêtés`,
    memorySettings: 'Réglages mémoire',
    protectionOff: 'Protection mémoire désactivée',
    killReason: {
      'thread-quota': (limit: string) => `Cette conversation a dépassé sa limite mémoire de ${limit}.`,
      budget: (limit: string) => `Les agents ont dépassé leur budget mémoire commun de ${limit}.`,
      machine: (limit: string) => `La mémoire disponible est passée sous la réserve de ${limit}.`,
    },
    threadCap: 'Cette conversation a atteint sa limite de mémoire. Boite a refusé de lui en accorder davantage.',
    budget: "Les agents ont atteint leur budget mémoire commun. Boite a refusé de leur en accorder davantage.",
    throttled: (limit: string) => `Les processus de cette conversation sont ralentis par leur limite mémoire de ${limit}. Ils se figent au lieu d'échouer.`,
    empty: 'Rien ne tourne en ce moment.',
    processes: 'processus',
    killTree: "Tuer l'arborescence",
    killConfirm: 'Tuer tous les processus de cette conversation ?',
    killConfirmYes: 'Tuer',
  }
};
