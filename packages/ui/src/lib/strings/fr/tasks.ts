import type { Translation } from '../../i18n.svelte';

export const fr: Translation = {

  tasks: {
    goalSection: 'Objectif et boucle',
    noActivity: "Aucun objectif ni boucle sur cette conversation",
    nextRun: 'Prochain passage {time}',
    iterations: '{count} itérations',
    agentSection: "Tâches de l'agent",
    todoSection: 'Todos du projet',
    noTodos: 'Aucun todo sur ce projet',
    addPlaceholder: 'Ajouter un todo',
    add: 'Ajouter',
    awaiting: 'Vous attend',
    awaitingHint: 'Cette carte attend votre confirmation',
    markOpen: 'Remettre à faire',
    markClaimed: 'Marquer comme vous attendant',
    markDone: 'Confirmer que c\'est fait',
    removeTodo: 'Supprimer ce todo',
    collapse: 'Replier cette section',
    expand: 'Déplier cette section',
    watchSection: 'PR surveillées',
    noWatches: 'Aucune PR surveillée',
    watchHint: 'Boite lit la PR sur GitHub environ une fois par minute et réveille l’agent quand un check échoue, que les checks passent, qu’une review ou un commentaire arrive, que la branche entre en conflit ou qu’elle sort de la file de merge sans être mergée',
    watchNotRead: 'Pas encore lue',
    watchNoChecks: 'Aucun check',
    watchChecks: '{total} checks',
    watchRunning: '{count} en cours',
    watchFailed: '{count} en échec',
    watchConflict: 'En conflit avec {base}',
    watchQueued: 'File de merge, position {position}',
    watchRateLimited: 'Limite de requêtes GitHub, prochaine lecture {time}',
    watchUnreachable: 'GitHub injoignable, prochaine lecture {time}',
    stopWatch: 'Arrêter la surveillance',
    stopWatchOf: 'Ne plus surveiller #{number}'
  }
};
