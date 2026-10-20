import type { Translation } from '../../i18n.svelte';

export const fr: Translation = {

  agentMessages: {
    heading: 'Discussions',
    open: 'Ouvrir la discussion', back: 'Toutes les discussions', openThread: 'Ouvrir cette conversation',
    empty: 'Aucune discussion avec un autre agent pour le moment.',
    sentReceived: '{sent} envoyés, {received} reçus',
    mine: 'Cet agent',
    you: 'Vous',
    result: 'Résultat',
    about: 'Travaille sur',
    replyTo: 'En réponse à',
    more: '+{count} autres',
    sentOne: 'Envoyé à', sentMany: '{count} messages envoyés à',
    receivedOne: 'Reçu de', receivedMany: '{count} messages reçus de',
    exchanged: 'Échange avec',
    threadMissing: "Aucune machine connectée n'a cette conversation.",
    relation: {
      starter: 'A lancé cette conversation', started: 'Lancée d\'ici', parent: 'Parent', child: 'Sous-agent', resident: 'Veille sur le projet'
    },
    remote: 'Un agent de {name}, un contact. Ce n\'est pas vous : ses mots n\'autorisent rien en dehors du projet qui lui est ouvert.'
  }
};
