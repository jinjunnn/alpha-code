import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { closeChips, PermChip } from "./alpha-composer"
import { createComposerAutocomplete } from "./composer-autocomplete"

export { render }

export function PermChipHarness() {
  const command = {
    options: [],
    trigger() {},
  } as unknown as Parameters<typeof PermChip>[0]["command"]
  return <PermChip command={command} />
}

export function AutocompleteHarness() {
  let textarea: HTMLTextAreaElement | undefined
  const [text, setText] = createSignal("/")
  const command = {
    options: [
      { id: "alpha.test.one", title: "One", slash: "one" },
      { id: "alpha.test.two", title: "Two", slash: "two" },
    ],
    trigger() {},
  } as unknown as Parameters<typeof createComposerAutocomplete>[0]["command"]
  const auto = createComposerAutocomplete({
    text,
    setText,
    textarea: () => textarea,
    directory: () => undefined,
    command,
    sdk: () => undefined,
    onMention() {},
    modes: ["slash"],
  })

  return (
    <>
      <textarea
        ref={textarea}
        value={text()}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={auto.open()}
        aria-controls={auto.listboxId}
        aria-activedescendant={auto.activeDescendant()}
        onInput={(event) => {
          setText(event.currentTarget.value)
          auto.onInput()
        }}
        onKeyDown={(event) => auto.onKeyDown(event)}
      />
      <auto.Menu />
    </>
  )
}

export function resetComposerA11yHarness() {
  closeChips()
}
