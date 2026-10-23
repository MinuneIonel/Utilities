// Public surface of the PDF engine. Pure TypeScript over byte arrays, no DOM,
// so it can run in a worker, in Node, or as a stage of a larger pipeline.

export * from "./types";
export { parseRanges, parseGroups, everyN } from "./ranges";
export { toPdf, visualSize, normRotation } from "./geometry";
export { build, inspect, split, protect, compact, fromRaster, openPdf, PasswordError } from "./pdf";
