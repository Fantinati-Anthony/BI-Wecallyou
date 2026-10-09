import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Tokens, Role, label } from '../lib/token.js';
import * as base32 from '../lib/base32.js';

const tokens = new Tokens(randomBytes(16));

test('un code de ticket se relit à l’identique', () => {
  for (const [lot, n, role] of [[1, 1, Role.CLIENT], [2 ** 31 - 1, 99_999, Role.STUB], [123456, 42, Role.CLIENT]]) {
    const code = tokens.encode(lot, n, role);
    assert.match(code, /^[A-Z2-7]{26}$/);
    assert.deepEqual(tokens.decode(code), { lot, n, role });
    assert.deepEqual(tokens.decode(code.toLowerCase()), { lot, n, role });
  }
});

test('ticket client et souche ont des codes différents', () => {
  assert.notEqual(tokens.encode(7, 42, Role.CLIENT), tokens.encode(7, 42, Role.STUB));
});

test('un code modifié, inventé ou d’un autre serveur est refusé', () => {
  const code = tokens.encode(5, 10, Role.CLIENT);
  const swapped = code[3] === 'A' ? 'B' : 'A';
  assert.equal(tokens.decode(code.slice(0, 3) + swapped + code.slice(4)), null);
  assert.equal(tokens.decode('A'.repeat(26)), null);
  assert.equal(new Tokens(randomBytes(16)).decode(code), null);
  assert.equal(tokens.decode(code.slice(1)), null);
  assert.equal(tokens.decode(`${code.slice(0, 25)}1`), null);
  let valid = 0;
  for (let i = 0; i < 20_000; i++) if (tokens.decode(base32.encode(randomBytes(16)))) valid++;
  assert.equal(valid, 0);
});

test('base32 refuse les formes non canoniques', () => {
  const bytes = randomBytes(16);
  const code = base32.encode(bytes);
  assert.deepEqual(base32.decode(code), bytes);
  const last = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(code[25]);
  const altered = code.slice(0, 25) + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[last ^ 1];
  assert.equal(base32.decode(altered), null);
});

test('numéros affichés sur 3 chiffres minimum', () => {
  assert.equal(label(7), '007');
  assert.equal(label(1234), '1234');
});
