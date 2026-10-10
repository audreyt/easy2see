/**
 * Easy2See dev-only launch hook (overnight device lab).
 *
 * Reads keys from NSUserDefaults' argument domain — i.e. command-line
 * arguments passed by `xcrun devicectl device process launch`:
 *
 *   -E2S_OPEN <packageName>   open that miniapp after the home screen mounts,
 *                             via the same store path a tile tap uses
 *                             (engine.miniapps.start + setForeground / route push).
 *   -E2S_MIC <value>          write preferred_mic through the normal settings
 *                             facade ("auto" | "glasses" | "phone" | "bluetooth").
 *   -E2S_UI_MSG <list>        comma-separated `channel@delayMs[:json]` entries;
 *                             after E2S_OPEN foregrounds the miniapp, each is
 *                             dispatched to its background via the UI router —
 *                             the same path a WebView `mentra.send` takes, so
 *                             broadcast `session.ui.on` handlers fire without
 *                             needing a tap. Example:
 *                             "conversate:start@8000,conversate:end@60000"
 *   -E2S_STT_MODEL <code>     install a staged on-device STT model: copies
 *                             Documents/e2s-test/stt/<code>/ (pushed over USB
 *                             with devicectl) into stt_models/<code> under
 *                             internal storage, then activates that language
 *                             through sttModelManager — the same path the
 *                             Settings → Speech picker uses, minus the
 *                             download (the phone is offline).
 *
 * Gated on the packaged extra.easy2see flag so stock Mentra is untouched.
 * Read-only apart from those effects; no miniapp internals are bypassed.
 */
import {Platform, Settings} from "react-native"
import {activateKeepAwakeAsync} from "expo-keep-awake"

import {engine, SETTINGS, type ClientApp} from "@mentra/engine"
import {sttModelManager} from "@mentra/engine-host-internal"
import * as RNFS from "@dr.pogodin/react-native-fs"

import {isEasy2SeeBuild} from "@/services/deployment/officialManifest"
import {getMentraJS} from "@/services/mentraJsBootstrap"
import {isOfflineHosted} from "@/components/miniapp/offlineHostedPackages"
import {useNavigationStore} from "@/stores/navigation"


const TAG = "E2S"
function launchArg(key: string): string | null {
  if (Platform.OS !== "ios") return null
  const v = Settings.get(key)
  return typeof v === "string" && v.length > 0 ? v : null
}


async function waitForApp(packageName: string, timeoutMs = 20000): Promise<ClientApp | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const app = engine.miniapps.list().find((a) => a.packageName === packageName)
      if (app) return app
    } catch (e) {
      console.log(`${TAG}: waitForApp list() threw`, e)
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 500))
  }
  return null
}

export function applyE2sLaunchHook(): void {
  if (!isEasy2SeeBuild()) return

  if (launchArg("E2S_KEEP_AWAKE") === "1") {
    void activateKeepAwakeAsync(TAG)
      .then(() => console.log(`${TAG}: keep-awake engaged`))
      .catch((e) => console.warn(`${TAG}: keep-awake failed`, e))
  }

  const mic = launchArg("E2S_MIC")
  console.log(`${TAG}: hook entry open=${launchArg("E2S_OPEN") ?? "<none>"} mic=${mic ?? "<none>"} awake=${launchArg("E2S_KEEP_AWAKE") ?? "<none>"}`)
  if (mic) {
    // setSetting can throw synchronously before the settings store hydrates —
    // keep it from killing the E2S_OPEN path below.
    try {
      void engine.settings.set(SETTINGS.preferred_mic.key, mic, false)
        .then(
          () => console.log(`${TAG}: preferred_mic=${mic}`),
          (e: unknown) => console.log(`${TAG}: preferred_mic failed`, e),
        )
    } catch (e) {
      console.log(`${TAG}: preferred_mic threw`, e)
    }
  }

  const sttCode = launchArg("E2S_STT_MODEL")
  if (sttCode) {
    void (async () => {
      try {
        const src = `${RNFS.DocumentDirectoryPath}/e2s-test/stt/${sttCode}`
        const dest = sttModelManager.getModelPath(sttCode)
        if (!(await RNFS.exists(src))) {
          console.log(`${TAG}: E2S_STT_MODEL source missing: ${src}`)
          return
        }
        if (!(await RNFS.exists(dest))) {
          await RNFS.mkdir(dest)
          for (const f of await RNFS.readDir(src)) {
            await RNFS.copyFile(f.path, `${dest}/${f.name}`)
          }
          console.log(`${TAG}: E2S_STT_MODEL copied ${src} -> ${dest}`)
        }
        await sttModelManager.activateLanguage(sttCode)
        console.log(`${TAG}: E2S_STT_MODEL activated ${sttCode}`)
      } catch (e) {
        console.log(`${TAG}: E2S_STT_MODEL failed`, e)
      }
    })()
  }

  const packageName = launchArg("E2S_OPEN")
  const uiMsgs = launchArg("E2S_UI_MSG")
  if (!packageName) return

  const scheduleUiMessages = () => {
    if (!uiMsgs) return
    const router = getMentraJS()?.uiRouter
    if (!router) {
      console.log(`${TAG}: E2S_UI_MSG no uiRouter`)
      return
    }
    for (const entry of uiMsgs.split(",")) {
      const at = entry.indexOf("@")
      if (at <= 0) continue
      const channel = entry.slice(0, at)
      const rest = entry.slice(at + 1)
      const colon = rest.indexOf(":")
      const delayMs = Number(colon >= 0 ? rest.slice(0, colon) : rest)
      if (!channel || !Number.isFinite(delayMs)) continue
      let payload: unknown = {}
      if (colon >= 0) {
        try {
          payload = JSON.parse(rest.slice(colon + 1))
        } catch {
          console.log(`${TAG}: E2S_UI_MSG bad payload ${entry}`)
          continue
        }
      }
      setTimeout(() => {
        try {
          router.routeFromWebView(packageName, JSON.stringify({type: "msg", channel, payload}))
          console.log(`${TAG}: E2S_UI_MSG sent ${channel}`)
        } catch (e) {
          console.log(`${TAG}: E2S_UI_MSG send failed ${channel}`, e)
        }
      }, delayMs)
    }
    console.log(`${TAG}: E2S_UI_MSG armed ${uiMsgs}`)
  }

  void (async () => {
    console.log(`${TAG}: E2S_OPEN waiting for ${packageName}`)
    const app = await waitForApp(packageName)
    if (!app) {
      console.log(`${TAG}: E2S_OPEN target not found: ${packageName}`)
      return
    }
    console.log(`${TAG}: E2S_OPEN found local=${app.local} running=${app.running} route=${app.offlineRoute ?? "<none>"}`)
    const usesOverlay = isOfflineHosted(app.packageName) || app.local
    if (usesOverlay) {
      // setForeground flips the foreground flag synchronously — unlike
      // engine.miniapps.start it does not await the miniapp's steady-state
      // ready signal, which can NACK while the app is otherwise healthy.
      await engine.miniapps.setForeground(packageName)
      console.log(`${TAG}: E2S_OPEN foregrounded ${packageName}`)
      scheduleUiMessages()
      return
    }
    const started = app.running || (await engine.miniapps.start(app, {skipNavigation: true}))
    if (!started) {
      console.log(`${TAG}: E2S_OPEN start rejected: ${packageName}`)
      return
    }
    if (app.offlineRoute) {
      useNavigationStore.getState().push(app.offlineRoute, {transition: "fade"})
    }
    console.log(`${TAG}: E2S_OPEN opened ${packageName}`)
    scheduleUiMessages()
  })().catch((e) => console.log(`${TAG}: E2S_OPEN failed`, e))
}
