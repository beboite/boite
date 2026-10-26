import type { Translation } from '../../i18n.svelte';

export const fr: Translation = {
  secrets: {
    cardLabel: "Secret demandé par l'agent",
    replaces: 'Remplace la clé conservée pour ce projet.',
    fieldLabel: 'Valeur de {name}',
    save: 'Enregistrer',
    neverShown: "Jamais montrée à l'agent",
    decline: 'Refuser',
    keep: 'Conserver pour ce projet',
    keepHint: "Les autres conversations de ce projet pourront l'utiliser sans nouvelle demande. Supprimez-la dans les réglages du projet.",
    keepReplaceHint: "Si cette case est décochée, l'agent reçoit une copie à usage unique et la clé conservée reste inchangée.",
    plainLink: 'Réponds depuis le PC ou en HTTPS',
    saved: '{name} enregistré pour cette conversation',
    savedKept: '{name} enregistré et conservé pour ce projet',
    declined: '{name} refusé',
    cancelled: "{name} n'est plus demandé",
    timedOut: 'La demande de {name} a expiré',
    heading: 'Secrets',
    info: "Les clés qu'un agent t'a demandées et que tu as conservées pour un projet. Les agents les utilisent par leur nom ; Boite ne montre plus jamais leur valeur. Ce n'est pas un bac à sable : un agent peut relire un fichier dans lequel une clé a été écrite, et sa valeur parvient alors à son fournisseur. Le masquage ne fonctionne que dans Boite.",
    empty: 'Aucune clé conservée pour un projet.',
    created: 'Ajouté {time}',
    lastUsed: 'dernière utilisation {time}',
    neverUsed: 'jamais utilisé',
    storage: 'Stocké dans {storage}',
    storageDpapi: 'Windows (DPAPI)',
    storageKeychain: 'Trousseau macOS',
    storageLibsecret: 'Secret Service',
    storageMemory: "En mémoire uniquement : perdu à l'arrêt de Boite",
    delete: 'Supprimer',
    deleteLabel: 'Supprimer {name}',
    deleteTitle: 'Supprimer {name} ?',
    deleteBody: 'Les conversations de {project} devront demander cette clé à nouveau.',
    deletePlain: 'Supprimer depuis le PC ou en HTTPS'
  }
};
