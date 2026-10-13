// #1502: real timeline/projection/Markdown/CSS, with recorded and sanitized part shapes.
import { render } from "solid-js/web"
import { MarkedProvider } from "../../ui/src/context/marked"
import { setLocale } from "../src/renderer/i18n"
import { SessionTimelineView } from "../src/renderer/alpha-ui/session-timeline/session-timeline-view"
import { projectTimelineRows } from "../src/renderer/alpha-ui/session-timeline/timeline-model"
import samples from "./session-timeline-selection.fixture.json"
import "../../session-ui/src/components/markdown.css"

setLocale("zh")

const actions = document.getElementById("actions")!
render(
  () => (
    <MarkedProvider>
      <SessionTimelineView
        rows={projectTimelineRows({
          messages: samples.messages as never,
          partsOf: (id) => samples.parts.filter((part) => part.messageID === id) as never,
          status: "idle",
        })}
        ready={true}
        epoch="selection-sample"
        emptyTitle="Selection sample"
        history={{ more: false, loading: false }}
        onLoadOlder={() => Promise.resolve()}
        intents={{
          openFile: (intent) => (actions.textContent = `file:${intent.path}`),
          focusArtifact: (intent) => (actions.textContent = `artifact:${intent.name}`),
          editUserMessage: (intent) => (actions.textContent = `edit:${intent.text}`),
        }}
      />
    </MarkedProvider>
  ),
  document.getElementById("root")!,
)
