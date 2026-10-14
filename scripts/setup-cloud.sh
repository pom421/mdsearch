#!/bin/bash
# Installe les dépendances dans un conteneur Claude Code (web / cloud).
# Idempotent et non interactif : peut tourner à chaque démarrage de session.
# Utilisé par le hook .claude/hooks/session-start.sh.
set -euo pipefail

cd "$(dirname "$0")/.."

# pnpm de la version épinglée dans package.json (packageManager, vérifiée par hash).
# Un corepack trop ancien ne sait pas télécharger pnpm 12 → mise à jour.
if ! corepack enable 2>/dev/null || ! COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm --version >/dev/null 2>&1; then
  npm install -g corepack@latest
  corepack enable
fi

# Lockfile respecté à la lettre ; le store pnpm est gardé en cache par le conteneur.
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm install --frozen-lockfile

echo "Dépendances installées. Vérifications : pnpm typecheck && pnpm test"
