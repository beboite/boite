# Audit du port T3 Code dans Boite

Révision de référence : [T3 Code c75299ee](https://github.com/pingdotgg/t3code/tree/c75299ee2085a121bceb6df76796e971fe92b5b6), examinée le 4 septembre 2026.
Travail dans `C:/Users/Skoll/boite-pilot-sdk`, branche `work/pilot-sdk`, base Boite `9b77b85`.
Le checkout `C:/Users/Skoll/boite` n'a pas reçu le port. Aucun commit ni push.

## Verdict

Boite possède maintenant des adaptateurs pour les six fournisseurs de cette
révision de T3. Cela ne signifie pas que leurs fonctions sont toutes portées.
Les échanges de base sont testés avec des fournisseurs simulés. La reprise
après coupure, les pièces jointes et plusieurs contrôles de session restent
incomplets. Garder le mode Chat derrière son option expérimentale.

T3 pilote les outils locaux par plusieurs protocoles, pas par un SDK universel.
Boite conserve son backend Rust et son interface Svelte. Les adaptateurs
traduisent les protocoles en `PilotEvent`; ils n'importent pas les packages
TypeScript de T3. Toute évolution de ces protocoles devra donc être suivie ici.

## Ce qui est porté

Le premier lot avait ajouté Codex, OpenCode et les variantes ACP, ainsi que les
formulaires structurés. Cette reprise ajoute les brouillons, le catalogue Codex,
la réorientation Codex et les corrections OpenCode décrites plus bas.

| Fonction T3 | Emplacement Boite | État et limite |
| --- | --- | --- |
| Claude en flux JSON, demandes de permission | `crates/boite-pilot/src/claude.rs` | Présent; validations sur fournisseur simulé |
| Codex App Server sur stdio | `crates/boite-pilot/src/codex/` | Initialisation, reprise, texte, outils, questions, permissions, usage, interruption, compactage |
| Catalogue Codex paginé | `codex/inventory.rs`, `ModelPicker.svelte` | Catalogue de la session, modèles masqués exclus, doublons exclus, délai total 5 s, limite 20 pages, repli hors ligne |
| Réorientation Codex | `codex/steer.rs` | `turn/steer` avec `expectedTurnId`; conserve le tour actif, refuse de changer ses réglages |
| Cursor, Grok et Antigravity sur ACP | `crates/boite-pilot/src/acp/` | Sessions, texte, outils, permissions, choix de modèle et mode selon le fournisseur |
| OpenCode HTTP/SSE | `crates/boite-pilot/src/opencode/` | Serveur local ou configuré, reprise, modèles connectés, texte, outils, usage, permissions, questions, compactage |
| Questions à plusieurs champs | `RequestCard.svelte`, `event.rs`, `driver.rs` | Identifiants et ordre conservés; choix multiples et champs secrets dans le contrat |
| Permissions pour la session | `claude.rs`, `codex/`, `opencode/`, `acp/` | Traduites dans le vocabulaire du fournisseur |
| Brouillons par conversation | `src/lib/features/pilot/drafts.ts`, `Composer.svelte` | Stockage local au navigateur/appareil; survit au remontage et au rechargement; aucune synchronisation distante |
| Même protocole pour desktop et serveur | `boite-core/src/command/pilot.rs`, `pilot_host.rs` | Bus `pilot.*` commun; codecs Tauri et WebSocket adaptés |
| Historique et approbations persistants | `boite-core/src/pilot.rs`, `store.svelte.ts` | Architecture déjà présente dans Boite, conservée |

## Défauts corrigés pendant cette reprise

- Le lecteur SSE décodait chaque paquet HTTP séparément. Un accent ou un emoji
  coupé entre deux paquets devenait un caractère de remplacement. Le décodeur
  attend maintenant une ligne complète et accepte LF, CRLF et CR.
- Le flux n'avait pas de limite de taille. Une ligne ou un événement SSE est
  maintenant limité à 4 MiB; une réponse JSON HTTP à 8 MiB.
- Le délai HTTP ne couvrait que l'arrivée des en-têtes. Il couvre maintenant
  aussi la lecture du corps. Le compactage dispose de 10 minutes.
- Les erreurs HTTP pouvaient recopier le corps fourni par le serveur dans les
  journaux. Elles exposent maintenant le code HTTP sans ce corps.
- Un choix de permission OpenCode inconnu devenait une autorisation ponctuelle.
  Il est maintenant refusé. Un événement natif `reply: reject` reste un refus.
- La récupération et le flux pouvaient ouvrir deux fois la même question.
  Une demande déjà ouverte n'est plus émise une seconde fois.
- Un événement idle reçu pendant une interruption pouvait annoncer un succès.
  Il est différé jusqu'au résultat de l'interruption. Si celle-ci échoue, la
  fin native différée peut encore terminer le tour.
- Le compactage OpenCode n'occupait pas le tour. Il exclut maintenant un prompt
  concurrent et ne termine plus prématurément sur un événement idle natif.
- Les tâches de lecture OpenCode retenaient le processus après destruction du
  runtime. Elles utilisent une référence faible; la session annule son lecteur
  et un flux perdu arrête le serveur qu'elle possède. Un serveur externe n'est
  pas arrêté par cette fermeture locale.
- Une récupération de permissions ratée après connexion pouvait laisser des
  tâches actives. Cette sortie d'initialisation annule désormais le lecteur et
  arrête le processus détenu par la session.
- Le lancement Windows construisait sa propre ligne `cmd.exe /c`. Rust gère
  maintenant l'échappement des scripts batch. Les processus SDK utilisent
  `CREATE_NO_WINDOW`.
- Un second prompt Codex remplaçait le tour en mémoire. Il passe maintenant par
  `turn/steer`. Un compactage ne peut pas remplacer un tour actif.
- Un échec d'envoi effaçait ce qui avait été tapé depuis. Le compositeur restaure
  le message refusé en conservant le nouveau brouillon et la conversation cible.

## Écarts à traiter avant de généraliser le mode Chat

| Priorité | Travail restant | Critère de fin |
| --- | --- | --- |
| P0 | Reconnexion OpenCode et réconciliation des messages, demandes et statuts | Couper le SSE après admission d'un prompt, reconnecter, retrouver le texte exact sans renvoyer le prompt |
| P0 | Admission incertaine d'un prompt après timeout HTTP | Ne pas afficher le tour comme terminé si le fournisseur continue à travailler |
| P0 | Réorientation et concurrence propres à chaque fournisseur | Tester deux envois rapprochés, pendant démarrage, travail et demande de permission; aucune perte d'identifiant de tour |
| P0 | Validation complète des réponses structurées | Refuser les champs manquants/inconnus, respecter les choix imposés et les types booléen/nombre des schémas ACP |
| P0 | Nettoyage des autres adaptateurs et interruption des descendants OpenCode | Fermer un runtime sans `stop`, interrompre un enfant en attente; aucun processus ni demande orphelins |
| P0 | Vérification UI desktop et téléphone | Regarder les cartes, modèles, longs textes et brouillons, puis valider envoi, refus et reconnexion |
| P1 | Pièces jointes sur le contrat `TurnInput` et les deux transports | Images, texte et PDF selon capacités, tailles bornées, annulation et erreurs visibles |
| P1 | Catalogue enrichi | Exposer agents et variantes OpenCode, efforts Codex, capacités réellement disponibles pour la session |
| P1 | Reprise de conversation avec historique natif | Réconcilier un historique repris hors de Boite sans dupliquer les messages |
| P1 | Retour de conversation et checkpoints | Porter le rollback natif, distinguer historique du chat et restauration Git, demander confirmation avant modification des fichiers |
| P1 | Antigravity géré | Installer et sélectionner ses profils sans supposer un serveur ACP déjà installé |
| P2 | Parité des services T3 au-delà du runtime | Auditer séparément multi-comptes, diagnostics, quotas, skills, téléchargements et mises à jour |

OpenCode et les variantes ACP refusent encore un prompt lorsque leur tour est
actif. L'indication générique de réorientation dans le compositeur doit devenir
une capacité par adaptateur. Le bus écrit aussi le message utilisateur avant
le résultat d'admission : un refus peut laisser un message sans tour exécuté.
Ce sont des écarts connus, pas des fonctions annoncées comme portées.

Les brouillons restent en clair sur l'appareil. Au-delà de 256 Ki caractères,
ils restent uniquement en mémoire. Un stockage refusé ou plein utilise aussi
la mémoire; ce repli ne survit pas à la fermeture de l'application.

## Sources examinées

- [OpenCodeAdapter.ts](https://github.com/pingdotgg/t3code/blob/c75299ee2085a121bceb6df76796e971fe92b5b6/apps/server/src/provider/Layers/OpenCodeAdapter.ts) : événements, demandes en attente, interruption, reprise, pièces jointes et réorientation.
- [CodexProvider.ts](https://github.com/pingdotgg/t3code/blob/c75299ee2085a121bceb6df76796e971fe92b5b6/apps/server/src/provider/Layers/CodexProvider.ts) : `requestAllCodexModels`, découverte paginée.
- [composerDraftStore.ts](https://github.com/pingdotgg/t3code/blob/c75299ee2085a121bceb6df76796e971fe92b5b6/apps/web/src/composerDraftStore.ts) : brouillons persistants et séparation des conversations.
- [Contrat officiel Codex App Server](https://learn.chatgpt.com/docs/app-server) : `model/list` et `turn/steer`.
- [Règles Rust pour les scripts batch](https://doc.rust-lang.org/std/process/index.html#windows-argument-splitting) : échappement Windows.

Les attributions du port sont conservées dans `THIRD-PARTY-NOTICES.md`.

## Vérification du lot

Commandes exécutées dans le worktree, sans fournisseur facturé :

| Commande | Résultat |
| --- | --- |
| `cargo test -p boite-pilot` | 82 réussis, 1 ignoré : smoke qui demande un OpenCode installé |
| `cargo test -p boite-core` | 668 réussis |
| `cargo clippy -p boite-pilot --all-targets -- -D warnings` | Passe |
| `bun run check` | 0 erreur, 0 avertissement Svelte; lint, traductions et opacité validés |
| `bun run test` | 129 fichiers, 1 393 tests réussis |
| `bun run build` | Passe, frontend écrit dans `build/` |
| `bun run budget` | `BUNDLE BUDGET PASS` |
| `cargo build -p boite -p boite-server` | Passe en debug après compilation du sidecar `boite-mcp` |
| `git diff --check` | Passe |
| `bun run typecheck:fast` | Échoue sur deux imports existants de `ContextMenuItem`, dans `treeMenu.svelte.ts` et `launchMenu.ts`; fichiers non modifiés |

Les exécutables debug sont `target/debug/boite.exe` et
`target/debug/boite-server.exe`. Aucun installateur n'a été produit, aucune
installation existante n'a été remplacée et aucune fenêtre de l'application
n'a été ouverte.

Non vérifié : rendu visuel desktop/téléphone, dialogue réel avec les six
fournisseurs, coûts et quotas, reconnexion après coupure. Les faux fournisseurs
vérifient les trames et transitions, pas le comportement des comptes installés.

Pour essayer le port, utiliser une instance isolée de ce worktree, activer
« Threads chat » dans les expérimentations, puis choisir Chat au lancement.
Ne pas diriger une instance de test vers les données de l'installation active.
