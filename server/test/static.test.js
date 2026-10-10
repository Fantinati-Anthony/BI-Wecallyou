// Fichiers « prêt » lus par les pages client en secours du direct : servis depuis leur dossier
// (public/etat par défaut, un dossier temporaire pour les tests), 404 « attente » tant que le
// ticket n'est pas appelé.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStatic } from '../lib/static.js';
import { Store } from '../lib/store.js';

test('fichiers d’état : servis depuis leur dossier, « attente » sinon', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'wcy-static-'));
  const publicDir = path.join(tmp, 'public');
  const etatDir = path.join(tmp, 'etat');
  mkdirSync(publicDir);
  mkdirSync(etatDir);
  writeFileSync(path.join(publicDir, 'index.html'), '<!doctype html>');
  const store = new Store({ dataDir: path.join(tmp, 'data'), publicDir, etatDir, statusKey: Buffer.alloc(32) });
  assert.equal(path.dirname(store.statusFile('abc')), etatDir);
  assert.equal(path.dirname(new Store({ dataDir: tmp, publicDir, statusKey: Buffer.alloc(32) }).statusFile('abc')), path.join(publicDir, 'etat'));
  writeFileSync(store.statusFile('abc'), 'prêt');

  const serve = createStatic(publicDir, etatDir);
  const server = http.createServer(async (req, res) => {
    if (!(await serve(req, res, new URL(req.url, 'http://x').pathname))) res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const ready = await fetch(`${base}/etat/abc.txt`);
    assert.equal(ready.status, 200);
    assert.equal(await ready.text(), 'prêt');
    assert.equal(ready.headers.get('cache-control'), 'public, max-age=2');
    const waiting = await fetch(`${base}/etat/${'0'.repeat(32)}.txt`);
    assert.equal(waiting.status, 404);
    assert.equal(await waiting.text(), 'attente');
    assert.equal((await fetch(`${base}/`)).status, 200);
  } finally {
    server.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});
