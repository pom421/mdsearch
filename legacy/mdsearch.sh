#!/usr/bin/env bash
# mdsearch.sh — recherche BM25 sur un dossier Markdown (SQLite FTS5)
# Usage :
#   ./mdsearch.sh index  <dossier>          # (ré)indexe tous les .md
#   ./mdsearch.sh search "<requête>" [n]    # top n résultats (défaut 10)
# Base : $MDSEARCH_DB (défaut ./mdsearch.db)

set -euo pipefail
DB="${MDSEARCH_DB:-mdsearch.db}"

command -v sqlite3 >/dev/null || { echo "sqlite3 requis" >&2; exit 1; }

cmd="${1:-}"; shift || true

case "$cmd" in
  index)
    dir="${1:?dossier manquant}"
    # Table FTS5 : path non indexé, title+body indexés
    # tokenizer unicode61 + remove_diacritics → "modele" trouve "modèle"
    sqlite3 "$DB" <<'SQL'
DROP TABLE IF EXISTS docs;
CREATE VIRTUAL TABLE docs USING fts5(
  path UNINDEXED, title, body,
  tokenize = 'unicode61 remove_diacritics 2'
);
SQL
    # Génère les INSERT (readfile = fonction du CLI sqlite3)
    find "$dir" -type f -name '*.md' -print0 |
    while IFS= read -r -d '' f; do
      esc=${f//\'/\'\'}                                   # échappe les '
      title=$(grep -m1 '^# ' "$f" | sed 's/^# //' || true)
      [ -z "$title" ] && title=$(basename "$f" .md)
      title=${title//\'/\'\'}
      printf "INSERT INTO docs VALUES('%s','%s',CAST(readfile('%s') AS TEXT));\n" \
        "$esc" "$title" "$esc"
    done | { echo "BEGIN;"; cat; echo "COMMIT;"; } | sqlite3 "$DB"
    echo "Indexé : $(sqlite3 "$DB" 'SELECT count(*) FROM docs;') fichiers → $DB"
    ;;

  search)
    q="${1:?requête manquante}"; n="${2:-10}"
    q=${q//\'/\'\'}
    # bm25(docs, 0, 10, 1) : poids colonnes path/title/body → titre x10
    # score plus négatif = plus pertinent
    sqlite3 -separator ' | ' "$DB" "
      SELECT printf('%.3f', bm25(docs, 0, 10, 1)) AS score,
             path,
             replace(snippet(docs, 2, '[', ']', '…', 12), char(10), ' ')
      FROM docs
      WHERE docs MATCH '$q'
      ORDER BY bm25(docs, 0, 10, 1)
      LIMIT $n;"
    ;;

  *)
    sed -n '2,6p' "$0"; exit 1 ;;
esac
