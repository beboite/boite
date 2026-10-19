import type { Translation } from '../../i18n.svelte';

export const fr: Translation = {

  install: {
    action: 'Installer',
    update: 'Mettre à jour',
    repair: 'Réinstaller',
    remove: 'Désinstaller',
    removeTitle: 'Désinstaller {provider} ?',
    removeBody: 'Les fichiers téléchargés par Boite partent avec. Vos comptes restent, et il pourra être réinstallé plus tard.',
    removeConfirm: 'Désinstaller',
    removeCancel: 'Garder',
    absent: 'Pas installé, {size}',
    downloading: 'Téléchargement, {percent}',
    verifying: "Vérification de l'archive",
    extracting: 'Décompression',
    installed: 'Installé par Boite',
    updateAvailable: 'Version {installed}, {available} disponible',
    progress: 'Progression du téléchargement'
  }
};
