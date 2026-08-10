import type { TimelineRow } from "../../src/renderer/alpha-ui/session-timeline/timeline-model"

export const timelineBenchmarkFixture = {
  schemaVersion: 1,
  initialTurns: 160,
  olderTurns: 40,
  viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
  streamDurationMs: 30_000,
  streamIntervalMs: 50,
  fixedEpochMs: 1_700_000_000_000,
} as const

export const timelineBenchmarkStreamRowKey = "stream:markdown"

export function materializeTimelineBenchmarkFixture() {
  const olderRows = Array.from({ length: timelineBenchmarkFixture.olderTurns }).flatMap((_, index) =>
    turnRows("older", index, index - timelineBenchmarkFixture.olderTurns),
  )
  const initialRows = [
    ...Array.from({ length: timelineBenchmarkFixture.initialTurns }).flatMap((_, index) =>
      turnRows("initial", index, index),
    ),
    {
      kind: "markdown",
      key: timelineBenchmarkStreamRowKey,
      rev: "1",
      streaming: true,
      part: {
        id: "prt_stream_markdown",
        sessionID: "ses_alpha_timeline_benchmark",
        messageID: "msg_stream_assistant",
        type: "text",
        text: "Streaming benchmark begins.",
      },
    } satisfies TimelineRow,
  ]
  return {
    descriptor: timelineBenchmarkFixture,
    initialRows,
    olderRows,
  }
}

function turnRows(prefix: string, index: number, order: number): TimelineRow[] {
  const createdAt = timelineBenchmarkFixture.fixedEpochMs + order * 10_000
  const userID = `msg_${prefix}_user_${String(index).padStart(4, "0")}`
  const assistantID = `msg_${prefix}_assistant_${String(index).padStart(4, "0")}`
  const markdown = benchmarkMarkdown(prefix, index)
  return [
    {
      kind: "turn",
      key: `${prefix}:${index}:turn`,
      rev: "1",
      userMessageID: userID,
      createdAt,
    },
    {
      kind: "user",
      key: `${prefix}:${index}:user`,
      rev: "1",
      message: {
        id: userID,
        sessionID: "ses_alpha_timeline_benchmark",
        role: "user",
        agent: "build",
        model: { providerID: "openai", modelID: "gpt-5" },
        time: { created: createdAt },
      } as never,
      text: `Inspect module ${index} and preserve the production timeline contract.`,
      copyText: () => `Inspect module ${index} and preserve the production timeline contract.`,
      truncated: false,
      segments: [{ text: `Inspect module ${index} and preserve the production timeline contract.` }],
      attachments: [],
      comments: [],
    },
    ...(index % 2 === 0
      ? ([
          {
            kind: "reasoning",
            key: `${prefix}:${index}:reasoning`,
            rev: "1",
            streaming: false,
            part: {
              id: `prt_${prefix}_reasoning_${index}`,
              sessionID: "ses_alpha_timeline_benchmark",
              messageID: assistantID,
              type: "reasoning",
              text: `Reviewing deterministic fixture row ${index}.`,
              time: { start: createdAt + 500, end: createdAt + 900 },
            } as never,
          } satisfies TimelineRow,
        ] as TimelineRow[])
      : []),
    {
      kind: "markdown",
      key: `${prefix}:${index}:markdown`,
      rev: "1",
      streaming: false,
      part: {
        id: `prt_${prefix}_markdown_${index}`,
        sessionID: "ses_alpha_timeline_benchmark",
        messageID: assistantID,
        type: "text",
        text: markdown,
      } as never,
    },
  ]
}

function benchmarkMarkdown(prefix: string, index: number) {
  const prose = `Fixture ${prefix}/${index} exercises the Alpha-owned session timeline with deterministic content. `
  if (index % 20 !== 0) return prose.repeat(4)
  return `${prose.repeat(3)}\n\n\`\`\`ts\nexport const fixture${index} = ${index}\n\`\`\``
}
