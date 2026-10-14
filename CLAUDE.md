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
- Avant de livrer : `pnpm typecheck` et `pnpm test` (faux Ollama, pas besoin
  du vrai).
- Commits en français (`feat:` / `fix:` / `test:` / `docs:` / `chore:`),
  titre court, corps en puces.
- pnpm uniquement (version épinglée, versions exactes, pas de scripts
  d'installation).

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
