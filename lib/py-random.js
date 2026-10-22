/* CPython-compatible Mersenne Twister so JS results match the Python solver. */

const N = 624;
const M = 397;
const MATRIX_A = 0x9908b0df;
const UPPER = 0x80000000;
const LOWER = 0x7fffffff;

export class PyRandom {
  constructor(seed = 0) {
    this.mt = new Uint32Array(N);
    this.index = N;
    this.initByArray(toKey(seed));
  }

  initGenrand(s) {
    this.mt[0] = s >>> 0;
    for (let i = 1; i < N; i++) {
      const prev = this.mt[i - 1];
      this.mt[i] = (Math.imul(1812433253, prev ^ (prev >>> 30)) + i) >>> 0;
    }
    this.index = N;
  }

  initByArray(key) {
    this.initGenrand(19650218);
    let i = 1, j = 0;
    for (let k = Math.max(N, key.length); k > 0; k--) {
      const prev = this.mt[i - 1];
      this.mt[i] = (((this.mt[i] ^ Math.imul(prev ^ (prev >>> 30), 1664525)) >>> 0) + key[j] + j) >>> 0;
      i++; j++;
      if (i >= N) { this.mt[0] = this.mt[N - 1]; i = 1; }
      if (j >= key.length) j = 0;
    }
    for (let k = N - 1; k > 0; k--) {
      const prev = this.mt[i - 1];
      this.mt[i] = (((this.mt[i] ^ Math.imul(prev ^ (prev >>> 30), 1566083941)) >>> 0) - i) >>> 0;
      i++;
      if (i >= N) { this.mt[0] = this.mt[N - 1]; i = 1; }
    }
    this.mt[0] = 0x80000000;
    this.index = N;
  }

  twist() {
    for (let i = 0; i < N; i++) {
      const y = (this.mt[i] & UPPER) | (this.mt[(i + 1) % N] & LOWER);
      this.mt[i] = this.mt[(i + M) % N] ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0);
    }
    this.index = 0;
  }

  genrand() {
    if (this.index >= N) this.twist();
    let y = this.mt[this.index++];
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }

  getrandbits(k) {
    if (k <= 0) return 0;
    return this.genrand() >>> (32 - k);
  }

  randbelow(n) {
    if (n <= 0) throw new Error('Upper bound must be positive');
    if (n <= 1) return 0;
    const k = 32 - Math.clz32(n); // bit_length(n)
    let r = this.getrandbits(k);
    while (r >= n) r = this.getrandbits(k);
    return r;
  }

  random() {
    const a = this.genrand() >>> 5;
    const b = this.genrand() >>> 6;
    return (a * 67108864.0 + b) / 9007199254740992.0;
  }

  randrange(start, stop) {
    if (stop === undefined) { stop = start; start = 0; }
    return start + this.randbelow(stop - start);
  }

  shuffle(list) {
    for (let i = list.length - 1; i > 0; i--) {
      const j = this.randbelow(i + 1);
      const t = list[i]; list[i] = list[j]; list[j] = t;
    }
    return list;
  }

  sample(population, k) {
    const n = population.length;
    if (k > n) throw new Error('Sample larger than population');
    const result = new Array(k);
    let setsize = 21;
    if (k > 5) setsize += 4 ** Math.ceil(Math.log(k * 3) / Math.log(4));
    if (n <= setsize) {
      const pool = Array.from(population);
      for (let i = 0; i < k; i++) {
        const j = this.randbelow(n - i);
        result[i] = pool[j];
        pool[j] = pool[n - i - 1];
      }
    } else {
      const chosen = new Set();
      for (let i = 0; i < k; i++) {
        let j = this.randbelow(n);
        while (chosen.has(j)) j = this.randbelow(n);
        chosen.add(j);
        result[i] = population[j];
      }
    }
    return result;
  }
}

/** CPython packs an int seed into little-endian 32-bit words (abs value, inverted if negative). */
function toKey(seed) {
  let v = Math.trunc(seed);
  const negative = v < 0;
  if (negative) v = -v;
  const key = [];
  if (v === 0) key.push(0);
  while (v > 0) {
    key.push(v % 4294967296);
    v = Math.floor(v / 4294967296);
  }
  if (negative) {
    for (let i = 0; i < key.length; i++) key[i] = (~key[i]) >>> 0;
    key[key.length - 1] = (key[key.length - 1] + 1) >>> 0;
  }
  return key;
}
