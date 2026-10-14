#!/bin/bash
# Démarrage d'une session Claude Code sur le web : dépendances installées
# avant la première commande (mode synchrone, pas de course avec les tests).
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

"$CLAUDE_PROJECT_DIR/scripts/setup-cloud.sh"
