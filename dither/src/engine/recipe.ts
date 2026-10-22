import { defaultParams, stepDef, type ParamValue, type StepContext } from "./steps";

export interface Step {
  id: string;
  type: string;
  enabled: boolean;
  params: Record<string, ParamValue>;
}

export interface Recipe {
  version: 1;
  name: string;
  /** Size of one output pixel in source pixels. */
  pixelSize: number;
  steps: Step[];
}

let nextId = 1;
export function newStep(type: string, params?: Record<string, ParamValue>): Step {
  return {
    id: `s${Date.now().toString(36)}${(nextId++).toString(36)}`,
    type,
    enabled: true,
    params: { ...defaultParams(type), ...params },
  };
}

export function defaultRecipe(): Recipe {
  return {
    version: 1,
    name: "Untitled",
    pixelSize: 2,
    steps: [newStep("adjust"), newStep("dither")],
  };
}

export interface RenderResult {
  rgba: Uint8ClampedArray;
  indices?: Uint8Array;
  palette?: string[];
  ms: number;
}

/** Runs every enabled step over an RGBA image already scaled to working size. */
export function render(src: Uint8ClampedArray, w: number, h: number, recipe: Recipe, frame = 0): RenderResult {
  const t0 = performance.now();
  const n = w * h;
  const rgb = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    rgb[i * 3] = src[i * 4];
    rgb[i * 3 + 1] = src[i * 4 + 1];
    rgb[i * 3 + 2] = src[i * 4 + 2];
  }
  const ctx: StepContext = { w, h, frame, source: src };
  for (const step of recipe.steps) {
    if (!step.enabled) continue;
    const def = stepDef(step.type);
    if (!def) continue;
    def.run(rgb, ctx, { ...defaultParams(step.type), ...step.params });
    // A later non-dither step changes the colors, so indices no longer describe the image.
    if (step.type !== "dither") ctx.indices = undefined;
  }
  const rgba = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    rgba[i * 4] = rgb[i * 3];
    rgba[i * 4 + 1] = rgb[i * 3 + 1];
    rgba[i * 4 + 2] = rgb[i * 3 + 2];
    rgba[i * 4 + 3] = src[i * 4 + 3] >= 128 ? 255 : 0;
  }
  return { rgba, indices: ctx.indices, palette: ctx.indices ? ctx.palette : undefined, ms: performance.now() - t0 };
}

/** Validates and normalises an imported recipe, dropping unknown steps. */
export function parseRecipe(json: unknown): Recipe {
  const r = json as Partial<Recipe>;
  if (!r || typeof r !== "object" || !Array.isArray(r.steps)) throw new Error("Not a dither recipe");
  return {
    version: 1,
    name: typeof r.name === "string" ? r.name : "Imported",
    pixelSize: Math.max(1, Math.min(32, Number(r.pixelSize) || 1)),
    steps: r.steps
      .filter((s) => s && typeof s.type === "string" && stepDef(s.type))
      .map((s) => ({ ...newStep(s.type, s.params), enabled: s.enabled !== false })),
  };
}

export function encodeRecipe(r: Recipe): string {
  const slim = { ...r, steps: r.steps.map(({ type, enabled, params }) => ({ type, enabled, params })) };
  const bytes = new TextEncoder().encode(JSON.stringify(slim));
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeRecipe(s: string): Recipe {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return parseRecipe(JSON.parse(new TextDecoder().decode(bytes)));
}
