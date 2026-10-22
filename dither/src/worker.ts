import { render, type Recipe } from "./engine/recipe";

export interface RenderRequest {
  id: number;
  rgba: Uint8ClampedArray;
  w: number;
  h: number;
  recipe: Recipe;
  frame: number;
}

export interface RenderResponse {
  id: number;
  rgba: Uint8ClampedArray;
  indices?: Uint8Array;
  palette?: string[];
  w: number;
  h: number;
  ms: number;
  error?: string;
}

self.onmessage = (e: MessageEvent<RenderRequest>) => {
  const { id, rgba, w, h, recipe, frame } = e.data;
  try {
    const out = render(rgba, w, h, recipe, frame);
    const msg: RenderResponse = { id, w, h, ...out };
    const transfer: Transferable[] = [out.rgba.buffer];
    if (out.indices) transfer.push(out.indices.buffer);
    (self as unknown as Worker).postMessage(msg, transfer);
  } catch (err) {
    const msg: RenderResponse = { id, w, h, rgba: new Uint8ClampedArray(0), ms: 0, error: String(err) };
    (self as unknown as Worker).postMessage(msg);
  }
};
