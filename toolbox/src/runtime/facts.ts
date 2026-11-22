// What a node found when it last ran (see NodeFacts): the size, length or pages of what it works
// on, read from its input (or, for a source node, its own output), plus the names its NodeDef gives.
// The inspector fits sliders and pickers to them. Plain data: no DOM, so it runs in the worker or Node.
import type { NodeDef, NodeFacts, Params, RunContext, Value } from "./types";

/** Facts read off one value: a picture's full size, a video's or sound's length, a document's pages. */
export function factsOfValue(v: Value | undefined): NodeFacts {
  if (!v) return {};
  switch (v.kind) {
    case "image": {
      const k = v.scale && v.scale > 0 && v.scale < 1 ? v.scale : 1;
      return { width: Math.round(v.width / k), height: Math.round(v.height / k) };
    }
    case "video": {
      const f: NodeFacts = {};
      if (v.width > 0 && v.height > 0) Object.assign(f, { width: v.width, height: v.height });
      if (v.duration > 0) {
        f.duration = v.duration;
        if (v.fps > 0) f.frames = Math.max(1, Math.round(v.duration * v.fps));
      }
      return f;
    }
    case "audio":
      return v.duration && v.duration > 0 ? { duration: v.duration } : {};
    case "document":
      return v.pageCount > 0 ? { pages: v.pageCount } : {};
    case "each":
      return { items: v.items.map((i) => i.name) };
    default:
      return {};
  }
}

/** The first value in port order that says something. */
function firstFacts(ports: { key: string }[], values: Record<string, Value | undefined>): NodeFacts {
  for (const p of ports) {
    const f = factsOfValue(values[p.key]);
    if (Object.keys(f).length) return f;
  }
  return {};
}

/**
 * Everything known about what a node works on: its input when it has one (Resize fits its image),
 * else its own output (a Video file's length), with the NodeDef's own facts on top. Undefined when
 * nothing is known, so the inspector falls back to plain number boxes.
 */
export function nodeFacts(def: NodeDef, params: Params, inputs: Record<string, Value | undefined>, outputs: Record<string, Value>, ctx: RunContext): NodeFacts | undefined {
  const fromInputs = def.inputs.length ? firstFacts(def.inputs, inputs) : {};
  const seen = Object.keys(fromInputs).length ? fromInputs : firstFacts(def.outputs, outputs);
  let own: Partial<NodeFacts> | undefined;
  try {
    own = def.facts?.(params, inputs, ctx);
  } catch {
    own = undefined;
  }
  const f: NodeFacts = { ...seen, ...own };
  for (const k of Object.keys(f) as (keyof NodeFacts)[]) if (f[k] === undefined) delete f[k];
  return Object.keys(f).length ? f : undefined;
}
