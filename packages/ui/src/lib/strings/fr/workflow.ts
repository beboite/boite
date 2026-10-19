import type { Translation } from '../../i18n.svelte';

export const fr: Translation = {

  workflow: {
    activeOne: '1 workflow',
    activeMany: '{count} workflows',
    status: { running: 'En cours', paused: 'En pause', done: 'Terminé', failed: 'En échec', stopped: 'Arrêté' },
    stepStatus: { waiting: 'En attente', running: 'En cours', done: 'Terminée', failed: 'En échec', skipped: 'Sautée', stopped: 'Arrêtée' },
    steps: '{done}/{total} étapes',
    phase: 'Phase {n}',
    pause: 'Pause',
    resume: 'Reprendre',
    stop: 'Arrêter',
    retry: 'Relancer',
    stopTitle: 'Arrêter « {name} » ?',
    stopBody: "Les étapes en cours s'arrêtent et les suivantes ne démarrent pas. Les étapes finies gardent leurs résultats.",
    forEach: 'Une par élément de {path}',
    after: 'Après {steps}',
    condition: 'Seulement si {path}',
    task: 'Tâche',
    result: 'Résultat',
    output: 'Sortie',
    items: 'Exécutions',
    openThread: 'Ouvrir la conversation',
    back: 'Retour au graphe',
    close: 'Fermer le détail',
    notStarted: 'Pas encore démarrée.',
    skipped: "Sautée : sa condition n'était pas remplie.",
    card: 'Workflow',
    show: 'Voir le workflow',
    tokens: '{tokens} jetons'
  }
};
