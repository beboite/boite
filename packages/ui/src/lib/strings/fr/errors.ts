import type { Translation } from '../../i18n.svelte';

export const fr: Translation = {

  errors: {
    draftStorage: "Cet appareil n'a pas pu enregistrer votre brouillon. Gardez cette fenêtre ouverte et copiez votre texte avant de la fermer.",
    draftAttachment: "Une pièce jointe n'a pas pu être lue depuis le stockage. Rechargez pour la récupérer, ou retirez-la avant l'envoi.",
    filesLoading: 'Un fichier est encore en chargement. Répondez une fois prêt.',
    prefix: 'Erreur',
    activityUnsupported: "Ce cœur ne gère pas les objectifs ni les boucles. Mettez Boite à jour sur {machine}, puis reconnectez-vous. Votre commande n'a pas été envoyée.",
    pullRequestUnsupported: "Mettez Boite à jour sur la machine qui héberge cette conversation pour afficher sa pull request. Ce cœur ne sait pas encore les chercher.",
    noEndpoint: "Aucun point de connexion n'a pu être résolu.",
    coreStart: "Le cœur de cet ordinateur n'a pas démarré : {reason}",
    coreRetrying: 'Boite réessaie tout seul.',
    connect: 'Connexion au cœur impossible.',
    clipboard: 'Le presse-papiers a refusé le texte.',
    revoked: "Cet appareil a été retiré du groupe. Rajoutez-le avec un nouveau code depuis l'une de vos machines.",
    unpaired: "Cet appareil n'est pas encore dans le groupe de cette machine. Ajoutez-le avec le code d'Ajouter un appareil.",
    olderCore: "Boite sur {machine} est trop ancien pour cette action. Mettez-le à jour dans Réglages, Machines et mises à jour, puis réessayez.",
    olderCoreHere: "Cette machine a une version de Boite trop ancienne pour cette action. Mettez-la à jour dans Réglages, Machines et mises à jour, puis réessayez.",
    notConnected: "{machine} n'est pas connectée. Boite se reconnecte tout seul dès qu'elle répond.",
    notConnectedHere: "Cette machine n'est pas connectée. Boite se reconnecte tout seul dès qu'elle répond.",
    pairingLink: "Ce n'est pas un lien pour ajouter un appareil. Copiez le lien affiché par Ajouter un appareil sur l'autre machine ; il commence par http et contient ?grant=."
  }
};
