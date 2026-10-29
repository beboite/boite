import type { Translation } from '../../i18n.svelte';

export const fr: Translation = {

  onboarding: {
    privacy: {
      title: 'VENDEZ VOTRE ÂME À BOITE !',
      intro: 'Quelques stats anonymes nous disent quoi corriger en premier. Vos messages, fichiers et comptes ne quittent jamais votre machine.',
      question: 'Marché conclu ?',
      video: 'Mème Trade Offer',
      basic: 'NON ! Juste les compteurs de base',
      basicDefault: '(par défaut)',
      basicHint: 'Des compteurs anonymes, aucun profil.',
      deal: 'MARCHÉ CONCLU',
      dealHint: 'Aussi les modèles et réglages utilisés. Merci !',
      details: "De base : installations actives sous un identifiant aléatoire haché, et lancements, conversations et résultats des tours sous des identifiants qui changent chaque jour. Aucun profil. Marché conclu ajoute les modèles publics choisis, le niveau de raisonnement, les modes de vitesse et de permission, les durées et les volumes de jetons, sous un identifiant aléatoire stable ; les modèles privés comptent comme « autre ». L'application marche pareil dans tous les cas, et les réglages le changent quand vous voulez.",
      optOut: 'Si vous ne voulez VRAIMENT pas aider Boite :',
      offLabel: "désactiver les statistiques d'usage :c",
      doc: 'Ce qui est collecté'
    },
    demo: {
      pause: 'Pause', play: 'Rejouer', resume: 'Reprendre',
      record: 'Cliquez sur le micro', speak: 'Dictez votre message', review: "Relisez avant d'envoyer",
      listening: 'Écoute en cours', draft: 'Votre brouillon', localLabel: 'Sur cet ordinateur',
      chooseAgent: "Choisissez l'agent suivant", handoff: 'Codex reprend la conversation', checked: 'Libellés vérifiés. Contraste amélioré.', nextMessage: 'Écrire à Codex',
      before: 'Avant', after: 'Après', buttonBefore: 'Envoyer', buttonAfter: 'Envoyer le message', changedFile: 'ContactForm.svelte', changesReady: 'Deux lignes modifiées',
      background: 'En cours en arrière-plan', writing: 'Préparer le lancement de demain', notes: 'Notes', noteOne: 'Relire le formulaire de contact', noteTwo: 'Publier le portfolio',
      taskResult: 'Formulaire prêt', loginResult: 'Connexion réparée', testsResult: 'Tests réussis', hoverTray: "Survolez l'icône Boite",
      conversation: "Changer d'agent", voice: 'Dicter', panel: 'Voir les modifications',
      task: 'Créer mon portfolio', secondTask: 'Réparer la connexion', thirdTask: 'Écrire les tests', working: 'En cours', request: 'Ajoute un formulaire de contact', answer: 'Le formulaire est prêt.', followup: "Vérifie maintenant l'accessibilité", continued: 'Même conversation. Même historique.',
      voiceWords: 'Rends les boutons plus lisibles', voiceHint: 'Parlez, relisez le brouillon, puis envoyez.',
      changes: 'Modifications', reviewed: 'Relisez les changements à côté du chat.',
      usageLabel: 'Claude', window: 'Limite sur 5 h', used: '24 % utilisés', reset: 'Réinitialisation dans 2 h 10', trayHint: "Survolez l'icône Boite pour voir vos limites sans ouvrir l'application.",
      desktop: 'Votre ordinateur', phone: 'Votre téléphone', synced: 'La même conversation', reachHint: "Après un appairage par QR code, suivez vos agents sur votre téléphone. Votre ordinateur continue de les faire tourner.",
      notification: 'Formulaire de contact terminé', quietBody: "Vos agents travaillent sans prendre votre écran ni vos haut-parleurs.",
      installVoice: 'Installer la dictée locale', downloadVoice: 'Environ 200 Mo. Le son reste sur cet ordinateur.', installingVoice: 'Téléchargement du moteur vocal', cancelVoice: 'Annuler le téléchargement', readyVoice: 'La dictée est prête. Utilisez le micro du champ de message.',
    },
    label: 'Prise en main',
    skip: 'Passer',
    back: 'Retour',
    next: 'Suivant',
    done: 'À moi de boiter',
    step: 'Étape {index} sur {total}',
    progress: "Aller à l'étape {index} : {title}",
    replay: 'Revoir la présentation',
    changeLater: 'Tout ça se retrouve dans les réglages.',

    profile: {
      title: "D'abord, lequel êtes-vous ?",
      everyday: "Je ne suis pas dev ! Ne m'embrouillez pas avec du code et des commandes !",
      everydayHint: "Une nouvelle conversation attend dans Documents/Boite jusqu'à ce que vous lui donniez un dossier, et l'agent demande avant d'agir.",
      developer: 'Je suis dev, mettez-moi la totale.',
      developerHint: "L'appli s'ouvre sur votre dernier projet, les conversations montrent le terminal et la trace des processus, le panneau s'ouvre sur les modifications.",
      later: "Rien n'est retiré, dans un cas comme dans l'autre. Réglages, Apparence affiche ou masque chaque bouton, un par un."
    },

    welcome: {
      title: 'Boite fait tourner vos agents',
      body: 'Une conversation par tâche. Les agents continuent pendant que vous faites autre chose.'
    },

    agents: {
      title: 'Une conversation qui suit votre travail',
      body: "Changez d'agent, dictez un message, relisez le résultat. Sans changer de conversation.",
    },

    voice: {
      title: 'Parler au lieu de taper',
      body: "Appuyez sur le micro et parlez. Vous relisez le texte avant qu'il parte.",
      open: 'Réglages de la voix',
      reading: 'Lecture du moteur vocal'
    },

    panel: {
      title: 'Le panneau à côté de la conversation',
      body: 'Modifications, fichiers, tâches et navigateur, à une touche.',
      open: 'Raccourcis clavier',
    },

    usage: {
      title: "Voir ce qu'il vous reste",
      body: "Voyez quel abonnement se remplit et quand il se réinitialise, même avec Boite en arrière-plan.",
      monitor: 'Lire les limites de {account}',
      connect: 'Connecter un fournisseur',
      deviceHint: 'Les limites sont lues sur la machine qui héberge le cœur.'
    },

    reach: {
      onPhoneTitle: "Votre ordinateur fait le travail",
      onPhoneBody: "Ce téléphone affiche les conversations de votre ordinateur. Les agents tournent là-bas et continuent quand vous rangez le téléphone.",
      onPhoneSettings: "Les notifications et l'application sur l'écran d'accueil sont dans les Réglages.",
      title: 'Éloignez-vous. Gardez le fil.',
      phone: 'Sur votre téléphone',
      phoneBody: 'Scannez un QR code et votre téléphone retrouve les conversations de toutes vos machines, avec les notifications.',
      pair: 'Ajouter un appareil',
      machines: 'Un autre Boite',
      machinesBody: 'Pilotez depuis cette application un Boite qui tourne sur un serveur ou un autre ordinateur.',
      connect: 'Connecter une machine',
      deviceHint: "L'appairage et les machines se gèrent depuis l'application où tourne le cœur."
    },

    quiet: {
      title: 'Des agents qui ne vous coupent pas',
      deviceHint: 'Le focus et le son sont des réglages de la machine qui héberge le cœur.'
    },

    project: {
      title: 'Ouvrir votre premier projet',
      body: 'Le dossier dans lequel un agent travaille.',
    }
  }
};
