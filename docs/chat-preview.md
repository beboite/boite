# Messagerie Boite, version de test

Lancer `target/chat-preview/debug/boite.exe` depuis ce worktree. Ne pas utiliser
`target/debug/boite.exe` : le build Cargo de développement attend le serveur Vite.

Cette version embarque l'interface et utilise l'identifiant
`dev.boite.chat-preview`. Elle conserve ses réglages et sa base à part.
Elle ne remplace ni l'installation principale ni ses raccourcis.

## Utilisation

1. Choisir un projet et configurer les raccourcis d'agents au premier lancement.
2. Cliquer sur Codex ou Claude pour ouvrir une conversation native.
3. Écrire dans Boite et répondre aux demandes d'autorisation dans les cartes du chat.

Le petit bouton Terminal ouvre explicitement l'interface en ligne de commande.
Les commandes ordinaires, comme un shell ou `bun test`, restent des terminaux.
Un réglage Chat explicitement désactivé est conservé : le réactiver dans
Réglages > Expériences. Il est activé par défaut pour les nouvelles données.

Comme T3 Code, Boite garde les moteurs en arrière-plan. Codex passe par
`codex app-server`, Claude par son protocole structuré. Ils doivent être installés
et connectés à leur compte. Ce port ne les remplace pas par des appels API directs.

## Construire et vérifier

```powershell
bun run build:chat-preview
node scripts/verify-chat-preview.mjs
bun run check
bun run test -- --maxWorkers=1
node scripts/chat-smoke/run.mjs
```

Le constructeur Windows masque les processus enfants et sépare leurs sorties
dans `target/chat-preview`. Le vérificateur contrôle les assets embarqués,
l'identifiant isolé, le sous-système graphique sans console et le sidecar.

Le smoke test ouvre Edge sans fenêtre, rend les composants réels et teste
l'envoi, l'autorisation, la connexion et la reprise avec un backend simulé.
Les captures sont dans `target/chat-smoke`. Il n'appelle aucun modèle.
Ce test ne remplace pas un essai de l'application complète avec un vrai compte.
