# Sécurité

## Signaler une faille

Merci de ne **pas** ouvrir d’issue publique. Utilisez l’onglet *Security > Report a vulnerability* du dépôt GitHub (signalement privé), ou écrivez à **[adresse de contact à compléter]**. Nous répondons sous 72 h et publions un correctif avant toute divulgation.

## Modèle de menace (résumé)

| Attaquant | Ce qu’il obtient | Ce qu’il n’obtient pas |
|---|---|---|
| Accès complet au serveur ou à ses sauvegardes | Noms de lots, numéros de tickets actifs, heures, compteurs | Aucune coordonnée (blocs chiffrés), ni la clé d’un lot, ni son mot de passe |
| Personne qui photographie un ticket client | Peut s’inscrire sur ce ticket (3 inscriptions max) | Rien sur les autres tickets ni sur les inscrits |
| Personne qui trouve une souche | Rien sans un téléphone connecté au lot | — |
| Personne qui trouve la page 1, lot **sans** mot de passe | Accès au lot : appels et inscrits en cours | — |
| Personne qui trouve la page 1, lot **avec** mot de passe | Doit deviner le mot de passe (PBKDF2, 600 000 tours, essais en ligne limités) | Accès au lot tant que le mot de passe tient |
| Réseau (Wi-Fi public…) | Rien : HTTPS partout, HSTS | — |
| Google, Apple, Mozilla (notifications) | Le fait qu’une notification part | Son contenu (chiffré de bout en bout) |

Hors périmètre : un téléphone de commerçant compromis (il détient la clé des lots qui y sont connectés), et le contenu des SMS, WhatsApp et e-mails une fois envoyés par le commerçant.
