/**
 * Void-and-cluster blue noise threshold map (Ulichney 1993).
 * Returns ranks normalised to [0, 1). Generated once and cached.
 */
const SIZE = 64;
let cached: Float32Array | null = null;

export const BLUE_NOISE_SIZE = SIZE;

export function blueNoise(): Float32Array {
  if (cached) return cached;
  const n = SIZE * SIZE;
  const sigma = 1.5;
  // Toroidal gaussian kernel, indexed by wrapped offset.
  const kernel = new Float32Array(n);
  for (let dy = 0; dy < SIZE; dy++) {
    for (let dx = 0; dx < SIZE; dx++) {
      const x = Math.min(dx, SIZE - dx);
      const y = Math.min(dy, SIZE - dy);
      kernel[dy * SIZE + dx] = Math.exp(-(x * x + y * y) / (2 * sigma * sigma));
    }
  }

  const pattern = new Uint8Array(n);
  const energy = new Float32Array(n);
  const toggle = (i: number, on: boolean) => {
    pattern[i] = on ? 1 : 0;
    const px = i % SIZE;
    const py = (i / SIZE) | 0;
    const sign = on ? 1 : -1;
    for (let y = 0; y < SIZE; y++) {
      const ky = ((y - py + SIZE) % SIZE) * SIZE;
      const row = y * SIZE;
      for (let x = 0; x < SIZE; x++) {
        energy[row + x] += sign * kernel[ky + ((x - px + SIZE) % SIZE)];
      }
    }
  };
  const tightestCluster = () => {
    let best = -1, bestE = -Infinity;
    for (let i = 0; i < n; i++) if (pattern[i] && energy[i] > bestE) { bestE = energy[i]; best = i; }
    return best;
  };
  const largestVoid = () => {
    let best = -1, bestE = Infinity;
    for (let i = 0; i < n; i++) if (!pattern[i] && energy[i] < bestE) { bestE = energy[i]; best = i; }
    return best;
  };

  // Seeded initial pattern, ~10% filled.
  let seed = 12345;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const initialCount = Math.floor(n / 10);
  let placed = 0;
  while (placed < initialCount) {
    const i = Math.floor(rand() * n);
    if (!pattern[i]) { toggle(i, true); placed++; }
  }
  // Phase 0: relax the initial pattern until it is evenly spread.
  for (let iter = 0; iter < n; iter++) {
    const c = tightestCluster();
    toggle(c, false);
    const v = largestVoid();
    if (v === c) { toggle(c, true); break; }
    toggle(v, true);
  }

  const ranks = new Int32Array(n);
  const initial = pattern.slice();
  const initialEnergy = energy.slice();

  // Phase 1: remove from the initial pattern, ranking downwards.
  for (let rank = initialCount - 1; rank >= 0; rank--) {
    const c = tightestCluster();
    toggle(c, false);
    ranks[c] = rank;
  }
  pattern.set(initial);
  energy.set(initialEnergy);
  // Phase 2+3: fill the voids, ranking upwards.
  for (let rank = initialCount; rank < n; rank++) {
    const v = largestVoid();
    toggle(v, true);
    ranks[v] = rank;
  }

  cached = new Float32Array(n);
  for (let i = 0; i < n; i++) cached[i] = (ranks[i] + 0.5) / n;
  return cached;
}
