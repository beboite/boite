import type { Translation } from '../../i18n.svelte';

export const fr: Translation = {
  btw: {
    fork: 'Fork', forking: 'Création du fork',
    title: 'Question de côté', description: "Poser une question de côté sans interrompre l'agent",
    loading: 'Réponse à votre question en cours', close: 'Fermer la réponse de côté',
    needsThread: 'Ouvrez une conversation avant de poser une question de côté.',
    questionRequired: 'Écrivez une question après /btw.',
    textOnly: 'Les questions de côté acceptent seulement du texte. Retirez les pièces jointes et les références de prévisualisation.',
    editing: 'Terminez ou annulez la modification du message avant de poser une question de côté.',
    offline: 'Reconnectez cette machine avant de poser une question de côté.'
  }
};
