// Fichier de démarrage à indiquer dans cPanel > Setup Node.js App.
// L'hébergeur charge l'application avec require() : ce relais en CommonJS lance le vrai serveur (module ES).
import('./start.js').catch((err) => {
  console.error(err);
  process.exit(1);
});
