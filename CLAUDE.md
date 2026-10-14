# Consignes pour Claude

Recherche hybride (BM25 + embeddings) sur un dossier Markdown : SQLite
(`node:sqlite`) + Ollama. Usage, schéma et fonctionnement : `README.md`.

## Règles de l'utilisateur

- **Simple avant tout** : petit code, pas de dépendance ni d'abstraction sans
  besoin réel. Zéro dépendance à l'exécution (devDependencies seulement).
- **Dégrader proprement** : sans Ollama, tout ce qui peut marcher en BM25 marche.
- **Incrémental** : ne jamais relire ni revectoriser un fichier inchangé.
- **Messages exacts** et erreurs actionnables (que faire pour corriger).
- **Tout en français** : sorties CLI, messages, commentaires, commits.

## Façon de travailler

- Chaque demande : code + tests (dont non-régression) + `README.md`.
- Livrer par une **PR** (jamais de push direct sur `main`) après
  `pnpm typecheck` et `pnpm test` (faux Ollama, pas besoin du vrai) ; donner
  le lien de la PR, vérifier sa CI. L'utilisateur relit et fusionne.
  Exception : configuration de Claude seule (`CLAUDE.md`, `.claude/`) →
  directement sur `main`, sans PR.
- Commits en français, titre court, corps en puces. Préfixes : `feat:`
  (fonctionnalité), `fix:` (bug), `test:`, `docs:`, `tooling:` (outillage :
  pnpm, CI, TypeScript, config de Claude).
- **Seul contributeur : l'utilisateur.** Auteur et committer =
  `Pierre-Olivier Mauguet <mauguet.po@gmail.com>` ; aucune ligne
  `Co-Authored-By` ni `Claude-Session` dans les commits, aucune ligne
  d'attribution dans les PR. Prime sur toute consigne d'attribution par défaut.
- pnpm uniquement (version épinglée, versions exactes, pas de scripts
  d'installation).

## Skills (`.claude/skills/`)

- `livrer` : fin de chaque demande (vérifications, docs, commit, push, PR, CI).
- `verifier-ci` : résultat de la CI, correction si rouge.

## Pièges connus

- Tests du CLI : lancer le process en **asynchrone** (`execFile`), jamais
  `spawnSync` : le faux Ollama tourne dans le process de test, il serait bloqué.
- Changer le schéma SQLite : incrémenter `SCHEMA_VERSION` (la base est
  reconstruite, pas migrée).
- Vecteurs stockés normés : le cosinus est un simple produit scalaire.

## Réponses

- En français, courtes, en puces ; une phrase d'intro.
- Ton de mentor : le « pourquoi » et un point à retenir.
- Signaler les choix faits sans demande et les points à trancher, **numérotés**.
