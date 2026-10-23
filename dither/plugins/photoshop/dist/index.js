(function() {
	// src/engine/bluenoise.ts
	/**
	* Void-and-cluster blue noise threshold map (Ulichney 1993).
	* Returns ranks normalised to [0, 1). Generated once and cached.
	*/
	var SIZE = 64;
	var cached = null;
	function blueNoise() {
		if (cached) return cached;
		const n = 4096;
		const sigma = 1.5;
		const kernel = new Float32Array(n);
		for (let dy = 0; dy < SIZE; dy++) for (let dx = 0; dx < SIZE; dx++) {
			const x = Math.min(dx, SIZE - dx);
			const y = Math.min(dy, SIZE - dy);
			kernel[dy * SIZE + dx] = Math.exp(-(x * x + y * y) / (2 * sigma * sigma));
		}
		const pattern = new Uint8Array(n);
		const energy = new Float32Array(n);
		const toggle = (i, on) => {
			pattern[i] = on ? 1 : 0;
			const px = i % SIZE;
			const py = i / SIZE | 0;
			const sign = on ? 1 : -1;
			for (let y = 0; y < SIZE; y++) {
				const ky = (y - py + SIZE) % SIZE * SIZE;
				const row = y * SIZE;
				for (let x = 0; x < SIZE; x++) energy[row + x] += sign * kernel[ky + (x - px + SIZE) % SIZE];
			}
		};
		const tightestCluster = () => {
			let best = -1, bestE = -Infinity;
			for (let i = 0; i < n; i++) if (pattern[i] && energy[i] > bestE) {
				bestE = energy[i];
				best = i;
			}
			return best;
		};
		const largestVoid = () => {
			let best = -1, bestE = Infinity;
			for (let i = 0; i < n; i++) if (!pattern[i] && energy[i] < bestE) {
				bestE = energy[i];
				best = i;
			}
			return best;
		};
		let seed = 12345;
		const rand = () => (seed = seed * 1103515245 + 12345 & 2147483647) / 2147483647;
		const initialCount = Math.floor(n / 10);
		let placed = 0;
		while (placed < initialCount) {
			const i = Math.floor(rand() * n);
			if (!pattern[i]) {
				toggle(i, true);
				placed++;
			}
		}
		for (let iter = 0; iter < n; iter++) {
			const c = tightestCluster();
			toggle(c, false);
			const v = largestVoid();
			if (v === c) {
				toggle(c, true);
				break;
			}
			toggle(v, true);
		}
		const ranks = new Int32Array(n);
		const initial = pattern.slice();
		const initialEnergy = energy.slice();
		for (let rank = 408; rank >= 0; rank--) {
			const c = tightestCluster();
			toggle(c, false);
			ranks[c] = rank;
		}
		pattern.set(initial);
		energy.set(initialEnergy);
		for (let rank = initialCount; rank < n; rank++) {
			const v = largestVoid();
			toggle(v, true);
			ranks[v] = rank;
		}
		cached = new Float32Array(n);
		for (let i = 0; i < n; i++) cached[i] = (ranks[i] + .5) / n;
		return cached;
	}
	// src/engine/dither.ts
	var DIFFUSION_KERNELS = {
		"floyd-steinberg": {
			divisor: 16,
			taps: [
				[
					1,
					0,
					7
				],
				[
					-1,
					1,
					3
				],
				[
					0,
					1,
					5
				],
				[
					1,
					1,
					1
				]
			]
		},
		"false-floyd-steinberg": {
			divisor: 8,
			taps: [
				[
					1,
					0,
					3
				],
				[
					0,
					1,
					3
				],
				[
					1,
					1,
					2
				]
			]
		},
		atkinson: {
			divisor: 8,
			taps: [
				[
					1,
					0,
					1
				],
				[
					2,
					0,
					1
				],
				[
					-1,
					1,
					1
				],
				[
					0,
					1,
					1
				],
				[
					1,
					1,
					1
				],
				[
					0,
					2,
					1
				]
			]
		},
		"jarvis-judice-ninke": {
			divisor: 48,
			taps: [
				[
					1,
					0,
					7
				],
				[
					2,
					0,
					5
				],
				[
					-2,
					1,
					3
				],
				[
					-1,
					1,
					5
				],
				[
					0,
					1,
					7
				],
				[
					1,
					1,
					5
				],
				[
					2,
					1,
					3
				],
				[
					-2,
					2,
					1
				],
				[
					-1,
					2,
					3
				],
				[
					0,
					2,
					5
				],
				[
					1,
					2,
					3
				],
				[
					2,
					2,
					1
				]
			]
		},
		stucki: {
			divisor: 42,
			taps: [
				[
					1,
					0,
					8
				],
				[
					2,
					0,
					4
				],
				[
					-2,
					1,
					2
				],
				[
					-1,
					1,
					4
				],
				[
					0,
					1,
					8
				],
				[
					1,
					1,
					4
				],
				[
					2,
					1,
					2
				],
				[
					-2,
					2,
					1
				],
				[
					-1,
					2,
					2
				],
				[
					0,
					2,
					4
				],
				[
					1,
					2,
					2
				],
				[
					2,
					2,
					1
				]
			]
		},
		burkes: {
			divisor: 32,
			taps: [
				[
					1,
					0,
					8
				],
				[
					2,
					0,
					4
				],
				[
					-2,
					1,
					2
				],
				[
					-1,
					1,
					4
				],
				[
					0,
					1,
					8
				],
				[
					1,
					1,
					4
				],
				[
					2,
					1,
					2
				]
			]
		},
		sierra: {
			divisor: 32,
			taps: [
				[
					1,
					0,
					5
				],
				[
					2,
					0,
					3
				],
				[
					-2,
					1,
					2
				],
				[
					-1,
					1,
					4
				],
				[
					0,
					1,
					5
				],
				[
					1,
					1,
					4
				],
				[
					2,
					1,
					2
				],
				[
					-1,
					2,
					2
				],
				[
					0,
					2,
					3
				],
				[
					1,
					2,
					2
				]
			]
		},
		"sierra-two-row": {
			divisor: 16,
			taps: [
				[
					1,
					0,
					4
				],
				[
					2,
					0,
					3
				],
				[
					-2,
					1,
					1
				],
				[
					-1,
					1,
					2
				],
				[
					0,
					1,
					3
				],
				[
					1,
					1,
					2
				],
				[
					2,
					1,
					1
				]
			]
		},
		"sierra-lite": {
			divisor: 4,
			taps: [
				[
					1,
					0,
					2
				],
				[
					-1,
					1,
					1
				],
				[
					0,
					1,
					1
				]
			]
		}
	};
	var ALGORITHMS = [
		{
			id: "floyd-steinberg",
			name: "Floyd–Steinberg",
			group: "Error diffusion"
		},
		{
			id: "false-floyd-steinberg",
			name: "False Floyd–Steinberg",
			group: "Error diffusion"
		},
		{
			id: "atkinson",
			name: "Atkinson",
			group: "Error diffusion"
		},
		{
			id: "jarvis-judice-ninke",
			name: "Jarvis–Judice–Ninke",
			group: "Error diffusion"
		},
		{
			id: "stucki",
			name: "Stucki",
			group: "Error diffusion"
		},
		{
			id: "burkes",
			name: "Burkes",
			group: "Error diffusion"
		},
		{
			id: "sierra",
			name: "Sierra",
			group: "Error diffusion"
		},
		{
			id: "sierra-two-row",
			name: "Sierra two-row",
			group: "Error diffusion"
		},
		{
			id: "sierra-lite",
			name: "Sierra Lite",
			group: "Error diffusion"
		},
		{
			id: "bayer2",
			name: "Bayer 2×2",
			group: "Ordered"
		},
		{
			id: "bayer4",
			name: "Bayer 4×4",
			group: "Ordered"
		},
		{
			id: "bayer8",
			name: "Bayer 8×8",
			group: "Ordered"
		},
		{
			id: "bayer16",
			name: "Bayer 16×16",
			group: "Ordered"
		},
		{
			id: "blue-noise",
			name: "Blue noise",
			group: "Ordered"
		},
		{
			id: "white-noise",
			name: "White noise",
			group: "Ordered"
		},
		{
			id: "halftone-dot",
			name: "Halftone dots",
			group: "Halftone"
		},
		{
			id: "halftone-line",
			name: "Halftone lines",
			group: "Halftone"
		},
		{
			id: "halftone-square",
			name: "Halftone squares",
			group: "Halftone"
		},
		{
			id: "halftone-diamond",
			name: "Halftone diamonds",
			group: "Halftone"
		},
		{
			id: "threshold",
			name: "Threshold (no dither)",
			group: "Other"
		}
	];
	/**
	* Dithers a float RGB buffer in place to the matcher's palette.
	* Also returns the palette index of every pixel (for vector export).
	*/
	function dither(rgb, w, h, matcher, opt) {
		const kernel = DIFFUSION_KERNELS[opt.algorithm];
		return kernel ? diffuse(rgb, w, h, matcher, kernel, opt) : ordered(rgb, w, h, matcher, opt.algorithm, opt);
	}
	function diffuse(rgb, w, h, matcher, kernel, opt) {
		const out = new Uint8Array(w * h);
		const pal = matcher.colors;
		const taps = kernel.taps.map(([dx, dy, wt]) => [
			dx,
			dy,
			wt / kernel.divisor * opt.strength
		]);
		for (let y = 0; y < h; y++) {
			const rev = opt.serpentine && (y & 1) === 1;
			for (let i = 0; i < w; i++) {
				const x = rev ? w - 1 - i : i;
				const p = y * w + x;
				const o = p * 3;
				const r = rgb[o], g = rgb[o + 1], b = rgb[o + 2];
				const idx = matcher.nearest(r, g, b);
				out[p] = idx;
				const c = pal[idx];
				const er = r - c[0], eg = g - c[1], eb = b - c[2];
				rgb[o] = c[0];
				rgb[o + 1] = c[1];
				rgb[o + 2] = c[2];
				for (const [dx0, dy, f] of taps) {
					const nx = x + (rev ? -dx0 : dx0), ny = y + dy;
					if (nx < 0 || nx >= w || ny >= h) continue;
					const no = (ny * w + nx) * 3;
					rgb[no] += er * f;
					rgb[no + 1] += eg * f;
					rgb[no + 2] += eb * f;
				}
			}
		}
		return out;
	}
	function bayer(n) {
		let m = [[0]];
		for (let size = 1; size < n; size *= 2) {
			const next = [];
			for (let y = 0; y < size * 2; y++) {
				next.push([]);
				for (let x = 0; x < size * 2; x++) {
					const q = (y < size ? 0 : 2) + (x < size ? 0 : 1);
					const base = 4 * m[y % size][x % size];
					next[y].push(base + [
						0,
						2,
						3,
						1
					][q]);
				}
			}
			m = next;
		}
		const out = new Float32Array(n * n);
		for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) out[y * n + x] = (m[y][x] + .5) / (n * n);
		return out;
	}
	var bayerCache = /* @__PURE__ */ new Map();
	function bayerMap(n) {
		let m = bayerCache.get(n);
		if (!m) {
			m = bayer(n);
			bayerCache.set(n, m);
		}
		return m;
	}
	/** Threshold in [0, 1) for a pixel; GLSL ports mirror this function. */
	function thresholdFn(kind, opt) {
		switch (kind) {
			case "bayer2":
			case "bayer4":
			case "bayer8":
			case "bayer16": {
				const n = parseInt(kind.slice(5), 10);
				const m = bayerMap(n);
				return (x, y) => m[y % n * n + x % n];
			}
			case "blue-noise": {
				const m = blueNoise();
				const n = 64;
				return (x, y) => m[y % n * n + x % n];
			}
			case "white-noise": {
				const f = opt.frame;
				return (x, y) => {
					let s = x * 374761393 + y * 668265263 + f * 2246822519 >>> 0;
					s = Math.imul(s ^ s >>> 13, 1274126177) >>> 0;
					return ((s ^ s >>> 16) >>> 0) / 4294967296;
				};
			}
			case "threshold": return () => .5;
			default: {
				const cell = Math.max(2, opt.cellSize);
				const a = opt.angle * Math.PI / 180;
				const ca = Math.cos(a), sa = Math.sin(a);
				const spot = SPOTS[kind] ?? SPOTS["halftone-dot"];
				const cdf = spotCdf(kind, spot);
				return (x, y) => {
					const u = ((x + .5) * ca + (y + .5) * sa) / cell;
					const v = (-(x + .5) * sa + (y + .5) * ca) / cell;
					const s = spot(Math.abs(u - Math.floor(u) - .5), Math.abs(v - Math.floor(v) - .5));
					return cdf[Math.min(CDF_BINS - 1, Math.floor(s * CDF_BINS))];
				};
			}
		}
	}
	/**
	* Spot functions over a cell, with a and b the distances from the cell centre (0..0.5).
	* Lower values go dark first. They return 0..1 and are equalised by `spotCdf`.
	*/
	var SPOTS = {
		"halftone-dot": (a, b) => (a + b <= .5 ? (a * a + b * b) * 2 : 1 - ((.5 - a) ** 2 + (.5 - b) ** 2) * 2) * .999,
		"halftone-line": (_a, b) => b * 2 * .999,
		"halftone-square": (a, b) => Math.max(a, b) * 2 * .999,
		"halftone-diamond": (a, b) => (a + b) * .999
	};
	var CDF_BINS = 1024;
	var cdfCache = /* @__PURE__ */ new Map();
	/** Maps raw spot values to their rank so every grey level covers the right area. */
	function spotCdf(kind, spot) {
		let cdf = cdfCache.get(kind);
		if (cdf) return cdf;
		const hist = new Float64Array(CDF_BINS);
		const n = 256;
		for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
			const s = spot(Math.abs((i + .5) / n - .5), Math.abs((j + .5) / n - .5));
			hist[Math.min(1023, Math.floor(s * CDF_BINS))]++;
		}
		cdf = new Float32Array(CDF_BINS);
		let acc = 0;
		for (let k = 0; k < CDF_BINS; k++) {
			cdf[k] = (acc + hist[k] / 2) / (n * n);
			acc += hist[k];
		}
		cdfCache.set(kind, cdf);
		return cdf;
	}
	/** Spread to apply around each pixel; roughly the gap between neighbouring palette levels. */
	function autoSpread(matcher) {
		const ls = matcher.colors.map(([r, g, b]) => .2126 * r + .7152 * g + .0722 * b);
		return Math.max(32, Math.max(...ls) - Math.min(...ls)) / Math.max(1, Math.min(matcher.colors.length - 1, 4));
	}
	function ordered(rgb, w, h, matcher, kind, opt) {
		const out = new Uint8Array(w * h);
		const pal = matcher.colors;
		const t = thresholdFn(kind, opt);
		const spread = kind === "threshold" ? 0 : autoSpread(matcher) * opt.strength;
		for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
			const p = y * w + x;
			const o = p * 3;
			const d = (t(x, y) - .5) * spread;
			const idx = matcher.nearest(rgb[o] + d, rgb[o + 1] + d, rgb[o + 2] + d);
			out[p] = idx;
			const c = pal[idx];
			rgb[o] = c[0];
			rgb[o + 1] = c[1];
			rgb[o + 2] = c[2];
		}
		return out;
	}
	// \0@oxc-project+runtime@0.155.0/helpers/esm/typeof.js
	function _typeof(o) {
		"@babel/helpers - typeof";
		return _typeof = "function" == typeof Symbol && "symbol" == typeof Symbol.iterator ? function(o) {
			return typeof o;
		} : function(o) {
			return o && "function" == typeof Symbol && o.constructor === Symbol && o !== Symbol.prototype ? "symbol" : typeof o;
		}, _typeof(o);
	}
	// \0@oxc-project+runtime@0.155.0/helpers/esm/toPrimitive.js
	function toPrimitive(t, r) {
		if ("object" != _typeof(t) || !t) return t;
		var e = t[Symbol.toPrimitive];
		if (void 0 !== e) {
			var i = e.call(t, r || "default");
			if ("object" != _typeof(i)) return i;
			throw new TypeError("@@toPrimitive must return a primitive value.");
		}
		return ("string" === r ? String : Number)(t);
	}
	// \0@oxc-project+runtime@0.155.0/helpers/esm/toPropertyKey.js
	function toPropertyKey(t) {
		var i = toPrimitive(t, "string");
		return "symbol" == _typeof(i) ? i : i + "";
	}
	// \0@oxc-project+runtime@0.155.0/helpers/esm/defineProperty.js
	function _defineProperty(e, r, t) {
		return (r = toPropertyKey(r)) in e ? Object.defineProperty(e, r, {
			value: t,
			enumerable: !0,
			configurable: !0,
			writable: !0
		}) : e[r] = t, e;
	}
	// src/engine/color.ts
	/**
	* Finds the nearest palette entry for a color. Lookups are cached on a 6-bit
	* per channel grid, which is plenty for dithering since the error carries the rest.
	*/
	var PaletteMatcher = class {
		constructor(colors, mode) {
			_defineProperty(this, "colors", void 0);
			_defineProperty(this, "cache", void 0);
			_defineProperty(this, "mode", void 0);
			_defineProperty(this, "lumas", void 0);
			this.colors = colors.length ? colors : [[
				0,
				0,
				0
			], [
				255,
				255,
				255
			]];
			this.mode = mode;
			this.cache = new Int16Array(1 << 18).fill(-1);
			this.lumas = this.colors.map(([r, g, b]) => luma(r, g, b));
		}
		nearest(r, g, b) {
			const ri = clamp255(r) >> 2;
			const gi = clamp255(g) >> 2;
			const bi = clamp255(b) >> 2;
			const key = ri << 12 | gi << 6 | bi;
			const hit = this.cache[key];
			if (hit >= 0) return hit;
			const idx = this.search((ri << 2) + 2, (gi << 2) + 2, (bi << 2) + 2);
			this.cache[key] = idx;
			return idx;
		}
		search(r, g, b) {
			const cs = this.colors;
			let best = 0;
			let bestD = Infinity;
			if (this.mode === "luma") {
				const l = luma(r, g, b);
				for (let i = 0; i < cs.length; i++) {
					const d = Math.abs(this.lumas[i] - l);
					if (d < bestD) {
						bestD = d;
						best = i;
					}
				}
				return best;
			}
			for (let i = 0; i < cs.length; i++) {
				const c = cs[i];
				const dr = r - c[0];
				const dg = g - c[1];
				const db = b - c[2];
				let d;
				if (this.mode === "weighted") {
					const rm = (r + c[0]) / 2;
					d = (2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db;
				} else d = dr * dr + dg * dg + db * db;
				if (d < bestD) {
					bestD = d;
					best = i;
				}
			}
			return best;
		}
	};
	function luma(r, g, b) {
		return .2126 * r + .7152 * g + .0722 * b;
	}
	function clamp255(v) {
		return v < 0 ? 0 : v > 255 ? 255 : v | 0;
	}
	/** Median-cut palette extraction. */
	function extractPalette(data, count) {
		const pixels = [];
		const total = data.length / 4;
		const step = Math.max(1, Math.floor(total / 4e4));
		for (let i = 0; i < total; i += step) {
			const o = i * 4;
			if (data[o + 3] < 128) continue;
			pixels.push([
				data[o],
				data[o + 1],
				data[o + 2]
			]);
		}
		if (!pixels.length) return [[
			0,
			0,
			0
		], [
			255,
			255,
			255
		]];
		let boxes = [pixels];
		while (boxes.length < count) {
			let bi = -1;
			let bestRange = -1;
			let bestCh = 0;
			boxes.forEach((box, i) => {
				if (box.length < 2) return;
				for (let ch = 0; ch < 3; ch++) {
					let lo = 255, hi = 0;
					for (const p of box) {
						if (p[ch] < lo) lo = p[ch];
						if (p[ch] > hi) hi = p[ch];
					}
					if (hi - lo > bestRange) {
						bestRange = hi - lo;
						bi = i;
						bestCh = ch;
					}
				}
			});
			if (bi < 0 || bestRange <= 0) break;
			const box = boxes[bi].sort((a, b) => a[bestCh] - b[bestCh]);
			const mid = box.length >> 1;
			boxes = [
				...boxes.slice(0, bi),
				box.slice(0, mid),
				box.slice(mid),
				...boxes.slice(bi + 1)
			];
		}
		return boxes.map((box) => {
			const s = [
				0,
				0,
				0
			];
			for (const p of box) {
				s[0] += p[0];
				s[1] += p[1];
				s[2] += p[2];
			}
			return s.map((v) => Math.round(v / box.length));
		}).sort((a, b) => luma(...a) - luma(...b));
	}
	// src/engine/filters.ts
	function adjust(rgb, p) {
		const c = p.contrast / 100;
		const cf = c >= 0 ? 1 / Math.max(.01, 1 - c) : 1 + c;
		const bOff = p.brightness / 100 * 255;
		const invG = 1 / p.gamma;
		const lut = /* @__PURE__ */ new Float32Array(1024);
		for (let i = 0; i < lut.length; i++) {
			let v = i / 4;
			v = (v - 127.5) * cf + 127.5 + bOff;
			v = Math.min(255, Math.max(0, v));
			v = 255 * Math.pow(v / 255, invG);
			if (p.invert) v = 255 - v;
			lut[i] = v;
		}
		const sat = p.saturation;
		for (let i = 0; i < rgb.length; i += 3) {
			let r = rgb[i], g = rgb[i + 1], b = rgb[i + 2];
			if (sat !== 1) {
				const l = .2126 * r + .7152 * g + .0722 * b;
				r = l + (r - l) * sat;
				g = l + (g - l) * sat;
				b = l + (b - l) * sat;
			}
			rgb[i] = lut[idx(r)];
			rgb[i + 1] = lut[idx(g)];
			rgb[i + 2] = lut[idx(b)];
		}
	}
	function idx(v) {
		const i = Math.round(v * 4);
		return i < 0 ? 0 : i > 1023 ? 1023 : i;
	}
	function boxBlur(rgb, w, h, radius) {
		const r = Math.max(1, Math.round(radius));
		const tmp = new Float32Array(rgb.length);
		for (let pass = 0; pass < 3; pass++) {
			blurAxis(rgb, tmp, w, h, r, true);
			blurAxis(tmp, rgb, w, h, r, false);
		}
	}
	function blurAxis(src, dst, w, h, r, horiz) {
		const len = horiz ? w : h;
		const lines = horiz ? h : w;
		const stride = horiz ? 3 : w * 3;
		const norm = 1 / (2 * r + 1);
		for (let line = 0; line < lines; line++) {
			const base = horiz ? line * w * 3 : line * 3;
			for (let ch = 0; ch < 3; ch++) {
				let acc = 0;
				for (let k = -r; k <= r; k++) acc += src[base + Math.min(len - 1, Math.max(0, k)) * stride + ch];
				for (let i = 0; i < len; i++) {
					dst[base + i * stride + ch] = acc * norm;
					const out = Math.max(0, i - r);
					const inn = Math.min(len - 1, i + r + 1);
					acc += src[base + inn * stride + ch] - src[base + out * stride + ch];
				}
			}
		}
	}
	function unsharp(rgb, w, h, amount) {
		const blurred = rgb.slice();
		boxBlur(blurred, w, h, 1);
		for (let i = 0; i < rgb.length; i++) rgb[i] = rgb[i] + (rgb[i] - blurred[i]) * amount;
	}
	function posterize(rgb, levels) {
		const n = Math.max(2, Math.round(levels)) - 1;
		for (let i = 0; i < rgb.length; i++) {
			const v = Math.min(255, Math.max(0, rgb[i]));
			rgb[i] = Math.round(v / 255 * n) / n * 255;
		}
	}
	/** Film-style grain. Seeded so that still images stay stable between renders. */
	function grain(rgb, amount, mono, seed) {
		let s = seed * 2654435761 >>> 0 || 1;
		const rand = () => {
			s ^= s << 13;
			s >>>= 0;
			s ^= s >>> 17;
			s ^= s << 5;
			s >>>= 0;
			return s / 4294967296 - .5;
		};
		const a = amount * 255;
		for (let i = 0; i < rgb.length; i += 3) if (mono) {
			const n = rand() * a;
			rgb[i] += n;
			rgb[i + 1] += n;
			rgb[i + 2] += n;
		} else {
			rgb[i] += rand() * a;
			rgb[i + 1] += rand() * a;
			rgb[i + 2] += rand() * a;
		}
	}
	/** Sobel edge magnitude, mixed back over the image. */
	function edges(rgb, w, h, strength, mix, invert) {
		const l = new Float32Array(w * h);
		for (let i = 0; i < w * h; i++) l[i] = .2126 * rgb[i * 3] + .7152 * rgb[i * 3 + 1] + .0722 * rgb[i * 3 + 2];
		for (let y = 0; y < h; y++) {
			const up = Math.max(0, y - 1) * w;
			const mid = y * w;
			const dn = Math.min(h - 1, y + 1) * w;
			for (let x = 0; x < w; x++) {
				const xl = Math.max(0, x - 1);
				const xr = Math.min(w - 1, x + 1);
				const gx = -l[up + xl] - 2 * l[mid + xl] - l[dn + xl] + l[up + xr] + 2 * l[mid + xr] + l[dn + xr];
				const gy = -l[up + xl] - 2 * l[up + x] - l[up + xr] + l[dn + xl] + 2 * l[dn + x] + l[dn + xr];
				let e = Math.min(255, Math.sqrt(gx * gx + gy * gy) * strength);
				if (invert) e = 255 - e;
				const o = (mid + x) * 3;
				for (let c = 0; c < 3; c++) rgb[o + c] = rgb[o + c] * (1 - mix) + e * mix;
			}
		}
	}
	/** Maps luminance onto a gradient through the given colors (duotone, tritone...). */
	function gradientMap(rgb, stops, mix) {
		if (stops.length < 2) return;
		const lut = /* @__PURE__ */ new Float32Array(768);
		for (let i = 0; i < 256; i++) {
			const t = i / 255 * (stops.length - 1);
			const k = Math.min(stops.length - 2, Math.floor(t));
			const f = t - k;
			for (let c = 0; c < 3; c++) lut[i * 3 + c] = stops[k][c] * (1 - f) + stops[k + 1][c] * f;
		}
		for (let i = 0; i < rgb.length; i += 3) {
			const l = .2126 * rgb[i] + .7152 * rgb[i + 1] + .0722 * rgb[i + 2];
			const li = Math.min(255, Math.max(0, Math.round(l))) * 3;
			for (let c = 0; c < 3; c++) rgb[i + c] = rgb[i + c] * (1 - mix) + lut[li + c] * mix;
		}
	}
	// src/engine/palettes.ts
	var PRESETS = [
		{
			id: "bw",
			name: "1-bit black & white",
			colors: ["#000000", "#ffffff"]
		},
		{
			id: "mac",
			name: "Mac Classic",
			colors: ["#2b2b26", "#e3dfd2"]
		},
		{
			id: "gray4",
			name: "Grayscale 4",
			colors: [
				"#000000",
				"#555555",
				"#aaaaaa",
				"#ffffff"
			]
		},
		{
			id: "gray8",
			name: "Grayscale 8",
			colors: [
				"#000000",
				"#242424",
				"#494949",
				"#6d6d6d",
				"#929292",
				"#b6b6b6",
				"#dbdbdb",
				"#ffffff"
			]
		},
		{
			id: "gb",
			name: "Game Boy",
			colors: [
				"#0f380f",
				"#306230",
				"#8bac0f",
				"#9bbc0f"
			]
		},
		{
			id: "gbp",
			name: "Game Boy Pocket",
			colors: [
				"#000000",
				"#545454",
				"#a9a9a9",
				"#ffffff"
			]
		},
		{
			id: "cga1",
			name: "CGA mode 4 (high)",
			colors: [
				"#000000",
				"#55ffff",
				"#ff55ff",
				"#ffffff"
			]
		},
		{
			id: "cga0",
			name: "CGA mode 4 (low)",
			colors: [
				"#000000",
				"#00aa00",
				"#aa0000",
				"#aa5500"
			]
		},
		{
			id: "ega",
			name: "EGA 16",
			colors: [
				"#000000",
				"#0000aa",
				"#00aa00",
				"#00aaaa",
				"#aa0000",
				"#aa00aa",
				"#aa5500",
				"#aaaaaa",
				"#555555",
				"#5555ff",
				"#55ff55",
				"#55ffff",
				"#ff5555",
				"#ff55ff",
				"#ffff55",
				"#ffffff"
			]
		},
		{
			id: "pico8",
			name: "PICO-8",
			colors: [
				"#000000",
				"#1d2b53",
				"#7e2553",
				"#008751",
				"#ab5236",
				"#5f574f",
				"#c2c3c7",
				"#fff1e8",
				"#ff004d",
				"#ffa300",
				"#ffec27",
				"#00e436",
				"#29adff",
				"#83769c",
				"#ff77a8",
				"#ffccaa"
			]
		},
		{
			id: "c64",
			name: "Commodore 64",
			colors: [
				"#000000",
				"#ffffff",
				"#880000",
				"#aaffee",
				"#cc44cc",
				"#00cc55",
				"#0000aa",
				"#eeee77",
				"#dd8855",
				"#664400",
				"#ff7777",
				"#333333",
				"#777777",
				"#aaff66",
				"#0088ff",
				"#bbbbbb"
			]
		},
		{
			id: "zx",
			name: "ZX Spectrum",
			colors: [
				"#000000",
				"#0000d8",
				"#d80000",
				"#d800d8",
				"#00d800",
				"#00d8d8",
				"#d8d800",
				"#d8d8d8",
				"#0000ff",
				"#ff0000",
				"#ff00ff",
				"#00ff00",
				"#00ffff",
				"#ffff00",
				"#ffffff"
			]
		},
		{
			id: "eink4",
			name: "E-ink 4 gray",
			colors: [
				"#1a1a1a",
				"#6b6b6b",
				"#b0b0b0",
				"#ececec"
			]
		},
		{
			id: "spectra6",
			name: "E-ink Spectra 6",
			colors: [
				"#191e21",
				"#e8e8e8",
				"#b21e1e",
				"#e6c619",
				"#2950a8",
				"#3f7d3a"
			]
		},
		{
			id: "cmyk",
			name: "CMYK + white",
			colors: [
				"#00a0e3",
				"#e6007e",
				"#ffed00",
				"#1d1d1b",
				"#ffffff"
			]
		},
		{
			id: "risograph",
			name: "Riso pink & blue",
			colors: [
				"#f4efe6",
				"#ff48b0",
				"#0078bf",
				"#3d2a5c"
			]
		},
		{
			id: "sepia",
			name: "Sepia",
			colors: [
				"#2b1d0e",
				"#6b4a2b",
				"#a98157",
				"#e8d4b0"
			]
		}
	];
	function hexToRgb(hex) {
		let h = hex.trim().replace(/^#/, "");
		if (h.length === 3) h = h.split("").map((c) => c + c).join("");
		const n = parseInt(h, 16);
		return [
			n >> 16 & 255,
			n >> 8 & 255,
			n & 255
		];
	}
	// src/engine/steps.ts
	var num = (v) => v;
	var bool = (v) => v;
	var str = (v) => v;
	var list = (v) => v;
	var extractCache = /* @__PURE__ */ new Map();
	/** Resolves a palette source ("preset", "custom" or "extract") to hex colors. */
	function resolvePalette(p, source) {
		const kind = str(p.palette);
		if (kind === "custom") return list(p.colors);
		if (kind === "extract") {
			if (!source) return list(p.colors);
			const count = num(p.extractCount);
			let fp = `${count}:${source.length}`;
			for (let i = 0; i < source.length; i += Math.max(4, source.length / 64 & -4)) fp += "," + source[i];
			let hit = extractCache.get(fp);
			if (!hit) {
				hit = extractPalette(source, count).map(([r, g, b]) => "#" + [
					r,
					g,
					b
				].map((v) => v.toString(16).padStart(2, "0")).join(""));
				if (extractCache.size > 32) extractCache.clear();
				extractCache.set(fp, hit);
			}
			return hit;
		}
		return PRESETS.find((x) => x.id === kind)?.colors ?? PRESETS[0].colors;
	}
	var paletteOptions = [
		...PRESETS.map((p) => ({
			value: p.id,
			label: p.name,
			group: "Presets"
		})),
		{
			value: "custom",
			label: "Custom",
			group: "Other"
		},
		{
			value: "extract",
			label: "From image",
			group: "Other"
		}
	];
	var STEP_DEFS = [
		{
			type: "adjust",
			label: "Adjust",
			description: "Brightness, contrast, gamma and saturation.",
			params: [
				{
					key: "brightness",
					label: "Brightness",
					kind: "range",
					min: -100,
					max: 100,
					step: 1,
					default: 0
				},
				{
					key: "contrast",
					label: "Contrast",
					kind: "range",
					min: -100,
					max: 100,
					step: 1,
					default: 0
				},
				{
					key: "gamma",
					label: "Gamma",
					kind: "range",
					min: .2,
					max: 3,
					step: .01,
					default: 1
				},
				{
					key: "saturation",
					label: "Saturation",
					kind: "range",
					min: 0,
					max: 2,
					step: .01,
					default: 1
				},
				{
					key: "invert",
					label: "Invert",
					kind: "toggle",
					default: false
				}
			],
			run: (rgb, _ctx, p) => adjust(rgb, {
				brightness: num(p.brightness),
				contrast: num(p.contrast),
				gamma: num(p.gamma),
				saturation: num(p.saturation),
				invert: bool(p.invert)
			})
		},
		{
			type: "blur",
			label: "Blur",
			description: "Soften detail before dithering.",
			params: [{
				key: "radius",
				label: "Radius",
				kind: "range",
				min: 0,
				max: 12,
				step: 1,
				default: 1
			}],
			run: (rgb, ctx, p) => {
				if (num(p.radius) > 0) boxBlur(rgb, ctx.w, ctx.h, num(p.radius));
			}
		},
		{
			type: "sharpen",
			label: "Sharpen",
			description: "Unsharp mask to crisp up edges.",
			params: [{
				key: "amount",
				label: "Amount",
				kind: "range",
				min: 0,
				max: 3,
				step: .05,
				default: .8
			}],
			run: (rgb, ctx, p) => unsharp(rgb, ctx.w, ctx.h, num(p.amount))
		},
		{
			type: "posterize",
			label: "Posterize",
			description: "Reduce each channel to a few levels.",
			params: [{
				key: "levels",
				label: "Levels",
				kind: "range",
				min: 2,
				max: 16,
				step: 1,
				default: 4
			}],
			run: (rgb, _ctx, p) => posterize(rgb, num(p.levels))
		},
		{
			type: "grain",
			label: "Grain",
			description: "Add noise; animates on video.",
			params: [
				{
					key: "amount",
					label: "Amount",
					kind: "range",
					min: 0,
					max: 1,
					step: .01,
					default: .15
				},
				{
					key: "mono",
					label: "Monochrome",
					kind: "toggle",
					default: true
				},
				{
					key: "animate",
					label: "Animate",
					kind: "toggle",
					default: true
				}
			],
			run: (rgb, ctx, p) => grain(rgb, num(p.amount), bool(p.mono), bool(p.animate) ? ctx.frame + 1 : 1)
		},
		{
			type: "edges",
			label: "Edges",
			description: "Sobel outlines mixed over the image.",
			params: [
				{
					key: "strength",
					label: "Strength",
					kind: "range",
					min: .1,
					max: 4,
					step: .05,
					default: 1
				},
				{
					key: "mix",
					label: "Mix",
					kind: "range",
					min: 0,
					max: 1,
					step: .01,
					default: 1
				},
				{
					key: "invert",
					label: "Dark lines",
					kind: "toggle",
					default: true
				}
			],
			run: (rgb, ctx, p) => edges(rgb, ctx.w, ctx.h, num(p.strength), num(p.mix), bool(p.invert))
		},
		{
			type: "gradient",
			label: "Gradient map",
			description: "Map brightness onto a color ramp.",
			params: [{
				key: "colors",
				label: "Ramp",
				kind: "colors",
				default: [
					"#1b1035",
					"#e2466d",
					"#ffe9a8"
				]
			}, {
				key: "mix",
				label: "Mix",
				kind: "range",
				min: 0,
				max: 1,
				step: .01,
				default: 1
			}],
			run: (rgb, _ctx, p) => gradientMap(rgb, list(p.colors).map(hexToRgb), num(p.mix))
		},
		{
			type: "dither",
			label: "Dither",
			description: "Reduce to a palette with a dithering algorithm.",
			params: [
				{
					key: "algorithm",
					label: "Algorithm",
					kind: "select",
					options: ALGORITHMS.map((a) => ({
						value: a.id,
						label: a.name,
						group: a.group
					})),
					default: "floyd-steinberg"
				},
				{
					key: "strength",
					label: "Strength",
					kind: "range",
					min: 0,
					max: 1.5,
					step: .01,
					default: 1
				},
				{
					key: "serpentine",
					label: "Serpentine scan",
					kind: "toggle",
					default: true
				},
				{
					key: "cellSize",
					label: "Cell size",
					kind: "range",
					min: 2,
					max: 32,
					step: 1,
					default: 6
				},
				{
					key: "angle",
					label: "Angle",
					kind: "range",
					min: 0,
					max: 90,
					step: 1,
					default: 45
				},
				{
					key: "palette",
					label: "Palette",
					kind: "select",
					options: paletteOptions,
					default: "bw"
				},
				{
					key: "extractCount",
					label: "Colors",
					kind: "range",
					min: 2,
					max: 32,
					step: 1,
					default: 8
				},
				{
					key: "colors",
					label: "Custom colors",
					kind: "colors",
					default: ["#000000", "#ffffff"]
				},
				{
					key: "distance",
					label: "Color match",
					kind: "select",
					options: [
						{
							value: "weighted",
							label: "Perceptual"
						},
						{
							value: "rgb",
							label: "RGB"
						},
						{
							value: "luma",
							label: "Brightness only"
						}
					],
					default: "weighted"
				}
			],
			visible: (key, p) => {
				const alg = str(p.algorithm);
				const isDiffusion = !ALGORITHMS.find((a) => a.id === alg && a.group !== "Error diffusion");
				if (key === "serpentine") return isDiffusion;
				if (key === "cellSize" || key === "angle") return alg.startsWith("halftone");
				if (key === "strength") return alg !== "threshold";
				if (key === "extractCount") return p.palette === "extract";
				if (key === "colors") return p.palette === "custom";
				return true;
			},
			run: (rgb, ctx, p) => {
				const palette = resolvePalette(p, ctx.source);
				const matcher = matcherFor(palette, str(p.distance));
				ctx.indices = dither(rgb, ctx.w, ctx.h, matcher, {
					algorithm: str(p.algorithm),
					strength: num(p.strength),
					serpentine: bool(p.serpentine),
					cellSize: num(p.cellSize),
					angle: num(p.angle),
					frame: ctx.frame
				});
				ctx.palette = palette;
			}
		}
	];
	var matcherCache = /* @__PURE__ */ new Map();
	function matcherFor(palette, mode) {
		const key = mode + ":" + palette.join(",");
		let m = matcherCache.get(key);
		if (!m) {
			if (matcherCache.size > 16) matcherCache.clear();
			m = new PaletteMatcher(palette.map(hexToRgb), mode);
			matcherCache.set(key, m);
		}
		return m;
	}
	function stepDef(type) {
		return STEP_DEFS.find((d) => d.type === type);
	}
	function defaultParams(type) {
		const def = stepDef(type);
		const out = {};
		for (const p of def?.params ?? []) out[p.key] = Array.isArray(p.default) ? [...p.default] : p.default;
		return out;
	}
	// src/engine/recipe.ts
	var nextId = 1;
	function newStep(type, params) {
		return {
			id: `s${Date.now().toString(36)}${(nextId++).toString(36)}`,
			type,
			enabled: true,
			params: {
				...defaultParams(type),
				...params
			}
		};
	}
	var now = () => typeof performance !== "undefined" ? performance.now() : Date.now();
	/** Runs every enabled step over an RGBA image already scaled to working size. */
	function render(src, w, h, recipe, frame = 0) {
		const t0 = now();
		const n = w * h;
		const rgb = new Float32Array(n * 3);
		for (let i = 0; i < n; i++) {
			rgb[i * 3] = src[i * 4];
			rgb[i * 3 + 1] = src[i * 4 + 1];
			rgb[i * 3 + 2] = src[i * 4 + 2];
		}
		const ctx = {
			w,
			h,
			frame,
			source: src
		};
		for (const step of recipe.steps) {
			if (!step.enabled) continue;
			const def = stepDef(step.type);
			if (!def) continue;
			def.run(rgb, ctx, {
				...defaultParams(step.type),
				...step.params
			});
			if (step.type !== "dither") ctx.indices = void 0;
		}
		const rgba = new Uint8ClampedArray(n * 4);
		for (let i = 0; i < n; i++) {
			rgba[i * 4] = rgb[i * 3];
			rgba[i * 4 + 1] = rgb[i * 3 + 1];
			rgba[i * 4 + 2] = rgb[i * 3 + 2];
			rgba[i * 4 + 3] = src[i * 4 + 3] >= 128 ? 255 : 0;
		}
		return {
			rgba,
			indices: ctx.indices,
			palette: ctx.indices ? ctx.palette : void 0,
			ms: now() - t0
		};
	}
	/** Validates and normalises an imported recipe, dropping unknown steps. */
	function parseRecipe(json) {
		const r = json;
		if (!r || typeof r !== "object" || !Array.isArray(r.steps)) throw new Error("Not a dither recipe");
		return {
			version: 1,
			name: typeof r.name === "string" ? r.name : "Imported",
			pixelSize: Math.max(1, Math.min(32, Number(r.pixelSize) || 1)),
			steps: r.steps.filter((s) => s && typeof s.type === "string" && stepDef(s.type)).map((s) => ({
				...newStep(s.type, s.params),
				enabled: s.enabled !== false
			}))
		};
	}
	// src/recipes.ts
	/** Starter recipes shown in the recipe menu. */
	function builtInRecipes() {
		return [
			{
				version: 1,
				name: "Classic Mac",
				pixelSize: 2,
				steps: [newStep("adjust", { contrast: 15 }), newStep("dither", {
					algorithm: "atkinson",
					palette: "mac"
				})]
			},
			{
				version: 1,
				name: "Game Boy",
				pixelSize: 3,
				steps: [newStep("adjust", {
					contrast: 20,
					saturation: 0
				}), newStep("dither", {
					algorithm: "bayer4",
					palette: "gb",
					distance: "luma",
					strength: .9
				})]
			},
			{
				version: 1,
				name: "Newsprint",
				pixelSize: 1,
				steps: [
					newStep("adjust", {
						contrast: 10,
						saturation: 0
					}),
					newStep("blur", { radius: 1 }),
					newStep("dither", {
						algorithm: "halftone-dot",
						palette: "bw",
						cellSize: 7,
						angle: 45
					})
				]
			},
			{
				version: 1,
				name: "Riso duotone",
				pixelSize: 2,
				steps: [
					newStep("adjust", { contrast: 10 }),
					newStep("gradient", { colors: [
						"#3d2a5c",
						"#0078bf",
						"#ff48b0",
						"#f4efe6"
					] }),
					newStep("grain", { amount: .08 }),
					newStep("dither", {
						algorithm: "blue-noise",
						palette: "risograph"
					})
				]
			},
			{
				version: 1,
				name: "PICO-8 VHS",
				pixelSize: 4,
				steps: [
					newStep("adjust", {
						saturation: 1.3,
						contrast: 10
					}),
					newStep("grain", {
						amount: .12,
						mono: false
					}),
					newStep("dither", {
						algorithm: "bayer8",
						palette: "pico8",
						strength: .7
					})
				]
			},
			{
				version: 1,
				name: "Ink sketch",
				pixelSize: 1,
				steps: [
					newStep("blur", { radius: 1 }),
					newStep("edges", {
						strength: 1.6,
						mix: .75
					}),
					newStep("dither", {
						algorithm: "jarvis-judice-ninke",
						palette: "bw",
						strength: .8
					})
				]
			},
			{
				version: 1,
				name: "E-ink Spectra",
				pixelSize: 2,
				steps: [newStep("adjust", { saturation: 1.4 }), newStep("dither", {
					algorithm: "floyd-steinberg",
					palette: "spectra6"
				})]
			},
			{
				version: 1,
				name: "Poster lines",
				pixelSize: 1,
				steps: [
					newStep("adjust", { contrast: 25 }),
					newStep("posterize", { levels: 4 }),
					newStep("dither", {
						algorithm: "halftone-line",
						palette: "cmyk",
						cellSize: 5,
						angle: 30
					})
				]
			}
		];
	}
	// plugins/photoshop/src/process.ts
	/**
	* Runs a recipe over interleaved 8-bit pixels as Photoshop hands them out
	* (3 components, or 4 when the layer has transparency). Returns a buffer in
	* the same layout, at full size. Original alpha is kept as is.
	*/
	function processPixels(data, components, width, height, recipe) {
		const ps = Math.max(1, Math.round(recipe.pixelSize));
		const w = Math.max(1, Math.floor(width / ps));
		const h = Math.max(1, Math.floor(height / ps));
		const small = new Uint8ClampedArray(w * h * 4);
		for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
			let r = 0, g = 0, b = 0, a = 0, n = 0;
			const y1 = y === h - 1 ? height : (y + 1) * ps;
			const x1 = x === w - 1 ? width : (x + 1) * ps;
			for (let yy = y * ps; yy < y1; yy++) for (let xx = x * ps; xx < x1; xx++) {
				const o = (yy * width + xx) * components;
				r += data[o];
				g += data[o + 1];
				b += data[o + 2];
				a += components === 4 ? data[o + 3] : 255;
				n++;
			}
			const o = (y * w + x) * 4;
			small[o] = r / n;
			small[o + 1] = g / n;
			small[o + 2] = b / n;
			small[o + 3] = a / n;
		}
		for (let i = 3; i < small.length; i += 4) small[i] = 255;
		const { rgba } = render(small, w, h, recipe);
		const out = new Uint8Array(width * height * components);
		for (let yy = 0; yy < height; yy++) {
			const y = Math.min(h - 1, Math.floor(yy / ps));
			for (let xx = 0; xx < width; xx++) {
				const x = Math.min(w - 1, Math.floor(xx / ps));
				const s = (y * w + x) * 4;
				const o = (yy * width + xx) * components;
				out[o] = rgba[s];
				out[o + 1] = rgba[s + 1];
				out[o + 2] = rgba[s + 2];
				if (components === 4) out[o + 3] = data[o + 3];
			}
		}
		return out;
	}
	/** Decodes a share link (…#r=xxxx), a bare encoded recipe, or recipe JSON text. */
	function recipeTextToJson(text) {
		const t = text.trim();
		if (t.startsWith("{")) return JSON.parse(t);
		const m = t.match(/[#&?]r=([A-Za-z0-9_-]+)/);
		const encoded = m ? m[1] : t;
		if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error("That doesn't look like a Dither Lab link or recipe");
		return JSON.parse(utf8(base64url(encoded)));
	}
	function base64url(s) {
		const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
		const out = [];
		let buf = 0, bits = 0;
		for (const ch of s) {
			const v = alphabet.indexOf(ch);
			if (v < 0) continue;
			buf = buf << 6 | v;
			bits += 6;
			if (bits >= 8) {
				bits -= 8;
				out.push(buf >> bits & 255);
			}
		}
		return Uint8Array.from(out);
	}
	function utf8(bytes) {
		let s = "";
		for (let i = 0; i < bytes.length;) {
			const b = bytes[i++];
			let cp;
			if (b < 128) cp = b;
			else if (b < 224) cp = (b & 31) << 6 | bytes[i++] & 63;
			else if (b < 240) cp = (b & 15) << 12 | (bytes[i++] & 63) << 6 | bytes[i++] & 63;
			else cp = (b & 7) << 18 | (bytes[i++] & 63) << 12 | (bytes[i++] & 63) << 6 | bytes[i++] & 63;
			s += String.fromCodePoint(cp);
		}
		return s;
	}
	// plugins/photoshop/src/panel.ts
	var { app, core, imaging } = require("photoshop");
	var STORE = "dither-lab:imported";
	var $ = (id) => document.getElementById(id);
	var recipeSelect = $("recipe");
	var pixel = $("pixel");
	var pixelOut = $("pixel-out");
	var steps = $("steps");
	var status = $("status");
	var clone = (v) => JSON.parse(JSON.stringify(v));
	function imported() {
		try {
			return JSON.parse(localStorage.getItem(STORE) ?? "[]").map(parseRecipe);
		} catch {
			return [];
		}
	}
	function allRecipes() {
		return [...builtInRecipes().map((recipe, i) => ({
			key: `b${i}`,
			recipe
		})), ...imported().map((recipe, i) => ({
			key: `i${i}`,
			recipe
		}))];
	}
	var current = builtInRecipes()[0];
	function buildMenu(selectKey) {
		recipeSelect.innerHTML = "";
		for (const { key, recipe } of allRecipes()) {
			const o = document.createElement("option");
			o.value = key;
			o.textContent = key.startsWith("i") ? `${recipe.name} (imported)` : recipe.name;
			recipeSelect.appendChild(o);
		}
		recipeSelect.value = selectKey ?? "b0";
		select(recipeSelect.value);
	}
	function select(key) {
		const hit = allRecipes().find((r) => r.key === key);
		if (!hit) return;
		current = clone(hit.recipe);
		pixel.value = String(current.pixelSize);
		pixelOut.textContent = `${current.pixelSize}px`;
		steps.innerHTML = "";
		for (const s of current.steps) {
			const li = document.createElement("li");
			li.textContent = stepDef(s.type)?.label ?? s.type;
			if (s.type === "dither") li.textContent += ` · ${s.params.algorithm} · ${s.params.palette}`;
			if (!s.enabled) li.className = "off";
			steps.appendChild(li);
		}
	}
	function say(msg, error = false) {
		status.textContent = msg;
		status.className = error ? "error" : "";
	}
	recipeSelect.addEventListener("change", () => select(recipeSelect.value));
	pixel.addEventListener("input", () => {
		current.pixelSize = Number(pixel.value);
		pixelOut.textContent = `${current.pixelSize}px`;
	});
	$("import-btn").addEventListener("click", () => {
		const box = $("import");
		try {
			const recipe = parseRecipe(recipeTextToJson(box.value));
			const list = imported().filter((r) => r.name !== recipe.name);
			list.push(recipe);
			localStorage.setItem(STORE, JSON.stringify(list));
			box.value = "";
			buildMenu(`i${list.length - 1}`);
			say(`Imported “${recipe.name}”`);
		} catch (err) {
			say(String(err.message ?? err), true);
		}
	});
	$("delete-btn").addEventListener("click", () => {
		const key = recipeSelect.value;
		if (!key.startsWith("i")) return say("Starter recipes can't be removed", true);
		const list = imported();
		list.splice(Number(key.slice(1)), 1);
		localStorage.setItem(STORE, JSON.stringify(list));
		buildMenu();
	});
	$("apply").addEventListener("click", async () => {
		const doc = app.activeDocument;
		if (!doc) return say("Open a document first", true);
		const layer = doc.activeLayers?.[0];
		if (!layer) return say("Select a pixel layer", true);
		const recipe = clone(current);
		const asNewLayer = $("new-layer").checked;
		say("Dithering…");
		const t0 = Date.now();
		try {
			await core.executeAsModal(async () => {
				const target = asNewLayer ? await layer.duplicate() : layer;
				if (asNewLayer) target.name = `${layer.name} · ${recipe.name}`;
				const px = await imaging.getPixels({
					documentID: doc.id,
					layerID: target.id,
					componentSize: 8,
					colorSpace: "RGB"
				});
				const { width, height, components } = px.imageData;
				const out = processPixels(await px.imageData.getData(), components, width, height, recipe);
				px.imageData.dispose();
				const imageData = await imaging.createImageDataFromBuffer(out, {
					width,
					height,
					components,
					chunky: true,
					colorSpace: "RGB"
				});
				await imaging.putPixels({
					documentID: doc.id,
					layerID: target.id,
					imageData,
					replace: true,
					targetBounds: {
						left: px.sourceBounds.left,
						top: px.sourceBounds.top
					}
				});
				imageData.dispose();
			}, { commandName: `Dither Lab: ${recipe.name}` });
			say(`Done in ${((Date.now() - t0) / 1e3).toFixed(1)} s`);
		} catch (err) {
			say(`Failed: ${err.message ?? err}`, true);
		}
	});
	buildMenu();
})();
