# DEVLOG

## 2026-09-04 - Pilotes SDK portes depuis T3 Code

Labels: `pilot`, `sdk`, `t3-code`, `rust`, `svelte`

Le runtime Chat suit maintenant les six pilotes du depot T3 Code a la revision
`c75299ee2085a121bceb6df76796e971fe92b5b6`.

- Codex utilise App Server en JSON-RPC: reprise, modeles, modes, approbations,
  questions structurees, usage, interruption et compactage natif.
- Cursor, Grok et Antigravity partagent un pilote ACP avec leurs commandes,
  authentifications, modes, reprises et catalogues de modeles propres.
- OpenCode demarre `opencode serve`, verifie la version, cree ou reprend une
  session, lit les evenements SSE et appelle les routes HTTP pour les prompts,
  permissions, questions, modeles, modes, MCP et compactage.
- Le formulaire de demande accepte plusieurs questions et choix. Le modele
  actif et les modeles annonces par ACP ou OpenCode alimentent le picker.
- Le lanceur Windows resout les executables et les shims `.cmd` sans perdre les
  pipes ni le job object charge de fermer l'arbre enfant.

Verification:

- `cargo test -q -p boite-pilot -p boite-core`: 668 tests core, 35 tests du
  runtime, 7 ACP, 7 Codex, 7 OpenCode et 13 Claude passes. Le smoke OpenCode
  reel reste ignore dans la suite normale.
- `cargo test -q -p boite-pilot --test opencode_wire installed_opencode_server_opens_and_stops_without_a_model_call -- --ignored --exact`:
  1 test passe avec OpenCode 1.18.27, sans prompt modele. Aucun serveur reste.
- `cargo clippy -q -p boite-pilot --all-targets -- -D warnings`: passe.
- `bun run check`: 0 erreur, 0 avertissement, 1491 cles i18n utilisees.
- `bun run test -- --reporter=dot`: 128 fichiers, 1385 tests passes.
- `git diff --check`: passe. Les messages LF vers CRLF viennent de la
  configuration Windows du worktree.

Le controle visuel reste non verifie. Le serveur Vite a demarre, mais la
capture du preview T3 a echoue deux fois. Aucun serveur de test ne reste lance.

Travail isole dans `C:\Users\Skoll\boite-pilot-sdk`, branche
`work/pilot-sdk`. Aucun commit ni push. Le depot de depart
`C:\Users\Skoll\boite` est reste intact.

Cout estime (1 j) : 43 $ ; principal 20 $ ; ouvriers 23 $ (11 ouvriers, med 18 tours, max 89, 0 de plus de 100 tours).

## 2026-09-04, audit T3 et consolidation des adaptateurs

Constat : les six adaptateurs du premier lot ne couvrent pas toute la parité T3.
Le SSE OpenCode coupait l'UTF-8 entre paquets, un choix de permission inconnu
autorisait l'outil, et un second prompt Codex remplaçait le tour actif en mémoire.

Changé : ajout du catalogue Codex paginé, de `turn/steer`, des brouillons locaux
par espace/conversation et de la restauration sans perte après erreur d'envoi.
Le lecteur OpenCode est séparé, borné et testé sur toutes les coupures UTF-8.
Les délais HTTP couvrent le corps, les erreurs ne recopient plus ce corps,
l'interruption diffère les événements idle et le compactage exclut un autre tour.
Les demandes ouvertes sont dédupliquées. La destruction du runtime OpenCode
libère le serveur détenu; les sorties d'initialisation nettoient leurs tâches.
Le lancement Windows utilise l'échappement batch de Rust et aucune fenêtre.
Audit et critères restants dans `docs/t3code-audit.md`; attribution MIT ajoutée.

Vérifié : `cargo test -p boite-pilot` -> 82 réussis, 1 ignoré.
`cargo test -p boite-core` -> 668 réussis.
`cargo clippy -p boite-pilot --all-targets -- -D warnings` -> passe.
`bun run check` -> 0 erreur, 0 avertissement; lint et 1 491 clés i18n validés.
`bun run test` -> 129 fichiers, 1 393 tests réussis.
`bun run build` -> passe. `bun run budget` -> BUNDLE BUDGET PASS.
`cargo build -p boite -p boite-server` -> passe en debug.
Le premier build desktop refusait le sidecar absent. Compilation de
`boite-mcp` en debug puis copie dans l'emplacement attendu, auparavant absent.
`git diff --check` -> passe. Aucun appel à un modèle, commit ou push.

Revérifier : ouvrir une instance isolée, choisir Chat, réorienter Codex,
répondre à une permission, interrompre OpenCode, fermer puis rouvrir un brouillon.

Non vérifié : écran et vrais comptes fournisseurs. La reconnexion avec
réconciliation OpenCode reste au backlog. `bun run typecheck:fast` échoue sur
deux imports `ContextMenuItem` déjà présents dans HEAD et hors du port;
le contrôle Svelte officiel du projet passe.

À toi : valider le comportement dans une instance isolée avant de généraliser
le mode Chat. Le checkout de départ reste inchangé; pas d'installateur ni
d'installation remplacée. Le worktree reste un commit derrière `origin/master`;
aucun pull sur ses modifications non commitées.

Cout estime (1 j) : 6 $ ; principal 2 $ ; ouvriers 3 $ (3 ouvriers, med 16 tours, max 18, 0 de plus de 100 tours).
Cette ligne vient de `python C:/Users/Skoll/.ai/bin/cout.py 1`. Le rapport porte
sur d'autres travaux et n'identifie pas cette session Codex; ce n'est pas le
coût mesuré de ce port. Aucun sous-agent utilisé dans cette reprise.

## 2026-09-04, messagerie principale et exécutable autonome

Constat : les raccourcis ouvraient encore le terminal et le Chat restait un
choix secondaire désactivé par défaut. Le binaire produit par `cargo build`
attendait Vite sur localhost:1420, d'où la connexion refusée au lancement seul.

Changé : les raccourcis d'agents ouvrent le chat depuis l'accueil, le lanceur,
la palette et le mobile. Un bouton distinct conserve le terminal. Les nouvelles
données activent le Chat; un refus explicite déjà enregistré reste respecté.
La conversation s'affiche après l'écriture de sa ligne, avant le démarrage du
moteur. Les ouvertures concurrentes sont regroupées; connexion, échec et reprise
sont visibles dans la conversation. Les moteurs et leurs protocoles restent
ceux du port précédent, sans appel API direct ajouté.

`bun run build:chat-preview` produit un exécutable avec les assets intégrés,
un identifiant séparé et le sous-système Windows graphique sans console.
La migration des anciennes données ne s'exécute plus pour un identifiant de
test. Aucun fichier de l'installation principale n'a été remplacé.

Vérifié :

- `bun run check` : 0 erreur, 0 avertissement; lint, 1493 clés et opacités validés.
- `bun run test -- --maxWorkers=1 --reporter=json --outputFile=target/chat-final-tests.json` : 1406 tests passent.
- Les deux premières exécutions globales ont eu des délais dépassés, puis un worker arrêté. La compilation parallèle était terminée lors de l'exécution séquentielle réussie.
- `cargo test -p boite-pilot -p boite-core` : 82 tests d'adaptateurs et 668 du cœur passent; 1 smoke OpenCode installé ignoré.
- `cargo test -p boite --lib app_data::tests` : 14 tests passent, dont l'exclusion des identifiants isolés.
- `bun run build:chat-preview` : compilation terminée, `target/chat-preview/debug/boite.exe` produit.
- `node scripts/verify-chat-preview.mjs` : assets courants intégrés, identifiant isolé, absence de console et sidecar validés.
- `node scripts/chat-smoke/run.mjs` : desktop, mobile, connexion et échec passent avec backend simulé. Captures relues; aucun débordement horizontal. Edge et le serveur de test sont fermés.
- `bun run budget` : 6442,5 Ko livrés, plafond 6464 Ko. `git diff --check` passe.

Non vérifié : ouverture de l'application Tauri complète à l'écran et réponse
d'un vrai compte fournisseur. Aucun appel de modèle lancé. Le typecheck rapide
échoue toujours sur les deux imports `ContextMenuItem` déjà présents dans HEAD;
le contrôle Svelte officiel passe.

Revérifier : suivre `docs/chat-preview.md`, ouvrir le binaire de test, choisir
un projet, cliquer sur Codex ou Claude et envoyer un premier message.

À toi : tester ce binaire, pas l'ancien raccourci ni `target/debug/boite.exe`.
Aucun commit ni push. Le checkout initial reste inchangé.

Cout estime (1 j) : 0 $ ; principal 0 $ ; ouvriers 0 $ (0 ouvriers, med 0 tours, max 0, 0 de plus de 100 tours).
Sortie de `python C:/Users/Skoll/.ai/bin/cout.py 1`; le script ne mesure pas
la consommation de cette session Codex. Aucun sous-agent utilisé.

## 2026-09-05, publication de la branche pilot SDK

Constat : publication demandée sur la branche de travail, pas sur main.
Le remote `origin` redirige de `klNuno/boite` vers `beboite/boite-legacy`.

Changé : les commits `6608134` (adaptateurs), `f1389e9` (messagerie),
`9c7c6f5` (version autonome) et `005e73a` (fixture serveur) ont été poussés
sur `work/pilot-sdk`. Le test serveur initialise maintenant le champ
`questions`, requis par le protocole porté. Le README décrit le lancement
en chat par défaut. L'audit, ce journal et le backlog accompagnent le port.

Vérifié : `git push -u origin HEAD:refs/heads/work/pilot-sdk` a créé la branche
distante. L'identité Git et les comptes utilisés par GitHub CLI et HTTPS sont
`ChrisPlayer`. Le scan de secrets ne relève aucun candidat dans les fichiers
modifiés; les correspondances du dépôt sont des noms CSS et des tests de
masquage inchangés. Aucun exécutable, profil de navigateur ou log de test ajouté.

`bun run check` passe sans erreur ni avertissement. `cargo test --workspace`
passe avec 1018 tests et un smoke OpenCode ignoré, après correction de la
fixture serveur. Le rapport frontend de la version testée porte 1406 succès.
Le budget et `node scripts/verify-chat-preview.mjs` passent.

Revérifier : comparer HEAD à `origin/work/pilot-sdk` et vérifier l'auteur GitHub
du dernier commit de documentation après son push.

Non vérifié : essai avec les comptes fournisseurs réels. Clippy global échoue
sur `nonminimal_bool` dans `crates/boite-core/src/usage.rs:634`, identique à la
base `9b77b85` et hors des changements. Les deux erreurs préexistantes du
typecheck rapide restent documentées dans l'entrée précédente.

À toi : aucun accord supplémentaire demandé. La publication a été autorisée
explicitement; aucun merge, rebase, pull, push forcé ou changement de la branche
par défaut effectué.

Cout estime (1 j) : 0 $ ; principal 0 $ ; ouvriers 0 $ (0 ouvriers, med 0 tours, max 0, 0 de plus de 100 tours).
Sortie de `python C:/Users/Skoll/.ai/bin/cout.py 1`; ce rapport ne mesure pas
la consommation de cette session Codex.
