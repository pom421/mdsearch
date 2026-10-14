# mdsearch

Recherche **hybride** sur un dossier Markdown : BM25 (mots exacts) + embeddings (sens), fusionnés par RRF.
Tout tient dans un fichier SQLite. Conçu comme outil `search` pour un agent LLM qui navigue un wiki personnel (pattern « LLM Wiki »).

- Zéro dépendance à l'exécution : `node:sqlite` (FTS5 inclus) + `fetch` vers Ollama
- Indexation **incrémentale** (mtime + hash) : seuls les fichiers modifiés sont relus et revectorisés
- Mode `watch` : réindexe à chaque sauvegarde
- Dégradation propre : sans Ollama → BM25 seul

## Prérequis

- Node ≥ 22.6 (≥ 23.6 : plus besoin de `--experimental-strip-types`)
- [Ollama](https://ollama.com) + modèle d'embedding : `ollama pull bge-m3` (multilingue, bon en français)
- Optionnel : sans Ollama, utiliser `--no-embed` (BM25 seul)

## Usage

```bash
npm run mdsearch -- index ~/wiki                 # index incrémental (BM25 + vecteurs)
npm run mdsearch -- index ~/wiki --rebuild       # repart de zéro
npm run mdsearch -- index ~/wiki --no-embed      # BM25 seul, sans Ollama
npm run mdsearch -- watch ~/wiki                 # réindexe à chaque sauvegarde
npm run mdsearch -- search "automobile"          # hybride (défaut)
npm run mdsearch -- search "lora" 5 --mode bm25  # bm25 | vector | hybrid
npm run mdsearch -- optimize                     # compacte l'index FTS5 + VACUUM
```

Sortie hybride : `score (rang bm25, rang vecteur) | fichier | extrait`

```
0.0328 (bm25 #1, vec #1) | /…/lora.md | # [LoRA] [LoRA] fine-tuning léger des modèles.
```

### Syntaxe des requêtes BM25 (FTS5)

- `lora fine` → les deux mots
- `lora OR qlora` → l'un ou l'autre
- `"fine-tuning"` → expression exacte (obligatoire avec un tiret)
- `modele*` → préfixe
- `lora NOT gpu` → exclusion
- Accents ignorés : `modeles` trouve `modèles`

### Utilisation en bibliothèque

```ts
import { index, search } from "./src/mdsearch.ts";

await index("/chemin/wiki");
const { mode, hits } = await search("automobile", { limit: 5 });
// hits : { score, path, snippet, ranks? }[]
```

## Configuration

| Variable | Défaut | Rôle |
|---|---|---|
| `MDSEARCH_DB` | `./mdsearch.db` | Fichier SQLite |
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | Serveur Ollama |
| `MDSEARCH_EMBED_MODEL` | `bge-m3` | Modèle d'embedding |

Réglages fins en tête de `src/mdsearch.ts` : taille des chunks (300 mots), taille des lots, nb de candidats avant fusion, constante RRF (60), seuil d'optimize auto (100 changements).

## Fonctionnement

**Schéma SQLite**

- `files` : 1 ligne par fichier → `path`, `mtime`, `size`, `hash`, `embed_model`
- `docs` (FTS5) : 1 ligne par fichier, `rowid` = `files.id` → recherche BM25
- `chunks` : N morceaux par fichier, chacun avec son vecteur (BLOB `Float32Array` normé)
- `meta` : compteurs (changements depuis le dernier optimize)

**Indexation**

1. Scan : mtime + taille identiques → fichier ignoré sans être lu
2. Sinon hash SHA-256 : contenu identique → simple mise à jour des métadonnées
3. Fichiers nouveaux/modifiés : découpage par titres puis paragraphes (~300 mots), chaque chunk vectorisé avec son contexte `Titre > Section`
4. Écriture par lots de 32 fichiers, 1 transaction par lot
5. Fichiers disparus retirés (uniquement sous le dossier indexé)
6. `optimize` FTS5 automatique tous les 100 changements

**Recherche hybride**

- BM25 : top 50 fichiers
- Vecteurs : force brute, cosinus sur tous les chunks, meilleur chunk par fichier, top 50
- Fusion RRF : `score = Σ 1 / (60 + rang)` → utilise les rangs, pas les scores (échelles incompatibles)

**Limites connues**

- Force brute : OK jusqu'à ~100 000 chunks ; au-delà, passer à l'extension `sqlite-vec`
- Changer de modèle d'embedding → tout est revectorisé (automatique)
- Contenu modifié avec mtime restauré (`rsync -t`…) non détecté → `--rebuild`

## Développement

```bash
npm install       # TypeScript + types (dev uniquement)
npm test          # 15 tests, faux serveur Ollama intégré (pas besoin d'Ollama)
npm run typecheck # tsc --strict
```

## Historique

- `legacy/mdsearch.sh` : v0, prototype bash + `sqlite3` (BM25 seul, réindexation complète)
- v1 : portage TypeScript, incrémental, watch, optimize
- v2 : chunks + embeddings Ollama + recherche hybride RRF
