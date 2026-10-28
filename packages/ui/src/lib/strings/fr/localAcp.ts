import type { Translation } from '../../i18n.svelte';

export const fr: Translation = {
  localAcp: {
    heading: 'Commande ACP locale',
    hint: "N'importe quel agent qui parle ACP, lancé par sa propre commande. Il garde sa connexion et ses réglages, et liste lui-même ses modèles. Chaque argument est passé tel quel, sans shell.",
    open: 'Ajouter',
    name: 'Nom',
    namePlaceholder: 'Mon agent',
    commandPlaceholder: 'mon-agent',
    command: 'Commande',
    commandHint: 'Un programme du PATH, ou son chemin complet. Sous Windows, le programme lui-même plutôt qu\'un lanceur .cmd.',
    args: 'Arguments',
    arg: 'Argument {n}',
    addArg: 'Ajouter un argument',
    env: 'Environnement',
    envHint: "Enregistré en clair dans le fichier du fournisseur. Gardez les clés d'API dans la connexion de l'agent.",
    envName: 'Variable',
    envValue: 'Valeur',
    addEnv: 'Ajouter une variable',
    removeRow: 'Retirer',
    save: 'Ajouter le fournisseur',
    added: '{provider} ajouté',
    unavailable: "Cette machine n'est pas connectée en tant que propriétaire. Reconnectez-la, puis ajoutez de nouveau le fournisseur.",
    source: 'Ajouté ici',
    remove: 'Retirer le fournisseur',
    removeTitle: 'Retirer {provider} ?',
    removeBody: 'Boite supprime son fichier de fournisseur. Ses comptes et conversations restent, et reviennent si vous le rajoutez sous le même nom.'
  }
};
