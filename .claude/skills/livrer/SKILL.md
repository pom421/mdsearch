---
name: livrer
description: Vérifier, documenter, commiter, pousser et ouvrir une PR vers main pour une modification terminée, puis suivre la CI de la PR. À utiliser à la fin de chaque demande de l'utilisateur qui modifie le code.
---

# Livrer une modification

1. **Vérifier** (tout doit passer) : `pnpm typecheck`, `pnpm test`.
   Un test qui échoue n'est jamais « instable » : trouver la cause
   (`node --disable-warning=ExperimentalWarning --test --test-name-pattern "<nom>" "test/*.test.ts"`).
2. **Relire `git diff`** : code mort, commentaires périmés, anglais, cas oublié
   (Ollama éteint, dossier vide, fichier sans titre, plusieurs dossiers dans
   la même base…).
3. **Docs** : `README.md` (usage, configuration, schéma, fonctionnement,
   limites) ; en-tête d'usage de `src/mdsearch.ts` si une commande ou une
   option change.
4. **Commit** en français (`feat:` / `fix:` / `test:` / `docs:` / `tooling:`),
   titre court, corps en puces. Auteur = l'utilisateur seul
   (`git config user.name "Pierre-Olivier Mauguet"`,
   `git config user.email mauguet.po@gmail.com`), **aucune** ligne
   `Co-Authored-By` ni `Claude-Session`.
5. **Pousser et ouvrir la PR** : jamais de push direct sur `main`, sauf pour
   un changement qui ne touche que la configuration de Claude (`CLAUDE.md`,
   `.claude/`) : `git push origin HEAD:main`, sans PR. Sur une
   branche de travail (en créer une si on est sur `main`) :
   `git push -u origin <branche>` (réessayer jusqu'à 4 fois si erreur réseau :
   2, 4, 8, 16 s), puis `gh pr create --base main` (titre = celui du commit,
   corps en puces, sans ligne d'attribution). Une nouvelle demande sur
   la même branche, PR encore ouverte : nouveau commit, même PR.
   Push refusé (pas d'accès GitHub dans la session) : le dire, donner les
   commandes exactes à lancer par l'utilisateur, ne pas contourner.
6. **CI** : app de bureau, PR suivie par l'app → elle prévient d'un échec, ne
   rien programmer. Sinon : vérification dans 4 minutes, consigne « skill
   verifier-ci pour la PR <numéro> ».
7. **Répondre** selon `CLAUDE.md`, avec le **lien de la PR**. Ne pas fusionner :
   l'utilisateur relit et fusionne.
