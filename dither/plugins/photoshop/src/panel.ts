import { parseRecipe, type Recipe } from "../../../src/engine/recipe";
import { stepDef } from "../../../src/engine/steps";
import { builtInRecipes } from "../../../src/recipes";
import { processPixels, recipeTextToJson } from "./process";

// UXP's module loader; the photoshop module only exists inside Photoshop.
declare const require: (id: string) => any;
const { app, core, imaging } = require("photoshop");

const STORE = "dither-lab:imported";
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const recipeSelect = $<HTMLSelectElement>("recipe");
const pixel = $<HTMLInputElement>("pixel");
const pixelOut = $<HTMLElement>("pixel-out");
const steps = $<HTMLOListElement>("steps");
const status = $<HTMLElement>("status");

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

function imported(): Recipe[] {
  try {
    return (JSON.parse(localStorage.getItem(STORE) ?? "[]") as unknown[]).map(parseRecipe);
  } catch {
    return [];
  }
}

function allRecipes(): { key: string; recipe: Recipe }[] {
  return [
    ...builtInRecipes().map((recipe, i) => ({ key: `b${i}`, recipe })),
    ...imported().map((recipe, i) => ({ key: `i${i}`, recipe })),
  ];
}

let current: Recipe = builtInRecipes()[0];

function buildMenu(selectKey?: string) {
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

function select(key: string) {
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

function say(msg: string, error = false) {
  status.textContent = msg;
  status.className = error ? "error" : "";
}

recipeSelect.addEventListener("change", () => select(recipeSelect.value));
pixel.addEventListener("input", () => {
  current.pixelSize = Number(pixel.value);
  pixelOut.textContent = `${current.pixelSize}px`;
});

$("import-btn").addEventListener("click", () => {
  const box = $<HTMLTextAreaElement>("import");
  try {
    const recipe = parseRecipe(recipeTextToJson(box.value));
    const list = imported().filter((r) => r.name !== recipe.name);
    list.push(recipe);
    localStorage.setItem(STORE, JSON.stringify(list));
    box.value = "";
    buildMenu(`i${list.length - 1}`);
    say(`Imported “${recipe.name}”`);
  } catch (err) {
    say(String((err as Error).message ?? err), true);
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
  const asNewLayer = $<HTMLInputElement>("new-layer").checked;
  say("Dithering…");
  const t0 = Date.now();
  try {
    await core.executeAsModal(
      async () => {
        const target = asNewLayer ? await layer.duplicate() : layer;
        if (asNewLayer) target.name = `${layer.name} · ${recipe.name}`;
        const px = await imaging.getPixels({
          documentID: doc.id,
          layerID: target.id,
          componentSize: 8,
          colorSpace: "RGB",
        });
        const { width, height, components } = px.imageData;
        const data: Uint8Array = await px.imageData.getData();
        const out = processPixels(data, components, width, height, recipe);
        px.imageData.dispose();
        const imageData = await imaging.createImageDataFromBuffer(out, {
          width,
          height,
          components,
          chunky: true,
          colorSpace: "RGB",
        });
        await imaging.putPixels({
          documentID: doc.id,
          layerID: target.id,
          imageData,
          replace: true,
          targetBounds: { left: px.sourceBounds.left, top: px.sourceBounds.top },
        });
        imageData.dispose();
      },
      { commandName: `Dither Lab: ${recipe.name}` },
    );
    say(`Done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  } catch (err) {
    say(`Failed: ${(err as Error).message ?? err}`, true);
  }
});

buildMenu();
