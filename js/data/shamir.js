// js/data/shamir.js — Shamir Secret Sharing (2-of-3) over GF(2^8) for the
// vault recovery key. All math is client-side: the server never sees shard
// plaintext and any single shard is cryptographically useless alone.
//
// Shard format (per user artifact):
//   NOTIVE-SHARD-n <BASE32 groups...> <CHECK>   — crockford base32 (no I/L/O/U)
// Bytes encoded per shard: [x (1|2|3)] ++ [secret bytes]. CHECK is 4 base32
// chars of SHA-256 over the raw bytes (typo detection, not secrecy).

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(function buildTables() {
  const prim = 0x11d; // x^8 + x^4 + x^3 + x^2 + 1
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= prim;
  }
  for (let i = 255; i < 512; i += 1) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // crockford base32

function base32Encode(bytes) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    value = (value << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(text) {
  const clean = String(text).replace(/[^0-9A-Z]/gi, '').toUpperCase()
    .replace(/O/g, '0').replace(/[IL]/g, '1');
  const out = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error('bad shard char');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

async function shardChecksum(dataBytes) {
  const digest = new Uint8Array(await window.crypto.subtle.digest('SHA-256', dataBytes));
  return base32Encode(digest.subarray(0, 3)).slice(0, 4); // 4 base32 chars
}

// Split a byte string into `total` shards, any `threshold` reconstructing it.
// Returns plain objects { x, y: Uint8Array } so callers control the encoding.
export function shamirSplit(secretBytes, threshold, count) {
  if (!(threshold >= 1 && threshold <= count && count <= 255)) throw new Error('shamir params');
  if (threshold === 1 || threshold === count) {
    // Degenerate thresholds: not used by Notive's 2-of-3, kept for tests only.
    const coeffs = [new Uint8Array(secretBytes)];
    for (let i = 1; i < threshold; i += 1) coeffs.push(e2eeRandom(secretBytes.length));
    return makeSharesFromCoeffs(coeffs, count);
  }
  const coeffs = [new Uint8Array(secretBytes)];
  for (let i = 1; i < threshold; i += 1) coeffs.push(e2eeRandom(secretBytes.length));
  const shares = [];
  for (let x = 1; x <= count; x += 1) {
    const y = new Uint8Array(secretBytes.length);
    for (let j = 0; j < secretBytes.length; j += 1) {
      let acc = coeffs[threshold - 1][j]; // degree threshold-1 polynomial constant-first
      for (let k = threshold - 2; k >= 0; k -= 1) {
        acc = gfMul(acc, x) ^ coeffs[k][j];
      }
      y[j] = acc;
    }
    shares.push({ x, y });
  }
  return shares;
}

function e2eeRandom(length) {
  const arr = new Uint8Array(length);
  window.crypto.getRandomValues(arr);
  return arr;
}

function makeSharesFromCoeffs(coeffs, count) {
  const shares = [];
  for (let x = 1; x <= count; x += 1) {
    const y = new Uint8Array(coeffs[0].length);
    for (let j = 0; j < y.length; j += 1) {
      let acc = coeffs[coeffs.length - 1][j];
      for (let k = coeffs.length - 2; k >= 0; k -= 1) acc = gfMul(acc, x) ^ coeffs[k][j];
      y[j] = acc;
    }
    shares.push({ x, y });
  }
  return shares;
}

// Rebuild the secret from any `threshold` shares via Lagrange interpolation
// evaluated at x = 0. Exported for the vault recovery path (async for checksum).
export function shamirCombine(shares) {
  if (!Array.isArray(shares) || shares.length < 2) throw new Error('not enough shards');
  const seen = new Set();
  for (const share of shares) {
    if (!share || typeof share.x !== 'number' || !(share.x >= 1 && share.x <= 255)) throw new Error('bad shard point');
    if (!(share.y instanceof Uint8Array) || share.y.length === 0) throw new Error('bad shard bytes');
    if (seen.has(share.x)) throw new Error('duplicate shard');
    seen.add(share.x);
  }
  if (new Set(shares.map((s) => s.y.length)).size !== 1) throw new Error('shard length mismatch');
  const threshold = shares.length;
  const secret = new Uint8Array(shares[0].y.length);
  for (let j = 0; j < secret.length; j += 1) {
    let acc = 0;
    for (let i = 0; i < shares.length; i += 1) {
      let product = shares[i].y[j];
      for (let k = 0; k < shares.length; k += 1) {
        if (k === i) continue;
        const numerator = shares[k].x ^ 0; // interpolation target x = 0
        const denom = shares[i].x ^ shares[k].x;
        if (denom === 0) throw new Error('duplicate shard');
        product = gfMul(product, gfMul(numerator, gfInv(denom)));
      }
      acc ^= product;
    }
    secret[j] = acc;
  }
  return secret;
}

function gfInv(a) {
  if (a === 0) throw new Error('gf inverse of zero');
  return GF_EXP[255 - GF_LOG[a]];
}

const SHARD_PREFIX = (x) => `NOTIVE-SHARD-${x}`;

// Public API used by the vault: split + encode each share to its printable
// artifact. Shards are shown once; the caller never uploads paper shards.
export async function shamirSplitPublic(secretBytes, threshold, count) {
  const shares = shamirSplit(secretBytes, threshold, count);
  const out = [];
  for (const share of shares) {
    const raw = new Uint8Array(1 + share.y.length);
    raw[0] = share.x;
    raw.set(share.y, 1);
    const body = base32Encode(raw) + (await shardChecksum(raw));
    // Group the body into readable 8-char chunks separated by dashes.
    const groups = body.match(/.{1,8}/g) || [];
    out.push(`${SHARD_PREFIX(share.x)} ${groups.join('-')}`);
  }
  return out;
}

// Parse + verify checksum, returning { x, y } shares ready for shamirCombine.
export async function shamirParsePublic(shardTexts) {
  if (!Array.isArray(shardTexts) || shardTexts.length === 0) throw new Error('no shards');
  const shares = [];
  for (const text of shardTexts) {
    const match = /^NOTIVE-SHARD-([1-9])\s+(.+)$/i.exec(String(text || '').trim().toUpperCase());
    if (!match) throw new Error('bad shard format');
    const x = Number(match[1]);
    if (!(x >= 1 && x <= 255)) throw new Error('bad shard point');
    const body = match[2].replace(/[^0-9A-Z]/g, '');
    if (body.length < 9) throw new Error('shard too short');
    const raw = base32Decode(body.slice(0, -4));
    if (!raw.length || raw[0] !== x) throw new Error('shard point mismatch');
    const check = body.slice(-4);
    if ((await shardChecksum(raw)) !== check) throw new Error('shard checksum failed');
    shares.push({ x, y: raw.slice(1) });
  }
  return shares;
}
