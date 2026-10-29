import type { Translation } from '../../i18n.svelte';

export const fr: Translation = {
  windows: {
    panel: {
      cover: 'Un agent a ouvert ici une fenêtre de {machine}', coverHint: "Rien n'est capturé tant que vous ne l'affichez pas.",
      show: 'Afficher', hide: 'Masquer', hideHint: 'Arrêter de regarder et recouvrir la vue',
      close: 'Fermer', closeHint: 'Fermer le panneau Fenêtre ; un agent peut le rouvrir',
      empty: "Aucune fenêtre n'est ouverte dans cette conversation. Un agent en ouvre une avec boite window watch.",
      readOnly: "Lecture seule : vos actions ici n'agissent pas sur la fenêtre.",
      waiting: 'En attente de la première image…',
      picture: 'Vue en direct de {process}'
    },
    capture: {
      screenshot: "Capture d'écran", clip: 'Séquence de {count} images', stream: 'Vue en direct',
      open: 'Ouvrir la capture de {process}', alt: 'Capture de {process}'
    },
    consent: {
      asks: '{agent} veut capturer {process}', anAgent: 'Un agent',
      screenshot: "Une capture d'écran", clip: 'Une courte séquence', stream: 'Une vue en direct dans le panneau Fenêtre',
      waits: "La capture attend votre réponse jusqu'à {time}.",
      once: 'Autoriser une fois', always: 'Toujours pour ce projet', refuse: 'Refuser',
      allowedOnce: 'Autorisé une fois : {process}', allowedAlways: 'Toujours autorisé dans ce projet : {process}',
      refused: 'Refusé : {process}', expired: 'Délai de réponse dépassé : {process}'
    },
    settings: {
      allowedHeading: 'Fenêtres autorisées', allowedIntro: "Les agents d'un projet peuvent capturer les fenêtres de ces applications sans demander votre accord. Une application est ajoutée quand vous choisissez Toujours pour ce projet dans une demande de capture.",
      allowedEmpty: "Aucune application n'est encore autorisée. Les applications sont ajoutées depuis une demande de capture dans la conversation.",
      remove: 'Retirer', removeTitle: 'Ne plus autoriser {process} ?', removeBody: 'Les agents du projet {project} demanderont de nouveau votre accord avant de capturer {process}.',
      exclusionsHeading: 'Ne jamais capturer', exclusionsIntro: 'Aucun agent ne peut capturer les fenêtres de ces exécutables, même avec votre accord. Indiquez leur nom ou leur chemin.',
      always: "Les gestionnaires de mots de passe et l'écran de connexion sont toujours exclus : {list}.",
      add: 'Ajouter', addLabel: "Nom ou chemin de l'exécutable", placeholder: 'game.exe ou C:\\Games\\game.exe',
      none: "Aucune autre application n'est exclue.", removeExclusion: 'Ne plus exclure {name}'
    }
  }
};
