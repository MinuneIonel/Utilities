// Split into clips: one video or sound in, a list of shorter files out, which
// Save writes one file each. The cutting happens in video-codec.ts and
// audio-codec.ts, loaded on first use.
import { FORMAT_LIST, isAudioFormat } from "../../../audio/src/engine";
import { VIDEO_CONTAINERS, type VideoContainer } from "../../../media/src/engine/types";
import type { AudioValue, FileValue, NodeDef, VideoValue } from "../runtime/types";
import { audioCodec } from "./audio";
import { clipRanges, type SplitMode } from "./clips";
import { videoCodec } from "./video";

export const splitClips: NodeDef = {
  type: "media.split",
  title: "Split into clips",
  category: "video",
  description:
    "Cuts one video or sound into several shorter clips: every so many seconds, into equal parts, at the times you list, or just the parts you list (0:10-0:25, 1:00-1:30). Feed it to Save for one file per clip. Runs on Render.",
  inputs: [
    { key: "video", label: "Video", type: "video", optional: true },
    { key: "audio", label: "Audio", type: "audio", optional: true },
  ],
  outputs: [{ key: "clips", label: "Clips", type: "file" }],
  params: [
    {
      key: "mode",
      label: "Split",
      kind: "select",
      options: [
        { value: "every", label: "Every … seconds" },
        { value: "count", label: "Into equal parts" },
        { value: "at", label: "At these times" },
        { value: "parts", label: "Keep these parts" },
      ],
    },
    { key: "every", label: "Clip length s", kind: "number", min: 0.5, max: 36000, step: 0.5 },
    { key: "count", label: "Number of clips", kind: "number", min: 1, max: 500, step: 1 },
    { key: "at", label: "Cut at", kind: "text", commit: true, placeholder: "0:30, 1:15, 2:40" },
    { key: "parts", label: "Parts", kind: "text", multiline: true, commit: true, placeholder: "0:10-0:25, 1:00-1:30" },
    {
      key: "container",
      label: "Format",
      kind: "select",
      options: [
        { value: "same", label: "Same as the source" },
        ...(Object.keys(VIDEO_CONTAINERS) as VideoContainer[]).map((c) => ({ value: c, label: `${VIDEO_CONTAINERS[c].label} (video)` })),
        ...FORMAT_LIST.map((f) => ({ value: f.id, label: `${f.label} (sound)` })),
      ],
    },
    {
      key: "quality",
      label: "Video quality",
      kind: "select",
      options: [
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium" },
        { value: "high", label: "High" },
        { value: "very-high", label: "Very high" },
      ],
    },
    { key: "name", label: "File names (adds -1, -2…)", kind: "text" },
  ],
  defaults: () => ({ mode: "every", every: 30, count: 3, at: "", parts: "", container: "same", quality: "high", name: "" }),
  visible: (key, p) => {
    if (key === "every" || key === "count" || key === "at" || key === "parts") return key === p.mode;
    if (key === "quality") return !isAudioFormat(String(p.container));
    return true;
  },
  kind: "job",
  async run(inputs, params, ctx) {
    const v = inputs.video as VideoValue | undefined;
    const a = inputs.audio as AudioValue | undefined;
    if (v && a) throw new Error("Wire in a video or a sound, not both");
    if (!v && !a) throw new Error("Connect a video or a sound");
    const mode = (["every", "count", "at", "parts"].includes(String(params.mode)) ? params.mode : "every") as SplitMode;
    const ranges = (duration: number) =>
      clipRanges(duration, mode, { every: Number(params.every), count: Number(params.count), at: String(params.at ?? ""), parts: String(params.parts ?? "") });
    const format = String(params.container || "same");
    const base = String(params.name ?? "").replace(/[\\/:*?"<>|]+/g, "-").trim();
    let clips: FileValue[];
    if (a) {
      if (format in VIDEO_CONTAINERS) throw new Error("Pick a sound format for a sound, or Same as the source");
      clips = await (await audioCodec()).split(a, ranges, format, base, ctx);
    } else {
      if (isAudioFormat(format)) throw new Error("Pick a video format for a video. For just the sound, add Extract audio before this.");
      const own = /\.([a-z0-9]+)$/i.exec(((v!.origin ?? v!.audioSource) as File | undefined)?.name ?? "")?.[1]?.toLowerCase() ?? "";
      const container = format in VIDEO_CONTAINERS ? format : own in VIDEO_CONTAINERS && own !== "gif" ? own : "mp4";
      clips = await (await videoCodec()).splitVideo(v!, ranges, { container, quality: params.quality, name: base }, ctx);
    }
    const list: VideoValue = {
      kind: "video",
      of: "file",
      width: v?.width ?? 0,
      height: v?.height ?? 0,
      duration: clips.length,
      fps: 1,
      poster: clips[0],
      async *frames() {
        for (let i = 0; i < clips.length; i++) yield { value: clips[i], timestamp: i, duration: 1, name: clips[i].name };
      },
    };
    return { clips: list };
  },
};
