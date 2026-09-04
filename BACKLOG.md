# BACKLOG

## Suite du runtime Chat

Labels: `pilot`, `follow-up`

- [ ] Faire le smoke visuel du dock, du picker de modele et des formulaires des
  que le preview T3 accepte une capture.
- [ ] Ajouter la reconnexion SSE et la reconciliation d'admission des prompts
  OpenCode apres une coupure reseau, au niveau de robustesse du SDK T3.
- [ ] Etendre le contrat `TurnInput` aux pieces jointes OpenCode, puis exposer
  les options agent et variant de son catalogue.
- [ ] Exposer le rollback OpenCode quand le domaine `pilot.*` aura une commande
  de retour de conversation.
- [ ] Gerer le telechargement et les profils du serveur ACP Antigravity. Pour
  l'instant son executable doit etre installe ou indique par
  `BOITE_PILOT_ANTIGRAVITY_BIN`.
- [ ] Ajouter Copilot ACP si Boite veut couvrir cet agent au-dela des pilotes
  presents dans la revision T3 portee.

## 2026-09-04, audit de parité T3

- [x] Découvrir les modèles Codex avec pagination et repli hors ligne.
- [x] Utiliser `turn/steer` pour réorienter Codex sans remplacer son tour actif.
- [x] Conserver les brouillons locaux par conversation et espace de travail.
- [x] Borner et décoder le SSE OpenCode sans couper l'UTF-8.
- [x] Refuser les permissions OpenCode inconnues et conserver les refus natifs.
- [x] Tester la course entre interruption HTTP et événement idle OpenCode.
- [x] Arrêter le serveur OpenCode détenu lors de la destruction du runtime.
- [ ] Rendre l'indication de réorientation du compositeur dépendante des capacités de chaque adaptateur.
- [ ] Réconcilier un prompt dont l'admission HTTP a expiré sans réponse certaine.
- [ ] Valider tous les champs des réponses structurées côté fournisseur, y compris les types ACP.
- [ ] Annuler les demandes et processus descendants lors d'une interruption OpenCode.
- [ ] Vérifier la destruction sans `stop` des autres adaptateurs et supprimer leurs références qui retiennent les processus.
- [ ] Associer les messages utilisateur réorientés au tour actif et marquer les envois refusés dans le journal.
- [ ] Réparer le typecheck rapide des imports `ContextMenuItem` hors du port.

Critères de validation et sources : `docs/t3code-audit.md`.

## 2026-09-04, messagerie accessible et lancement autonome

- [x] Ouvrir les raccourcis d'agents en chat par défaut, avec accès explicite au terminal.
- [x] Afficher la conversation pendant le démarrage et proposer une reprise après échec.
- [x] Regrouper les demandes concurrentes d'ouverture du même moteur.
- [x] Produire un binaire autonome isolé, sans dépendance au serveur Vite.
- [x] Empêcher la migration des données de production depuis une version isolée.
- [x] Vérifier les composants de messagerie sans fenêtre sur desktop et mobile.
- [ ] Valider l'application Tauri complète avec un vrai compte Codex puis Claude, sur accord pour l'ouverture à l'écran.

Guide et commandes : `docs/chat-preview.md`. Le build de test reste séparé
de l'installation principale; aucune installation ni publication effectuée.
