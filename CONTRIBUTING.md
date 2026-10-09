# Contribuer à WeCall.You

Merci ! Le projet est communautaire : idées, corrections, traductions et tests sur le terrain sont tous bienvenus.

## Les principes à respecter

1. **Le serveur ne sait rien d’utile.** Aucune coordonnée en clair côté serveur, jamais. Tout ce qui est personnel est chiffré dans le navigateur.
2. **Rien tant que ce n’est pas utile.** Un ticket imprimé n’occupe rien ; chaque donnée a une durée de vie et une purge.
3. **Zéro dépendance côté serveur**, zéro script tiers côté pages (CSP stricte). Une dépendance doit être vraiment indispensable, et elle se discute d’abord dans une issue.
4. **Le papier reste roi.** Un client qui ne scanne pas doit toujours pouvoir être appelé comme avant.
5. **Simple et accessible** : gros boutons, textes courts, français et anglais (`public/assets/i18n.js`).

## Avant d’ouvrir une pull request

```sh
cd server && npm test
cd ../e2e && npm install && node run.mjs
```

- Ajoutez un test pour tout changement de comportement du serveur ou de la cryptographie.
- Gardez le style du code existant (modules ES, commentaires en français, noms explicites).
- Une modification de la cryptographie ou du stockage doit expliquer son impact sur les tickets **déjà imprimés** : ils doivent rester valides.

## Signaler une faille

Pas d’issue publique : voir [SECURITY.md](SECURITY.md).
