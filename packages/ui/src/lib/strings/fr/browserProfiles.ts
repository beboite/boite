import type { Translation } from '../../i18n.svelte';

export const fr: Translation = {

  browserProfiles: {
    card: 'Navigateur intégré',
    heading: 'Profils du navigateur',
    hint: "Chaque profil garde ses propres cookies, son stockage et ses connexions dans le navigateur intégré, y compris après un redémarrage. Un onglet privé ne garde rien une fois le dernier onglet privé fermé.",
    default: 'Par défaut',
    private: 'Privé',
    profile: 'Profil du navigateur : {name}',
    newTabIn: 'Nouvel onglet dans {name}',
    newPrivateTab: 'Nouvel onglet privé',
    manage: 'Gérer les profils du navigateur',
    isDefault: 'Ouvre les nouveaux onglets',
    makeDefault: 'Y ouvrir les nouveaux onglets',
    renameLabel: 'Nouveau nom pour {name}',
    userAgent: 'User-Agent',
    userAgentLabel: 'User-Agent de l’agent pour {name}',
    userAgentHint: 'Ajoute un marqueur de programme ou remplace le User-Agent du navigateur de l’agent. Vide conserve la valeur du navigateur. S’applique au prochain démarrage du navigateur de ce profil. Les profils personnalisés utilisent un processus Chromium séparé, y compris dans l’application de bureau. Les client hints décrivent toujours le vrai navigateur.',
    userAgentMode: 'Mode du User-Agent',
    userAgentSuffix: 'Ajouter un suffixe',
    userAgentReplace: 'Remplacer toute la valeur',
    userAgentPlaceholder: 'Marqueur du programme ou User-Agent complet',
    userAgentInvalid: 'Utilisez une ligne de texte ASCII imprimable, de 8192 caractères au plus.',
    addLabel: 'Nom du nouveau profil',
    addPlaceholder: 'Pro, Perso…',
    add: 'Ajouter un profil',
    invalidName: "Choisissez un nom de 1 à 40 caractères qu'aucun autre profil n'utilise, autre que Default ou Private.",
    tooMany: '{count} profils de navigateur au plus.',
    deleteTitle: 'Supprimer le profil {name} ?',
    deleteBody: 'Ses onglets ouverts se ferment, et ses cookies, son stockage et ses connexions sont effacés de cet ordinateur. Impossible de revenir en arrière.',
    deleteUnavailable: "Supprimez ce profil dans l'application de bureau sur l'ordinateur qui conserve ses données.",
    deleteFailed: "Le profil n'a pas pu être supprimé : {reason}",
    copySignIns: 'Copier les connexions vers les agents',
    copySignInsHint: 'Envoyer les cookies de {name} au navigateur de l’agent d’une machine, dans le même profil',
    copied: '{count} cookies de {name} copiés vers {machine}.',
    copiedNone: '{name} n’a aucun cookie à copier.',
    copyFailed: 'Les connexions n’ont pas pu être copiées : {reason}'
  }
};
