/**
 * Background JSContext entry — Conversate miniapp.
 *
 * `registerMiniapp(...)` wires the handler to fire after CONNECT lands; the
 * controller constructed here lives for the entire session and survives
 * WebView open/close cycles.
 */

import {registerMiniapp} from "@mentra/miniapp/background"

import {ConversateController} from "./ConversateController"

registerMiniapp((session) => {
  void new ConversateController(session).start()
})
