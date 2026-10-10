import {ConfigPlugin, withAppDelegate, withInfoPlist} from "@expo/config-plugins"

/**
 * UIScene lifecycle adoption for the iOS app.
 *
 * Built against the iOS 26 SDK (Xcode 26/27), UIKit refuses to finish launching
 * an app that still drives a single `UIWindow` from the app delegate:
 *
 *   _UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption ...
 *   Application failed to launch: UIScene life cycle
 *
 * The process traps (EXC_BREAKPOINT) a few frames after `didFinishLaunching`,
 * so the app cannot run on any iOS 26+ simulator or device. Expo SDK 55 and
 * React Native 0.83 still generate the pre-scene AppDelegate and ship no scene
 * delegate of their own, so the adoption lives here.
 *
 * The scene delegate owns the window and starts React Native when the scene
 * connects. Deep links move with it: UIKit stops calling
 * `application(_:open:options:)` and `application(_:continue:)` once scenes are
 * adopted, so the scene callbacks forward back into the app delegate chain that
 * `RCTLinkingManager` and the Expo subscribers already use — otherwise the
 * `com.mentra` URL scheme and universal links silently stop working.
 */

const MARKER_BEGIN = "// @generated begin ios-scene-lifecycle"
const MARKER_END = "// @generated end ios-scene-lifecycle"

const SCENE_DELEGATE = `
${MARKER_BEGIN} (DO NOT MODIFY — plugins/ios-scene-lifecycle.ts)
/// UIKit creates one of these per window scene. The app delegate still owns the
/// React Native factory; the scene owns the window it renders into.
class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let windowScene = scene as? UIWindowScene else { return }
    guard let appDelegate = UIApplication.shared.delegate as? AppDelegate,
          let factory = appDelegate.reactNativeFactory else {
      return
    }

    let window = UIWindow(windowScene: windowScene)
    self.window = window
    // Anything still reading UIApplication.shared.delegate?.window — including
    // the splash screen — must see the scene's window, not a detached one.
    appDelegate.window = window

    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: nil)

    for context in connectionOptions.urlContexts {
      forward(url: context.url)
    }
    for userActivity in connectionOptions.userActivities {
      forward(userActivity: userActivity)
    }
  }

  func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    for context in URLContexts {
      forward(url: context.url)
    }
  }

  func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    forward(userActivity: userActivity)
  }

  private func forward(url: URL) {
    _ = UIApplication.shared.delegate?.application?(UIApplication.shared, open: url, options: [:])
  }

  private func forward(userActivity: NSUserActivity) {
    _ = UIApplication.shared.delegate?.application?(
      UIApplication.shared,
      continue: userActivity,
      restorationHandler: {_ in})
  }
}
${MARKER_END}
`

/** `window = UIWindow(frame: UIScreen.main.bounds)` — the scene creates it now. */
const WINDOW_LINE = /^[ \t]*window = UIWindow\(frame: UIScreen\.main\.bounds\)\n/m

/** The launch-time `factory.startReactNative(...)` call — the scene makes it now. */
const START_REACT_NATIVE = /^[ \t]*factory\.startReactNative\(\n(?:[ \t]*.*\n)*?[ \t]*launchOptions: launchOptions\)\n/m

/** Replaces that call, and marks the file as already adopted on a re-run. */
const START_COMMENT = "// React Native starts in SceneDelegate.scene(_:willConnectTo:options:)."

const withIosSceneLifecycle: ConfigPlugin = (config) => {
  config = withInfoPlist(config, (cfg) => {
    cfg.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          {
            UISceneConfigurationName: "Default Configuration",
            UISceneDelegateClassName: "$(PRODUCT_MODULE_NAME).SceneDelegate",
          },
        ],
      },
    }
    return cfg
  })

  return withAppDelegate(config, (cfg) => {
    if (cfg.modResults.language !== "swift") {
      throw new Error(`[ios-scene-lifecycle] expected a Swift AppDelegate, got ${cfg.modResults.language}`)
    }
    let contents = cfg.modResults.contents

    if (contents.includes(MARKER_BEGIN)) {
      const re = new RegExp(`\\n?${MARKER_BEGIN}[\\s\\S]*?${MARKER_END}\\n?`, "g")
      contents = contents.replace(re, "\n")
    }

    // `expo prebuild` without `--clean` feeds the already-transformed file back
    // through this mod, so both anchors are legitimately absent on a re-run.
    const hasWindow = WINDOW_LINE.test(contents)
    const hasStart = START_REACT_NATIVE.test(contents)
    const alreadyAdopted = contents.includes(START_COMMENT)

    if (!hasWindow && !alreadyAdopted) {
      throw new Error("[ios-scene-lifecycle] no `window = UIWindow(frame: UIScreen.main.bounds)` in AppDelegate")
    }
    if (!hasStart && !alreadyAdopted) {
      throw new Error("[ios-scene-lifecycle] no launch-time `factory.startReactNative(...)` in AppDelegate")
    }

    // The Firebase plugin writes its own generated block between these two, so
    // remove them individually rather than replacing the span.
    if (hasWindow) {
      contents = contents.replace(WINDOW_LINE, "")
    }
    if (hasStart) {
      contents = contents.replace(START_REACT_NATIVE, `    ${START_COMMENT}\n`)
    }

    if (!/^import UIKit$/m.test(contents)) {
      contents = contents.replace(/^import React$/m, "import React\nimport UIKit")
    }

    return {...cfg, modResults: {...cfg.modResults, contents: `${contents.trimEnd()}\n${SCENE_DELEGATE}`}}
  })
}

export default withIosSceneLifecycle
