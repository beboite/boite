import type { Translation } from '../../i18n.svelte';

export const fr: Translation = {
  group: {
    rename: 'Renommer le groupe', merging: 'Regroupement des machines connectées',
    otherGroup: '{machine} appartient à {group}. Quittez ce groupe sur la machine pour la déplacer ici.',
    heading: 'Groupe',
    intro: "Vos machines et vos téléphones, dans un seul groupe. Chaque machine joint les autres toute seule, et un téléphone ajouté sur l'une d'elles les atteint toutes. Chaque machine d'un groupe a le contrôle total des autres : ne groupez que ce qui est à vous.",
    name: 'Nom du groupe', namePlaceholder: 'Maison',
    join: 'Rejoindre', joining: 'Connexion', joinLabel: "Lien d'une autre machine",
    joinHint: "Sur une machine du groupe, ouvrez Réglages, Machines, Ajouter un appareil, copiez le lien et collez-le ici. Cette machine rejoint ce groupe avec ses téléphones.",
    members: 'Machines et appareils du groupe', self: 'Cette machine', connected: 'Connectée', connecting: 'Connexion',
    relayed: 'Connectée via {machine}', through: 'Via {machine}',
    unreachable: "Injoignable d'ici. Elle est peut-être éteinte, en veille ou sur un autre réseau.",
    insecure: "Cette machine ne donne aucune adresse utilisable par cet appareil, et aucune machine du groupe ne peut l'y mener. Donnez-lui une adresse HTTPS publique.",
    loopback: "Cette machine n'écoute que sur elle-même : les autres ne peuvent pas la joindre. Connectez-la à Tailscale, ou activez l'écoute sur le réseau.",
    copied: 'Copié',
    addDevice: 'Ajouter un appareil', adding: 'Préparation',
    addOlder: "Boite sur {machine} est trop ancien pour ajouter un appareil. Mettez-le à jour dans Mises à jour sur cette page, puis revenez.",
    scanTitle: 'Scannez avec votre téléphone',
    addHint: "Ouvrez Boite sur le téléphone et touchez Scanner le code. Sur un ordinateur, copiez le lien et collez-le sous Rejoindre.",
    qr: "Le lien qui ajoute un appareil, en QR code",
    copyLink: 'Copier le lien', link: 'Lien pour un ordinateur',
    expires: "Sert une fois, jusqu'à {time}",
    device: 'Appareil', phone: 'Téléphone', browser: 'Navigateur', devicesList: 'Appareils du groupe',
    deviceAdded: 'Ajouté sur {machine}',
    deviceLegacy: 'Passe à la clé du groupe à sa prochaine connexion',
    thisDevice: 'Cet appareil',
    revokeDevice: 'Retirer du groupe', revokeDeviceTitle: 'Retirer {device} du groupe ?',
    revokeDeviceBody: "Toutes les machines du groupe le refusent dès maintenant, y compris celles qui sont éteintes, dès leur retour. Pour le rajouter, il faudra un nouveau code.",
    remove: 'Retirer du groupe', removeTitle: 'Retirer {machine} du groupe ?',
    removeBody: "Les autres machines cessent de lui faire confiance dès qu'elles l'apprennent. Une machine éteinte l'apprend à son retour. Les téléphones ajoutés sur elle restent dans le groupe.",
    leave: 'Quitter le groupe', leaveTitle: 'Quitter {group} ?',
    leaveBody: "Cette machine oublie le groupe. Les téléphones ajoutés sur cette machine quittent le groupe avec elle.",
    lanHint: 'Un téléphone atteint ce lien une fois le réseau local activé et Boite redémarré.',
    reach: {
      loopback: "Ce lien ne fonctionne que sur cet ordinateur : Boite n'écoute pas encore le réseau local.",
      button: 'Rendre accessible sur le réseau local',
      restarting: "Boite redémarre pour écouter le réseau local. Les agents en cours terminent leur étape et continuent.",
      failed: "Boite n'est pas revenu sur le réseau local. Quittez-le depuis la zone de notification, rouvrez-le, puis ajoutez le téléphone."
    },
    firewall: {
      blocked: 'Le pare-feu Windows bloque Boite sur ce réseau {networks} : un téléphone ne peut pas joindre cet ordinateur.',
      unset: "Le pare-feu Windows n'a pas encore autorisé Boite sur ce réseau {networks} : un téléphone ne peut pas joindre cet ordinateur.",
      allow: 'Autoriser dans le pare-feu Windows',
      allowing: 'En attente de Windows',
      allowed: 'Le pare-feu Windows laisse désormais les téléphones joindre Boite sur tous les réseaux.',
      cancelled: "Rien n'a changé : Windows a besoin qu'un administrateur accepte sa demande.",
      failed: 'Windows a refusé la modification. Autorisez boite-core.exe dans les paramètres du pare-feu Windows.',
      unreadable: "Le pare-feu Windows n'a pas pu être lu. Si un téléphone ne se connecte pas, autorisez-y boite-core.exe.",
      networks: { public: 'public', private: 'privé', domain: "d'entreprise" },
      and: ' et '
    }
  }
};
