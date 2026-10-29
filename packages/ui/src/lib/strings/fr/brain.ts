import type { Translation } from '../../i18n.svelte';

export const fr: Translation = {

  brain: {
    heading: 'Cerveau', description: 'Les mêmes instructions et skills pour tous vos agents.',
    folder: 'Dossier du cerveau', pathHint: 'Chemin du dossier', save: 'Connecter le dossier', browse: 'Parcourir', useFolder: 'Choisir ce dossier',
    enabled: 'Partager les instructions automatiquement', enabledHint: 'Ajoute les instructions et le catalogue de skills à chaque tour. Les commandes /skill restent disponibles tant que le dossier est connecté.',
    disconnect: 'Déconnecter', sync: 'Synchroniser', working: 'En cours',
    empty: 'Connectez votre cerveau', emptyHint: 'Choisissez le dossier de vos instructions et skills.',
    change: 'Changer de dossier',
    autoPull: 'Pull automatique', onStartup: 'Au démarrage', periodic: 'À intervalle régulier', minutes: 'min',
    globalInstructions: 'AGENTS.md global', globalDetails: 'Harness reliés',
    globalHint: 'Ce cerveau s\'applique à tous les projets, même hors de Boite. Les fichiers existants sont sauvegardés puis restaurés à la désactivation.',
    boiteGuide: 'Guide Boite', boiteGuideHint: 'Une note après AGENTS.md au début d\'une session d\'agent : la commande boite et le panneau. Environ 300 tokens.',
    linked: 'Relié', existing: 'Déjà relié', blocked: 'À vérifier',
    linkFailure: 'Certains fichiers d\'instructions globales n\'ont pas pu être reliés ou restaurés. Vérifiez les erreurs ci-dessous, puis réessayez.',
    linkErrorDetails: 'Détails techniques',
    windowsPermission: 'Windows a bloqué les liens vers les instructions. Le mode développeur permet à Boite de les créer sans être lancé en administrateur.',
    windowsOpen: 'Sur l\'ordinateur qui héberge le cerveau, appuyez sur Win+R et ouvrez',
    windowsEnable: 'Activez le mode développeur et acceptez la confirmation de Windows.',
    windowsRetry: 'Revenez ici et cliquez sur Réessayer.',
    windowsAdmin: 'Si Windows demande une autorisation administrateur ou si le réglage est géré par votre organisation, contactez l\'administrateur de cet ordinateur.',
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
