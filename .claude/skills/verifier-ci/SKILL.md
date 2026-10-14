---
name: verifier-ci
description: Vérifier le résultat de la CI GitHub Actions de pom421/mdsearch pour une PR (ou un commit), et corriger si elle est rouge. À utiliser quand un rappel de vérification de CI se déclenche ou après un push.
---

# Vérifier la CI

1. PR : `gh pr checks <numéro> --repo pom421/mdsearch`. Commit : retrouver son
   run (`head_sha`) parmi les derniers (`gh run list --repo pom421/mdsearch --limit 5`).
2. **En cours** : app de bureau (PR suivie par l'app) → rien à programmer ;
   sinon revérifier dans 3 minutes, sans rien dire.
3. **Vert** : réponse en puces avec les liens de la PR et du run.
4. **Rouge** :
   - lire les logs du job en échec (~120 lignes), reproduire en local ;
   - trouver la **cause** : jamais relancer « pour voir », désactiver un test ni
     commit vide ;
   - causes fréquentes : `pnpm install --frozen-lockfile` (lockfile non
     commité, ou version publiée il y a moins de 7 jours : `minimumReleaseAge`) ;
     corepack trop ancien pour la version de pnpm épinglée ;
   - corriger, relancer le test en boucle s'il est suspect, toute la suite,
     puis skill `livrer` (même branche, même PR) ; expliquer la cause en
     puces + un point « à retenir ».
