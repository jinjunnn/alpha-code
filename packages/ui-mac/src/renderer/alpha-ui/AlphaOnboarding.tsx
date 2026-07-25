// AlphaOnboarding — first-run welcome (mockup shell.html §E · 首次运行): an α mark, a 3-step progress
// (登录账号 → 选择模型 → 打开第一个项目) and a 继续 / 跳过-BYOK CTA, so new users no longer land on a
// bare empty state. Shown until dismissed (a localStorage flag); the steps reflect REAL auth state
// (logged-in flips step 1 to done). Mounted as a route-agnostic AppInterface child like AlphaHome.

import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { Portal } from "solid-js/web"
import type { AuthState } from "../../preload/types"
import { t } from "../i18n"
import { subscribeAuthState } from "../auth-recovery"
import "./onboarding.css"

const DONE_KEY = "alpha.onboarding.done"

export function AlphaOnboarding() {
  const [dismissed, setDismissed] = createSignal(localStorage.getItem(DONE_KEY) === "1")
  const [auth, setAuth] = createSignal<AuthState>({ status: "logged-out", mode: "byok" })
  onMount(() => {
    const unsub = subscribeAuthState(setAuth)
    onCleanup(unsub)
  })
  const loggedIn = () => auth().status === "logged-in"
  const finish = () => {
    try {
      localStorage.setItem(DONE_KEY, "1")
    } catch {}
    setDismissed(true)
  }
  // Primary CTA drives the active step: signed-out → start login (step 1); signed-in → finish onboarding
  // and drop into the home where step 2/3 (pick model · open project) happen with the real composer.
  const primary = () => {
    if (!loggedIn()) {
      void window.api.auth.start()
      return
    }
    finish()
  }
  return (
    <Show when={!dismissed()}>
      <Portal>
        <div class="a-ui a-ob" data-alpha-onboarding>
          <div class="a-ob-card">
            <div class="a-ob-mark">α</div>
            <h3 class="a-ob-title">{t("alpha.onboarding.title")}</h3>
            <p class="a-ob-sub">{t("alpha.onboarding.subtitle")}</p>
            <div class="a-ob-steps">
              <div class="a-ob-step" classList={{ done: loggedIn(), now: !loggedIn() }}>
                <span class="a-ob-n">
                  <Show when={loggedIn()} fallback={<>1</>}>
                    <svg class="a-ic a-ic-sm" viewBox="0 0 24 24" style={{ stroke: "#fff" }}>
                      <path d="M20 6L9 17l-5-5" />
                    </svg>
                  </Show>
                </span>
                {t("alpha.onboarding.signIn")}
                <span class="a-ob-status" classList={{ accent: !loggedIn() }}>{loggedIn() ? t("alpha.onboarding.done") : t("alpha.onboarding.inProgress")}</span>
              </div>
              <div class="a-ob-step" classList={{ now: loggedIn() }}>
                <span class="a-ob-n">2</span>
                {t("alpha.onboarding.chooseModel")}
                <Show when={loggedIn()}>
                  <span class="a-ob-status accent">{t("alpha.onboarding.inProgress")}</span>
                </Show>
              </div>
              <div class="a-ob-step">
                <span class="a-ob-n">3</span>
                {t("alpha.onboarding.openFirstProject")}
              </div>
            </div>
            <button class="a-ob-btn" onClick={primary}>{loggedIn() ? t("alpha.onboarding.continue") : t("alpha.onboarding.login")}</button>
            <div class="a-ob-skip" onClick={finish}>{t("alpha.onboarding.skipByok")}</div>
          </div>
        </div>
      </Portal>
    </Show>
  )
}
