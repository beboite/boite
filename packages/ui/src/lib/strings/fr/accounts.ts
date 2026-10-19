import type { Translation } from '../../i18n.svelte';

export const fr: Translation = {

  accounts: {
    heading: 'Fournisseurs',
    login: 'Se connecter',
    loginStarting: 'Démarrage de la connexion',
    loginOpen: 'Ouvrir la page de connexion',
    loginHint: 'Terminez dans votre navigateur. Cette ligne passera prête toute seule.',
    loginInputPlaceholder: 'Collez le code donné par la page, si elle en donne un',
    loginRedirectPlaceholder: "Sur un autre appareil ? Collez l'adresse localhost sur laquelle la page se termine",
    loginSend: 'Envoyer',
    terminalHint: 'Répondez à ses questions dans le terminal, puis fermez-le une fois connecté.',
    terminalDone: 'Fermer le terminal',
    remove: 'Supprimer',
    removeTitle: 'Supprimer {account} ?',
    removeBody: "Cela déconnecte le compte de Boite et supprime ses fichiers.",
    removeDefaultBody: "Boite cesse d'utiliser ce login. Il reste connecté sur votre ordinateur.",
    removeThread: "1 conversation utilise encore ce compte. Son prochain message la fait passer sur un autre compte connecté du même agent, ce qui recharge tout son contexte.",
    removeThreads: "{count} conversations utilisent encore ce compte. Le prochain message de chacune la fait passer sur un autre compte connecté du même agent, ce qui recharge tout son contexte.",
    removed: 'Compte supprimé',
    removedHint: "Le compte de cette conversation a été supprimé. Choisissez un modèle sur un autre compte pour continuer.",
    status: {
      unknown: 'inconnu',
      ok: 'ok',
      unauthenticated: 'non connecté',
      error: 'erreur'
    }
  }
};
