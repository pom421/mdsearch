// Bloque toute installation qui ne passe pas par pnpm (npm install / yarn).
// Zéro dépendance — lu par le hook "preinstall" avant même que pnpm/npm/yarn
// ne touche node_modules.
const userAgent = process.env.npm_config_user_agent || "";

if (!userAgent.startsWith("pnpm/")) {
  console.error(
    "\nCe projet utilise exclusivement pnpm (voir package.json > packageManager).\n" +
      'Installez avec : corepack enable && pnpm install\n' +
      `(gestionnaire détecté : ${userAgent || "inconnu"})\n`,
  );
  process.exit(1);
}
