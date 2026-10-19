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
    addLabel: 'Nom du nouveau profil',
    addPlaceholder: 'Pro, Perso…',
    add: 'Ajouter un profil',
    invalidName: "Choisissez un nom de 1 à 40 caractères qu'aucun autre profil n'utilise, autre que Default ou Private.",
    tooMany: '{count} profils de navigateur au plus.',
    deleteTitle: 'Supprimer le profil {name} ?',
    deleteBody: 'Ses onglets ouverts se ferment, et ses cookies, son stockage et ses connexions sont effacés de cet ordinateur. Impossible de revenir en arrière.',
    deleteFailed: "Le profil a été retiré, mais ses données n'ont pas pu être effacées : {reason}",
    copySignIns: 'Copier les connexions vers les agents',
    copySignInsHint: 'Envoyer les cookies de {name} au navigateur de l’agent d’une machine, dans le même profil',
    copied: '{count} cookies de {name} copiés vers {machine}.',
    copiedNone: '{name} n’a aucun cookie à copier.',
    copyFailed: 'Les connexions n’ont pas pu être copiées : {reason}'
  }
};
