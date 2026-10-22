// Public surface of the media engine. Everything here is UI-independent, with typed inputs and
// outputs, so each function can become a stage of a larger pipeline:
//
//   decodeImage    Blob → RGBAImage
//   transformImage RGBAImage + Transform → RGBAImage
//   processImage   RGBAImage + ImageJob → encoded image
//   probeVideo     Blob → VideoInfo
//   processVideo   Blob + VideoInfo + VideoJob → encoded video (or GIF)

export * from "./types";
export { decodeImage } from "./decode";
export { encodeImage, IMAGE_FORMATS, processImage, transformImage, type ImageResult } from "./image";
export { probeVideo, processVideo, targetBitrate, VIDEO_CONTAINERS, type RunOptions, type VideoInfo } from "./video";
export { ffmpegArgs, parseProbe } from "./ffmpeg";
export { cropRGBA, orientRGBA } from "./raster";
