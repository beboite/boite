import type { Translation } from '../../i18n.svelte';

export const fr: Translation = {

  brain: {
    heading: 'Cerveau', description: 'Les mêmes instructions et skills pour tous vos agents.',
    folder: 'Dossier du cerveau', pathHint: 'Chemin du dossier', save: 'Connecter le dossier', browse: 'Parcourir', useFolder: 'Choisir ce dossier',
    enabled: 'Utiliser avec les agents', disconnect: 'Déconnecter', sync: 'Synchroniser', working: 'En cours',
    empty: 'Connectez votre cerveau', emptyHint: 'Choisissez le dossier de vos instructions et skills.',
    change: 'Changer de dossier',
    autoPull: 'Pull automatique', onStartup: 'Au démarrage', periodic: 'À intervalle régulier', minutes: 'min',
    globalInstructions: 'AGENTS.md global', globalDetails: 'Harness reliés',
    globalHint: 'Ce cerveau s\'applique à tous les projets, même hors de Boite. Les fichiers existants sont sauvegardés puis restaurés à la désactivation.',
    boiteGuide: 'Guide Boite', boiteGuideHint: 'Une note après AGENTS.md au début d\'une session d\'agent : la commande boite et le panneau. Environ 300 tokens.',
    linked: 'Relié', existing: 'Déjà relié', blocked: 'À vérifier',
    interval: 'Intervalle du pull en minutes', intervalHint: 'Un nombre entier entre 1 et 1440 minutes.',
    detected: 'Contenu', instructions: 'Instructions', skill: 'Skills', plugin: 'Plugins',
    pluginHint: 'Détectés ici. Installez les plugins depuis leur agent.',
    details: 'Détails de la synchro', noGit: 'Dossier local. Connectez un dépôt Git pour synchroniser entre PC.',
    noUpstream: 'Configurez une branche distante dans Git pour activer la synchro.', dirty: 'Enregistrez vos changements dans Git avant de synchroniser.',
    counts: '{ahead} à envoyer, {behind} à recevoir', lastSync: 'Dernière synchro', never: 'Pas encore synchronisé',
    upToDate: 'À jour', noEntries: 'Rien de détecté dans cette catégorie.',
    missing: 'Mettez Boite à jour sur cette machine pour connecter un cerveau.',
  }
};
