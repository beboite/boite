import type { Translation } from '../../i18n.svelte';

export const fr: Translation = {
  "telemetry": {
    "heading": "Confidentialité et statistiques",
    "description": "Les compteurs de base sont activés par défaut. Les statistiques améliorées restent facultatives. Aucun message, nom de projet, chemin, compte ou enregistrement n'est collecté.",
    "choiceNotice": "Base, Plus ou Refus : votre choix est compté anonymement, sans identifiant d'installation, même si les statistiques d'usage sont désactivées.",
    "basic": "Compteurs anonymes",
    "basicHint": "Compter les installations actives, lancements, conversations et résultats des tours. Les identifiants d'usage changent chaque jour ; un identifiant distinct compte uniquement les installations.",
    "enhanced": "Statistiques améliorées",
    "enhancedHint": "Partager les modèles publics choisis, le niveau de raisonnement, les modes de vitesse et de permission, les durées et les volumes de jetons avec un identifiant aléatoire stable. Les modèles privés sont regroupés sous « autre ». Désactiver demande la suppression du profil et de ses événements.",
    "unconfigured": "Cette version n'a pas de relais statistique configuré. Rien n'est envoyé.",
    "pending": "Suppression en attente. Boite réessaie en arrière-plan. PostHog supprime les événements après acceptation de la demande.",
    "export": "Exporter mes statistiques",
    "retry": "Réessayer la suppression"
  }
};
