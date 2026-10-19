import type { Translation } from '../../i18n.svelte';

export const fr: Translation = {

  connect: {
    button: 'Connecter une IA',
    title: 'Connecter une IA',
    intro: "Boite fonctionne avec un abonnement IA que vous avez déjà. Choisissez-le, Boite installe ce qu'il faut et ouvre sa page de connexion.",
    more: 'Autres agents',
    plan: {
      claude: 'Avec un forfait Claude Pro ou Max',
      codex: 'Avec un forfait ChatGPT'
    },
    otherPlan: 'Avec votre compte {provider}',
    install: 'Installer {provider}',
    installNote: "Télécharge {size}. Rien d'autre ne change sur cet ordinateur.",
    signIn: 'Se connecter à {provider}',
    signInNote: 'Votre navigateur ouvre la page de connexion. Revenez ici une fois connecté.',
    manual: "{provider} s'installe avec son propre installateur. Lancez-le, puis vérifiez à nouveau ici.",
    manualOpen: "Ouvrir la page d'installation",
    external: '{provider} se connecte depuis sa propre fenêtre. Connectez-vous là-bas, puis vérifiez à nouveau.',
    checkAgain: 'Vérifier à nouveau',
    ready: '{provider} est connecté.',
    use: 'Utiliser {provider}',
    back: 'Retour',
    device: "Aucune IA n'est encore connectée sur l'ordinateur qui fait tourner Boite. Connectez-en une depuis cet ordinateur.",
    reconnect: 'Se reconnecter',
    signedOut: "{provider} n'est plus connecté"
  }
};
