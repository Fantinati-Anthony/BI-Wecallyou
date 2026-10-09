import { createCipheriv, createDecipheriv } from 'node:crypto';
import * as base32 from './base32.js';

export const Role = Object.freeze({ CLIENT: 0, STUB: 1 });

const VERSION = 1;
const CHECK = Buffer.alloc(7); // 56 bits de contrôle : un code inventé a 1 chance sur 7·10^16 d'être valide

/**
 * Code de 26 caractères imprimé dans chaque QR : numéro de lot, numéro de ticket et rôle
 * (ticket client ou souche), chiffrés ensemble en un seul bloc AES. Rien n'est stocké :
 * le serveur reconnaît ses tickets en les déchiffrant.
 */
export class Tokens {
  #key;

  constructor(key) {
    if (key.length !== 16) throw new Error('tokenKey doit faire 16 octets');
    this.#key = key;
  }

  encode(lot, n, role) {
    const block = Buffer.alloc(16);
    block.writeUInt8((VERSION << 4) | role, 0);
    block.writeUInt32BE(lot, 1);
    block.writeUInt32BE(n, 5);
    const cipher = createCipheriv('aes-128-ecb', this.#key, null).setAutoPadding(false);
    return base32.encode(Buffer.concat([cipher.update(block), cipher.final()]));
  }

  decode(text) {
    if (typeof text !== 'string' || text.length !== 26) return null;
    const bin = base32.decode(text);
    if (!bin || bin.length !== 16) return null;
    const decipher = createDecipheriv('aes-128-ecb', this.#key, null).setAutoPadding(false);
    const block = Buffer.concat([decipher.update(bin), decipher.final()]);
    if (!block.subarray(9).equals(CHECK) || block[0] >> 4 !== VERSION) return null;
    const role = block[0] & 0x0f;
    if (role !== Role.CLIENT && role !== Role.STUB) return null;
    return { lot: block.readUInt32BE(1), n: block.readUInt32BE(5), role };
  }
}

export const label = (n) => String(n).padStart(3, '0');
