import type { Translation } from '../../i18n.svelte';

export const fr: Translation = {
  providerSettings: {
    heading: 'Fournisseurs',
    intro: 'Un agent déjà connecté sur cet ordinateur est repris tout seul.',
    step: {
      installing: 'Installation',
      install: 'Pas installé',
      repair: 'Des fichiers installés manquent',
      manual: 'Pas installé',
      'signing-in': 'Connexion',
      'sign-in': 'Pas connecté',
      external: 'Pas connecté',
      ready: 'Prêt'
    },
    accountsCount: '{count} comptes',
    thenSignIn: 'La connexion démarre à la fin du téléchargement.',
    manualHint: '{provider} vient avec son propre installateur. Lancez-le, puis revenez : Boite le trouve tout seul.',
    externalHint: '{provider} se connecte depuis sa propre application. Connectez-vous là-bas, puis vérifiez à nouveau.',
    setup: "Instructions d'installation",
    refresh: 'Vérifier à nouveau',
    details: 'Détails',
    isolated: 'Compte Boite',
    default: 'Votre login en ligne de commande',
    reconnect: 'Se reconnecter',
    check: 'Vérifier la connexion',
    connectionOk: 'Connecté',
    checking: 'Vérification',
    accountName: 'Nom du compte',
    revealEmail: 'Afficher le mail',
    deviceHint: 'Saisissez ce code sur la page de connexion. Boite attend la fin de la connexion.',
    addAccount: 'Ajouter un autre compte',
    useCli: 'Utiliser mon login en ligne de commande',
    executable: 'Lancé depuis',
    accounts: 'Comptes',
    installation: 'Installation',
    managedCopy: 'Copie de Boite',
    addHeading: 'Ajouter un fournisseur',
    offHeading: 'Désactivés',
    off: 'Désactivé',
    experimental: 'Expérimental',
    /** The switch's accessible name: `{provider}` is the provider's own name. */
    enable: 'Utiliser {provider}',
    enableHint: "Désactivé, Boite ne lance rien de ce fournisseur et aucune liste ne le propose. Ses comptes et ses conversations sont conservés.",
    /** A thread whose provider is off: the composer's chip and the sentence behind it. */
    threadOff: '{provider} est désactivé. Activez-le dans Réglages > Fournisseurs pour continuer cette conversation.',
    defaultModel: 'Modèle par défaut',
    autoUpdate: 'Mises à jour automatiques',
    checkUpdates: 'Rechercher des mises à jour',
    updating: 'Mise à jour en cours'
  }
};
