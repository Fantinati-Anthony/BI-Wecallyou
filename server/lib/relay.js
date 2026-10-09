// Relais aveugle des notifications. Le téléphone du commerçant prépare chaque notification
// (chiffrée pour le téléphone du client, signée avec la clé du lot) ; le serveur se contente
// de la transmettre au service de Google, Apple, Mozilla ou Microsoft. Il ne peut pas la lire
// et n'en garde rien.

const PUSH_SERVICES = ['fcm.googleapis.com', 'push.apple.com', 'push.services.mozilla.com', 'notify.windows.com'];
const MAX_BODY = 4096;

export function isPushEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.length > 1024) return false;
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && PUSH_SERVICES.some((h) => url.hostname === h || url.hostname.endsWith(`.${h}`));
}

/** Vérifie une notification préparée par le commerçant ; null si elle est refusée. */
export function checkMessage(message, vapidPublicKey) {
  if (!message || typeof message !== 'object' || !isPushEndpoint(message.endpoint)) return null;
  const auth = message.authorization;
  const match = typeof auth === 'string' && auth.length < 1024 && /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=([\w-]+)$/.exec(auth);
  // La signature doit être celle du lot : le relais ne sert pas à envoyer pour quelqu'un d'autre.
  if (!match || match[1] !== vapidPublicKey) return null;
  if (typeof message.body !== 'string' || !/^[\w-]+$/.test(message.body)) return null;
  const body = Buffer.from(message.body, 'base64url');
  if (body.length < 103 || body.length > MAX_BODY) return null;
  const ttl = Number.isInteger(message.ttl) ? Math.min(Math.max(message.ttl, 0), 86_400) : 900;
  return { endpoint: message.endpoint, authorization: auth, body, ttl };
}

/** Transmet les notifications ; renvoie le code HTTP de chaque service (0 = injoignable). */
export async function relay(messages) {
  return Promise.all(
    messages.map(async (m) => {
      try {
        const res = await fetch(m.endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Encoding': 'aes128gcm',
            TTL: String(m.ttl),
            Urgency: 'high',
            Authorization: m.authorization,
          },
          body: m.body,
          redirect: 'error', // jamais ailleurs que chez le service de notification vérifié
          signal: AbortSignal.timeout(8000),
        });
        await res.body?.cancel();
        return res.status;
      } catch {
        return 0;
      }
    }),
  );
}
