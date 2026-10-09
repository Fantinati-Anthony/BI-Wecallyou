const MAX_BODY = 64 * 1024;

export class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export const fail = (status, code) => {
  throw new HttpError(status, code);
};

export function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(body);
}

/** Corps brut (nécessaire pour vérifier une signature, comme celle de Stripe). */
export async function readRaw(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) fail(413, 'too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function readJson(req) {
  const raw = await readRaw(req);
  try {
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : {};
  } catch {
    fail(400, 'bad_json');
  }
}

/** Adresse du visiteur, gardée en mémoire seulement le temps de limiter les abus. */
export function clientIp(req) {
  return req.headers['cf-connecting-ip'] ?? req.headers['x-forwarded-for']?.split(',')[0].trim() ?? req.socket.remoteAddress ?? '';
}

/** Limiteur en mémoire : quelques essais par fenêtre de temps. */
export class RateLimit {
  #hits = new Map();

  constructor() {
    setInterval(() => {
      const now = Date.now();
      for (const [key, hit] of this.#hits) if (hit.reset < now) this.#hits.delete(key);
    }, 60_000).unref();
  }

  check(key, limit, windowMs) {
    const now = Date.now();
    let hit = this.#hits.get(key);
    if (!hit || hit.reset < now) this.#hits.set(key, (hit = { count: 0, reset: now + windowMs }));
    if (++hit.count > limit) fail(429, 'too_many');
  }
}
