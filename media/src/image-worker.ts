// Runs image jobs off the main thread: decode, transform, encode.

import { decodeImage } from "./engine/decode";
import { processImage } from "./engine/image";
import type { ImageJob } from "./engine/types";

export interface ImageRequest {
  id: number;
  file: Blob;
  job: ImageJob;
}

self.onmessage = async (e: MessageEvent<ImageRequest>) => {
  const { id, file, job } = e.data;
  try {
    const src = await decodeImage(file);
    const result = await processImage(src, job);
    (self as unknown as Worker).postMessage({ id, result }, [result.bytes.buffer]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
