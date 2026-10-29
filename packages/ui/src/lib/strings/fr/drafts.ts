import type { Translation } from '../../i18n.svelte';

export const fr: Translation = {

  drafts: {
    name: 'Brouillons',
    hint: 'Un dossier par conversation, dans Documents/Boite',
    openFolder: 'Travailler dans un de mes dossiers',
    pickFolder: 'Ouvrir un dossier',
    incognito: 'Incognito',
    incognitoStart: "Démarrer cette conversation en incognito : rien n'en reste une fois que vous la quittez",
    incognitoStop: 'Démarrer plutôt une conversation normale',
    incognitoOn: 'Incognito : cette conversation et son dossier sont effacés quand vous la quittez',
    launchQueued: 'Cette conversation démarre. Attendez la réponse de la machine avant de modifier ce brouillon.',
    privacyQueued: 'Ce brouillon a déjà été envoyé. Ouvrez un nouveau brouillon pour changer de confidentialité.'
  }
};
