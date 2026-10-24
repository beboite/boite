import type { Translation } from '../../i18n.svelte';

export const fr: Translation = {

  experiments: {
    pinnedQuotas: { title: 'Quotas du modèle épinglés', hint: 'Épingler les limites du fournisseur du modèle dans un coin de la discussion ou sous la liste des conversations' },
    recordingIndicators: { title: 'Actions visibles dans les vidéos', hint: 'Ajouter des repères de clics et les touches de navigation aux enregistrements. Le texte saisi et les mots de passe ne sont jamais affichés comme libellés de touches.' },
    goal2: {
      title: 'Objectifs relus',
      hint: "Ajoute /goal2 : un autre modèle écrit la checklist de tout ce que vous avez demandé, la met à jour quand vous ajoutez ou changez quelque chose et, après chaque tour de l'agent, lui dit ce qui reste à faire. Quand l'agent annonce l'objectif atteint, une nouvelle conversation qui n'a pas vu son travail le vérifie et répond validé, partiel ou refusé. Tout ce qui n'est pas validé repart à l'agent, jusqu'à cinq relectures",
      trackerModel: 'Modèle de la checklist',
      trackerModelHint: "Écrit la checklist à partir de vos messages et la vérifie après chaque tour de l'agent, sur cette machine. Automatique prend Opus en medium ou Sol en high, d'abord celui de l'agent de la conversation, sinon le modèle de la conversation. Un petit modèle oublie et inverse des demandes sur les longs prompts.",
      trackerAuto: 'Automatique',
      trackerAutoHint: 'Opus medium ou Sol high',
      trackerEffort: 'Raisonnement du modèle de la checklist',
      trackerEffortDefault: 'Par défaut'
    },
    whip: {
      title: 'Fouet',
      hint: 'Un fouet animé suit le pointeur ou le doigt. Un geste vif le fait claquer, un clic ou un appui le lâche',
      action: 'Sortir le fouet',
      drop: 'Lâcher le fouet'
    },
    themeGrain: {
      title: 'Thème Grain',
      hint: 'Un fond grainé qui passe du gris clair en haut à gauche au noir en bas à droite'
    },
    sessionImport: {
      title: 'Import de session Claude Code',
      hint: 'Transformer une session lancée dans le terminal en conversation, depuis le menu du projet et la palette'
    },
    promptCache: {
      title: 'Minuteur du cache de prompt',
      hint: 'Une horloge à côté de la jauge de contexte, qui décompte le temps pendant lequel le provider garde la conversation en cache'
    },
    residentAgents: {
      title: 'Bots',
      hint: 'Des bots : des agents permanents avec leur propre brain, leur mémoire et leurs routines, depuis la barre latérale. Les bots déjà créés continuent de tourner quand ceci est désactivé'
    },
    contacts: {
      title: 'Contacts',
      hint: 'Une page Accueil à côté des conversations, où vous reliez votre Boite à celle d\'un autre propriétaire via Tailscale, pour que vos agents et les siens travaillent ensemble sur les projets que chacun ouvre. Pas encore prêt pour un usage quotidien'
    }
  }
};
