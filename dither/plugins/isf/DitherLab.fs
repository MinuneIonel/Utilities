/*{
  "DESCRIPTION": "Dither Lab: ordered, halftone and threshold dithering to a palette of up to 8 colors.",
  "CREDIT": "Dither Lab",
  "ISFVSN": "2",
  "CATEGORIES": ["Stylize", "Retro"],
  "INPUTS": [
    { "NAME": "inputImage", "TYPE": "image" },
    { "NAME": "algorithm", "LABEL": "Algorithm", "TYPE": "long", "DEFAULT": 2,
      "VALUES": [0, 1, 2, 3, 4, 5, 6, 7],
      "LABELS": ["Bayer 2x2", "Bayer 4x4", "Bayer 8x8", "Bayer 16x16", "Halftone dots", "Halftone lines", "White noise", "Threshold"] },
    { "NAME": "pixelSize", "LABEL": "Pixel size", "TYPE": "float", "DEFAULT": 3.0, "MIN": 1.0, "MAX": 32.0 },
    { "NAME": "strength", "LABEL": "Strength", "TYPE": "float", "DEFAULT": 1.0, "MIN": 0.0, "MAX": 1.5 },
    { "NAME": "cellSize", "LABEL": "Halftone cell", "TYPE": "float", "DEFAULT": 6.0, "MIN": 2.0, "MAX": 32.0 },
    { "NAME": "angle", "LABEL": "Halftone angle", "TYPE": "float", "DEFAULT": 45.0, "MIN": 0.0, "MAX": 90.0 },
    { "NAME": "brightness", "LABEL": "Brightness", "TYPE": "float", "DEFAULT": 0.0, "MIN": -1.0, "MAX": 1.0 },
    { "NAME": "contrast", "LABEL": "Contrast", "TYPE": "float", "DEFAULT": 0.0, "MIN": -1.0, "MAX": 0.95 },
    { "NAME": "colorCount", "LABEL": "Colors", "TYPE": "long", "DEFAULT": 4,
      "VALUES": [2, 3, 4, 5, 6, 7, 8], "LABELS": ["2", "3", "4", "5", "6", "7", "8"] },
    { "NAME": "color1", "TYPE": "color", "DEFAULT": [0.059, 0.220, 0.059, 1.0] },
    { "NAME": "color2", "TYPE": "color", "DEFAULT": [0.188, 0.384, 0.188, 1.0] },
    { "NAME": "color3", "TYPE": "color", "DEFAULT": [0.545, 0.675, 0.059, 1.0] },
    { "NAME": "color4", "TYPE": "color", "DEFAULT": [0.608, 0.737, 0.059, 1.0] },
    { "NAME": "color5", "TYPE": "color", "DEFAULT": [1.0, 1.0, 1.0, 1.0] },
    { "NAME": "color6", "TYPE": "color", "DEFAULT": [1.0, 0.0, 0.0, 1.0] },
    { "NAME": "color7", "TYPE": "color", "DEFAULT": [0.0, 1.0, 0.0, 1.0] },
    { "NAME": "color8", "TYPE": "color", "DEFAULT": [0.0, 0.0, 1.0, 1.0] }
  ]
}*/

// Mirrors src/engine/dither.ts (ordered/halftone branch). Error diffusion is
// serial and has no shader equivalent.

float bit(float v, float i) { return mod(floor(v / exp2(i)), 2.0); }

// Recursive Bayer matrix via bit interleaving, normalised to [0, 1).
float bayer(vec2 p, float levels) {
  float v = 0.0;
  for (int i = 0; i < 4; i++) {
    if (float(i) >= levels) break;
    float xb = bit(p.x, float(i));
    float yb = bit(p.y, float(i));
    v = v * 4.0 + 2.0 * abs(xb - yb) + yb;
  }
  float n = exp2(levels * 2.0);
  return (v + 0.5) / n;
}

float halftone(vec2 p, float kind) {
  float a = radians(angle);
  vec2 q = mat2(cos(a), -sin(a), sin(a), cos(a)) * (p + 0.5) / cellSize;
  vec2 f = abs(fract(q) - 0.5);
  if (kind > 0.5) return f.y * 2.0 * 0.999;
  // Euclidean dot: dots in highlights, holes in shadows.
  float s = (f.x + f.y <= 0.5) ? dot(f, f) * 2.0 : 1.0 - dot(0.5 - f, 0.5 - f) * 2.0;
  return s * 0.999;
}

float hash(vec2 p) {
  return fract(sin(dot(p + fract(TIME) * 17.0, vec2(12.9898, 78.233))) * 43758.5453);
}

vec3 paletteColor(int i) {
  if (i == 0) return color1.rgb;
  if (i == 1) return color2.rgb;
  if (i == 2) return color3.rgb;
  if (i == 3) return color4.rgb;
  if (i == 4) return color5.rgb;
  if (i == 5) return color6.rgb;
  if (i == 6) return color7.rgb;
  return color8.rgb;
}

void main() {
  vec2 cell = floor(gl_FragCoord.xy / pixelSize);
  vec2 uv = (cell + 0.5) * pixelSize / RENDERSIZE;
  vec3 c = IMG_NORM_PIXEL(inputImage, uv).rgb;

  float cf = contrast >= 0.0 ? 1.0 / (1.0 - contrast) : 1.0 + contrast;
  c = clamp((c - 0.5) * cf + 0.5 + brightness, 0.0, 1.0);

  // Threshold map. The cell grid is flipped so it matches the app's top-left origin.
  vec2 p = vec2(cell.x, floor(RENDERSIZE.y / pixelSize) - 1.0 - cell.y);
  float t = 0.5;
  if (algorithm < 4) t = bayer(p, float(algorithm + 1));
  else if (algorithm == 4) t = halftone(p, 0.0);
  else if (algorithm == 5) t = halftone(p, 1.0);
  else if (algorithm == 6) t = hash(p);

  // Spread is roughly the gap between palette brightness levels.
  float lo = 1.0, hi = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= colorCount) break;
    float l = dot(paletteColor(i), vec3(0.2126, 0.7152, 0.0722));
    lo = min(lo, l);
    hi = max(hi, l);
  }
  float spread = algorithm == 7 ? 0.0 : strength * max(0.125, hi - lo) / min(float(colorCount - 1), 4.0);
  c += (t - 0.5) * spread;

  vec3 best = color1.rgb;
  float bestD = 1e9;
  for (int i = 0; i < 8; i++) {
    if (i >= colorCount) break;
    vec3 pc = paletteColor(i);
    vec3 d = c - pc;
    float rm = (c.r + pc.r) * 0.5;
    float dist = (2.0 + rm) * d.r * d.r + 4.0 * d.g * d.g + (3.0 - rm) * d.b * d.b;
    if (dist < bestD) { bestD = dist; best = pc; }
  }
  gl_FragColor = vec4(best, 1.0);
}
