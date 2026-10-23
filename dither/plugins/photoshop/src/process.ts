import { render, type Recipe } from "../../../src/engine/recipe";

/**
 * Runs a recipe over interleaved 8-bit pixels as Photoshop hands them out
 * (3 components, or 4 when the layer has transparency). Returns a buffer in
 * the same layout, at full size. Original alpha is kept as is.
 */
export function processPixels(
  data: Uint8Array,
  components: number,
  width: number,
  height: number,
  recipe: Recipe,
): Uint8Array {
  const ps = Math.max(1, Math.round(recipe.pixelSize));
  const w = Math.max(1, Math.floor(width / ps));
  const h = Math.max(1, Math.floor(height / ps));

  // Box-average down to working size.
  const small = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      const y1 = y === h - 1 ? height : (y + 1) * ps;
      const x1 = x === w - 1 ? width : (x + 1) * ps;
      for (let yy = y * ps; yy < y1; yy++) {
        for (let xx = x * ps; xx < x1; xx++) {
          const o = (yy * width + xx) * components;
          r += data[o];
          g += data[o + 1];
          b += data[o + 2];
          a += components === 4 ? data[o + 3] : 255;
          n++;
        }
      }
      const o = (y * w + x) * 4;
      small[o] = r / n;
      small[o + 1] = g / n;
      small[o + 2] = b / n;
      small[o + 3] = a / n;
    }
  }

  // Alpha is restored from the original below, so dither everything opaque.
  for (let i = 3; i < small.length; i += 4) small[i] = 255;
  const { rgba } = render(small, w, h, recipe);

  // Nearest-neighbour back up to full size.
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
export function recipeTextToJson(text: string): unknown {
  const t = text.trim();
  if (t.startsWith("{")) return JSON.parse(t);
  const m = t.match(/[#&?]r=([A-Za-z0-9_-]+)/);
  const encoded = m ? m[1] : t;
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error("That doesn't look like a Dither Lab link or recipe");
  return JSON.parse(utf8(base64url(encoded)));
}

// UXP doesn't reliably provide atob/TextDecoder, so decode by hand.
function base64url(s: string): Uint8Array {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const out: number[] = [];
  let buf = 0, bits = 0;
  for (const ch of s) {
    const v = alphabet.indexOf(ch);
    if (v < 0) continue;
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buf >> bits) & 255);
    }
  }
  return Uint8Array.from(out);
}

function utf8(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i++];
    let cp: number;
    if (b < 0x80) cp = b;
    else if (b < 0xe0) cp = ((b & 0x1f) << 6) | (bytes[i++] & 0x3f);
    else if (b < 0xf0) cp = ((b & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
    else cp = ((b & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
    s += String.fromCodePoint(cp);
  }
  return s;
}
