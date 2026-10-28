import type { Translation } from '../../i18n.svelte';

export const fr: Translation = {

  policy: {
    managed: 'Géré par votre organisation',
    lockedHint: 'Géré par votre organisation. La clé {key} de {file} fixe ce réglage, seul un administrateur peut la changer.',
    heading: 'Géré par votre organisation',
    info: 'Un administrateur a posé une politique sur cette machine. Chaque réglage listé ici est verrouillé sur la valeur affichée. Tout le reste reste à vous.',
    file: 'Fichier de politique',
    none: 'Le fichier ne verrouille rien.',
    failedClosed: 'Le fichier est illisible : chaque réglage qu’il peut verrouiller prend sa valeur la plus stricte jusqu’à sa correction.',
    problemsTitle: 'La politique de votre organisation a des problèmes',
    problemsInfo: 'Boite applique chaque clé valide et garde la valeur la plus stricte pour les autres. Envoyez ces lignes à votre administrateur.',
    problem: '{field} : attendu {expected}',
    providerOff: 'Désactivé par votre organisation',
    quotasOff: 'Votre organisation a désactivé la lecture des quotas sur cette machine : aucune limite n\'est lue pour vos comptes.',
    browserOff: 'Votre organisation a désactivé le navigateur des agents sur {machine}.',
    keys: {
      analytics: 'Statistiques d’usage',
      'updates.app': 'Mises à jour de l’app',
      'updates.server': 'Mises à jour du serveur',
      'updates.agents': 'Mises à jour des agents',
      'providers.allow': 'Fournisseurs autorisés',
      'providers.deny': 'Fournisseurs bloqués',
      gateway: 'Passerelle d’abonnement',
      'gateway.allowedBaseUrls': 'Adresses de passerelle autorisées',
      quotaReads: 'Lecture des quotas',
      'plugins.install': 'Installation de plugins',
      'plugins.recommended': 'Vérification des plugins recommandés',
      issueReports: 'Signalements de bug',
      dictation: 'Dictée',
      'previews.remoteResources': 'Ressources distantes dans les aperçus',
      agentBrowser: 'Navigateur des agents',
      'agentBrowser.searchUrl': 'Recherche de la barre d’adresse',
      'network.lan': 'Accès au réseau local',
      'network.tailscaleServe': 'HTTPS Tailscale',
      'network.groups': 'Groupes',
      'network.contacts': 'Contacts',
      'network.push': 'Notifications push',
      pullRequests: 'Pull requests'
    },
    values: {
      on: 'Autorisé',
      off: 'Désactivé',
      basic: 'Basiques au plus',
      check: 'Vérification seule',
      auto: 'Automatique',
      local: 'Moteurs locaux seulement',
      none: 'Aucun'
    }
  }
};
