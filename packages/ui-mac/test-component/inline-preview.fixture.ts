// #1503: read part fields copied from the two D4 attachment-metadata records and
// their read-only DB rows (prt_0ccf4dd94001twC8GHZUtQ7WN3 / prt_0ccf4de3a001hMv3czcFDxal3u).
// All identifiers/text are synthetic; PNGs are locally generated 32x32 red/blue swatches.
import producer from "../../alpha-contracts-consumer/vendor/alpha-platform/contracts/v1/fixtures/producer/artifact-list.json"

export const previewPngs = [
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR4nGO4I6dLU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULACuKnD2ir9opAAAAAElFTkSuQmCC",
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR4nGOQc7tDU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULANqyAEyczrCQAAAAAElFTkSuQmCC",
]
export const previewParts = previewPngs.map((url, index) => ({
  id: `prt_preview_${index}`, sessionID: "ses_live", messageID: "msg_preview",
  type: "tool", tool: "read", callID: `call_preview_${index}`,
  display: {
    identity: { source: "builtin", origin: "", name: "read" },
    technicalId: "read", authority: { kind: "not-asserted" },
  },
  state: {
    status: "completed", input: { filePath: `/tmp/workspace/swatch_${index}.png` },
    output: "Image read", metadata: { preview: "Image read", truncated: false, loaded: [] },
    title: `swatch_${index}.png`, time: { start: 10 + index, end: 11 + index },
    attachments: [{ type: "file", mime: "image/png", url, id: `prt_image_${index}`, sessionID: "ses_live", messageID: "msg_preview" }],
  },
}))

// Descriptor/envelope shape is the vendored producer fixture; only task identity and our content change.
export const previewRuns = ["A", "B"].map((letter, index) => {
  const contents = [
    Uint8Array.from(atob(previewPngs[index].split(",")[1]), (char) => char.charCodeAt(0)),
    new TextEncoder().encode(`# Document ${letter}\n\nGenerated test content ${letter}.`),
  ]
  const descriptors = contents.map((bytes, kind) => ({
    ...producer.value.artifacts[0],
    id: `art_job_${letter}_${kind}_deadbeef`, name: kind === 0 ? "swatch.png" : "review.md",
    size: bytes.length, claimedMime: kind === 0 ? "image/png" : "text/markdown",
    sha256: [["e649dfc3347cda04df7f1981f96bdc3ded7ced633c7a0d71d5f01c6de89e2120", "b4a65217caa55940a77778c0477112589f6ef206fb9c76bf526628241d7fef1f"], ["b87be05eab732e763a140290589fa051e17fe2fd7b87f5c1eaa7595d7073aab1", "3b6d95ed74f73d20bc4df76881ba3268d5e64c613fa9379096bd6e788cad987f"]][index][kind],
    contentRef: { ...producer.value.artifacts[0].contentRef, url: `/v1/cloud/artifacts/art_job_${letter}_${kind}_deadbeef/content` },
    provenance: { ...producer.value.artifacts[0].provenance, jobId: `job_${letter}` },
  }))
  return {
    runId: `job_${letter}`, contents,
    response: { ...producer.value, job_id: `job_${letter}`, artifacts: descriptors, artifact_ids: descriptors.map((item) => item.id) },
  }
})
