import type { Translation } from '../../i18n.svelte';

export const fr: Translation = {
  phone: {
    preparing: "L'application prépare encore ses fichiers hors ligne. Rechargez la page et réessayez.",
    settingsOffline: "Les réglages ne sont pas encore téléchargés. Reconnectez-vous et rouvrez les réglages.",
    dialogOffline: "Cette fenêtre n'est pas encore téléchargée. Reconnectez-vous et rouvrez-la.",
    heading: 'Application mobile', ownAddress: 'Utiliser une autre adresse HTTPS', publicUrl: 'Adresse HTTPS publique', urlPlaceholder: 'https://boite.example.com',
    publicUrlHint: 'L\'origine HTTPS de votre reverse proxy, qui doit transmettre la page et /rpc à ce cœur. Les liens pour ajouter un appareil passent par elle.',
    install: 'Installer Boite', installed: "Boite tourne comme application installée.",
    installHint: "Sur iPhone, ouvrez Partager dans Safari, puis Sur l'écran d'accueil. Sur Android, utilisez Installer l'application dans le menu du navigateur.",
    httpsRequired: "Cette connexion est en HTTP. Ouvrez Boite en HTTPS pour activer les fichiers hors ligne et les notifications.",
    ownOrigin: "Les notifications s'activent depuis l'application installée depuis l'adresse de cette machine.",
    pairFirst: "Ajoutez cette application à votre groupe avant d'activer les notifications.",
    unsupported: "Ce navigateur ne gère pas les notifications push ici. Sur iPhone, ajoutez Boite à l'écran d'accueil et ouvrez-le depuis son icône.",
    pushHint: 'Quand un agent termine, échoue ou attend votre réponse, même quand Boite est fermé.',
    enable: 'Activer les notifications', disable: 'Désactiver les notifications', test: 'Envoyer une notification de test',
    enabled: 'Notifications activées pour cet appareil.', testSent: 'Le service push a accepté la notification de test.',
    denied: "Les notifications ont été refusées. Vous pouvez changer ça dans les réglages du navigateur ou de l'appareil.",
    subscriptionFailed: "Le navigateur n'a pas renvoyé un abonnement push complet.",
    multiMachine: "Les notifications viennent de la machine depuis laquelle cette application a été installée, et à travers elle de toutes les autres machines de son groupe.",
    relayed: "Cette machine atteint cet appareil à travers celle depuis laquelle l'application a été installée : activez-y les notifications, celles de cette machine arrivent avec.",
    tailscale: {
      heading: 'HTTPS via Tailscale',
      hint: "Tailscale donne à cette machine une adresse HTTPS sur votre tailnet. Boite s'y sert lui-même avec tailscale serve, et les liens pour ajouter un appareil l'utilisent. Un téléphone doit avoir Tailscale connecté pour l'atteindre.",
      checking: 'Vérification de Tailscale…',
      missing: "Tailscale n'est pas installé sur cette machine.",
      download: 'Obtenir Tailscale',
      stopped: "Tailscale est installé mais pas connecté. Ouvrez Tailscale et connectez-le, puis vérifiez à nouveau.",
      needsLogin: 'Tailscale est déconnecté de votre compte sur cette machine. Connectez-vous, puis vérifiez à nouveau.',
      signIn: 'Se connecter à Tailscale',
      httpsDisabled: "Les certificats HTTPS sont désactivés sur votre tailnet. Dans la console d'administration Tailscale, page DNS, activez MagicDNS et HTTPS Certificates, puis vérifiez à nouveau.",
      openAdmin: "Ouvrir la console d'administration",
      off: 'Prêt : ce cœur peut être servi sur {url}.',
      on: 'Ce cœur est servi sur {url}.',
      onPublic: "Les liens pour ajouter un appareil utilisent cette adresse.",
      conflict: "{url} sert déjà {target}. Boite n'y touche pas, sauf si vous le remplacez.",
      error: "La commande tailscale n'a pas répondu comme prévu.",
      enable: "Activer l'accès HTTPS via Tailscale",
      disable: 'Désactiver',
      replace: 'Remplacer…',
      refresh: 'Vérifier à nouveau',
      pair: 'Ajouter un appareil',
      approve: 'Autoriser Serve',
      replaceTitle: 'Remplacer ce que sert {url} ?',
      replaceBody: "Tailscale sert actuellement {target} à cette adresse. La remplacer la fait pointer vers Boite, et ce qui l'utilisait n'y est plus joignable.",
      replaceConfirm: 'Remplacer',
      disableTitle: 'Ne plus servir Boite via Tailscale ?',
      disableBody: "Les téléphones associés via {url} ne peuvent plus joindre ce cœur tant qu'il n'est pas servi à nouveau. Leurs clés restent valides.",
      details: {
        'permission-denied': 'Tailscale a refusé la modification. Sous Linux, lancez une fois sudo tailscale set --operator=$USER, puis réessayez.',
        'serve-consent': "Votre tailnet n'autorise pas encore Serve. Ouvrez le lien, approuvez, puis réessayez.",
        'not-logged-in': 'Tailscale est déconnecté. Connectez-vous, puis réessayez.',
        timeout: "Tailscale n'a pas répondu à temps. Réessayez.",
        unknown: 'Tailscale a refusé la modification. Lancez tailscale serve status sur cette machine pour savoir pourquoi.'
      }
    }
  }
};
