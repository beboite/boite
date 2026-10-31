import type { Translation } from '../../i18n.svelte';

export const fr: Translation = {

  experiments: {
    pinnedQuotas: { title: 'Quotas du modèle épinglés', hint: 'Épingler les limites du fournisseur du modèle dans un coin de la discussion ou sous la liste des conversations' },
    recordingIndicators: { title: 'Actions visibles dans les vidéos', hint: 'Ajouter des repères de clics et les touches de navigation aux enregistrements. Le texte saisi et les mots de passe ne sont jamais affichés comme libellés de touches.' },
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
    },
    autoGoal: {
      title: 'Objectifs automatiques',
      hint: "Un long message lance un objectif relu sur lui-même, avec sa checklist et une carte sur le tableau du projet, et l'agent peut en lancer un quand un message liste plusieurs demandes. Retirez l'objectif depuis la barre d'objectif pour l'abandonner",
      minChars: 'Longueur du message',
      minCharsHint: 'Un message qui lance un tour avec au moins ce nombre de caractères lance un objectif automatique',
      unit: 'caractères'
    },
    teams: {
      title: 'Équipes',
      hint: "Des bots qui travaillent ensemble dans une conversation commune : un message réveille les bots qu'il nomme, et chacun répond au groupe ou en privé. Vos bots y écrivent avec boite team. Pas encore prêt pour un usage quotidien"
    }
  }
};
