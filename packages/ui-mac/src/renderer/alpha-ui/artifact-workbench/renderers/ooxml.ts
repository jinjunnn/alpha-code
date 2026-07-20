// Renderer compatibility entrypoint. The strict detector lives in shared/ so the main process can
// independently re-run the exact same gate before invoking an external Office consumer.
export * from "../../../../shared/ooxml"
