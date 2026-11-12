// Adding nodes and wires: the Add node menu (Tab, right-click, or a wire dropped on empty
// canvas), workflows, and which wires are allowed.
import { useCallback, useMemo, useState, type RefObject } from "react";
import { addEdge, type Connection, type Edge, type FinalConnectionState, type ReactFlowInstance } from "@xyflow/react";
import { newId, newNode, placeWorkflow, WORKFLOWS } from "../graphs";
import { CONVERTERS, NODE_DEFS, REGISTRY } from "../nodes";
import { canConnect, type outputShapes } from "../runtime/evaluate";
import type { NodeDef } from "../runtime/types";
import type { ToolFlowNode } from "../ui/context";
import { hasContent, inputPort, MOD, NODE_HALF_WIDTH, toFlow, type Flash, type MenuState, type Point, type SetEdges, type SetNodes } from "./flow";

export function useNodeMenu(
  flow: ReactFlowInstance<ToolFlowNode, Edge>,
  canvasRef: RefObject<HTMLDivElement | null>,
  shapes: ReturnType<typeof outputShapes>,
  setNodes: SetNodes,
  setEdges: SetEdges,
  flash: Flash,
) {
  const [menu, setMenu] = useState<MenuState | null>(null);

  const addNode = useCallback(
    (type: string, position?: Point) => {
      let pos = position;
      if (!pos) {
        const r = canvasRef.current!.getBoundingClientRect();
        pos = flow.screenToFlowPosition({ x: r.left + r.width / 2 - 110, y: r.top + r.height / 2 - 60 });
      }
      const n = newNode(type, pos);
      setNodes((ns) => [
        ...ns.map((x) => ({ ...x, selected: false })),
        { id: n.id, type: "tool", position: n.position, data: { type: n.type, params: n.params }, selected: true },
      ]);
      return n.id;
    },
    [canvasRef, flow, setNodes],
  );

  /** Opens the Add node menu at a point on screen, or the canvas centre. */
  const openMenu = useCallback(
    (client?: Point, from?: MenuState["from"], workflows?: boolean) => {
      const r = canvasRef.current!.getBoundingClientRect();
      const inside = client && client.x >= r.left && client.x <= r.right && client.y >= r.top && client.y <= r.bottom;
      const c = inside ? client : { x: r.left + r.width / 2, y: r.top + r.height / 3 };
      const at = flow.screenToFlowPosition(c);
      setMenu({ x: c.x - r.left, y: c.y - r.top, at: { x: at.x - NODE_HALF_WIDTH, y: at.y - 20 }, from, workflows });
    },
    [canvasRef, flow],
  );

  /** The first input of `def` that the menu's wire can feed. */
  const portFor = useCallback(
    (def: NodeDef, from: MenuState["from"]) => {
      const shape = from && shapes.get(`${from.node}:${from.handle}`);
      return shape ? def.inputs.find((p) => canConnect(shape, def, p, CONVERTERS).ok) : undefined;
    },
    [shapes],
  );

  const onConnect = useCallback(
    (c: Connection) =>
      setEdges((es) =>
        addEdge(
          { ...c, id: newId("e") },
          // One wire per input: a new wire replaces the old one.
          es.filter((e) => !(e.target === c.target && e.targetHandle === c.targetHandle)),
        ),
      ),
    [setEdges],
  );

  const isValidConnection = useCallback(
    (c: Edge | Connection) => {
      const s = flow.getNode(c.source);
      const t = flow.getNode(c.target);
      if (!s || !t || s.id === t.id) return false;
      const from = shapes.get(`${s.id}:${c.sourceHandle}`);
      const def = REGISTRY.get(t.data.type);
      const port = inputPort(t.data.type, c.targetHandle ?? null);
      if (!from || !def || !port || !canConnect(from, def, port, CONVERTERS).ok) return false;
      // Refuse wires that would make a loop: the target must not already feed the source.
      const seen = new Set<string>();
      const stack = [t.id];
      const es = flow.getEdges();
      while (stack.length) {
        const id = stack.pop()!;
        if (id === s.id) return false;
        if (seen.has(id)) continue;
        seen.add(id);
        for (const e of es) if (e.source === id) stack.push(e.target);
      }
      return true;
    },
    [flow, shapes],
  );

  // A wire dropped on empty canvas opens the menu with the nodes that can take it.
  const onConnectEnd = useCallback(
    (e: MouseEvent | TouchEvent, c: FinalConnectionState) => {
      if (c.isValid || c.toNode || !c.fromNode || c.fromHandle?.type !== "source" || !c.fromHandle.id) return;
      const p = "changedTouches" in e ? e.changedTouches[0] : e;
      openMenu({ x: p.clientX, y: p.clientY }, { node: c.fromNode.id, handle: c.fromHandle.id });
    },
    [openMenu],
  );

  const menuDefs = useMemo(() => NODE_DEFS.filter((d) => !d.hidden && (!menu?.from || portFor(d, menu.from))), [menu, portFor]);

  const pickFromMenu = useCallback(
    (type: string) => {
      if (!menu) return;
      setMenu(null);
      const id = addNode(type, menu.at);
      const port = menu.from && portFor(REGISTRY.get(type)!, menu.from);
      if (menu.from && port) onConnect({ source: menu.from.node, sourceHandle: menu.from.handle, target: id, targetHandle: port.key });
    },
    [addNode, menu, onConnect, portFor],
  );
  const closeMenu = useCallback(() => setMenu(null), []);

  // A workflow takes over a graph that holds nothing of yours yet; otherwise it drops in under what's there.
  // Its first node is selected so the inspector shows what to fill in.
  const pickWorkflow = useCallback(
    (id: string) => {
      const w = WORKFLOWS.find((x) => x.id === id);
      if (!menu || !w) return;
      setMenu(null);
      const current = flow.getNodes();
      const replace = !hasContent(current);
      const box = (n: { position: Point; measured?: { width?: number; height?: number } }) => ({
        l: n.position.x,
        t: n.position.y,
        r: n.position.x + (n.measured?.width ?? 2 * NODE_HALF_WIDTH),
        b: n.position.y + (n.measured?.height ?? 160),
      });
      const existing = replace ? [] : current.map(box);
      let placed = placeWorkflow(w, menu.at);
      const covers = placed.nodes.map(box).some((a) => existing.some((e) => a.l < e.r && e.l < a.r && a.t < e.b && e.t < a.b));
      if (covers) {
        placed = placeWorkflow(w, { x: Math.min(...existing.map((e) => e.l)), y: Math.max(...existing.map((e) => e.b)) + 80 });
      }
      const f = toFlow(placed);
      f.nodes[0].selected = true;
      if (replace) {
        setNodes(f.nodes);
        setEdges(f.edges);
      } else {
        setNodes((ns) => [...ns.map((x) => ({ ...x, selected: false })), ...f.nodes]);
        setEdges((es) => [...es, ...f.edges]);
      }
      const first = REGISTRY.get(f.nodes[0].data.type)!;
      const todo =
        first.type === "input.download" ? "paste a link in the inspector, then Render"
        : first.type === "input.text" ? "type or paste your text, then Render"
        : first.type === "input.images" ? "drop in your photos, then Render"
        : first.type === "input.qr" ? "type your link or text in the inspector, then Render"
        : first.type === "input.webcam" ? "allow the camera, press Render to record and Stop to finish"
        : "drop in your file, then Render";
      flash(`${w.title}: ${todo}.${replace && current.length ? ` ${MOD}Z brings back the old graph.` : ""}`);
      setTimeout(() => flow.fitView({ nodes: f.nodes.map((n) => ({ id: n.id })), padding: 0.25, maxZoom: 1, duration: 300 }), 50);
    },
    [flash, flow, menu, setEdges, setNodes],
  );

  return { menu, addNode, openMenu, closeMenu, menuDefs, pickFromMenu, pickWorkflow, onConnect, onConnectEnd, isValidConnection };
}
