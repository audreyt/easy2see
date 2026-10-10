import Constants from "expo-constants";

import {
	APP_STORE_REVIEW_URL,
	APP_STORE_URL,
	PLAY_STORE_URL,
} from "@/constants/appConfig";

import { packagedOtaPin } from "./packagedOtaPin";
import type { ConsumerDeployment, DeploymentManifest } from "./types";

/** Embedded defaults. Expo inlines these environment reads into each build. */
export function createOfficialManifest(): DeploymentManifest {
	return {
		schemaVersion: 1,
		deploymentId: "mentra-official",
		displayName: "Mentra",
		services: {
			coreUrl: process.env.EXPO_PUBLIC_CLOUD_CORE_URL?.trim() ||
				"https://core.dev.us-west-2.mentraglass.com",
			runtimeUrl: process.env.EXPO_PUBLIC_CLOUD_RUNTIME_URL?.trim() ||
				"https://runtime.dev.us-west-2.mentraglass.com",
		},
		auth: { mode: "mentra-account" },
		artifacts: {
			mentraLiveOtaManifestUrl: packagedOtaPin(
				Constants.expoConfig?.extra,
				process.env.EXPO_PUBLIC_ASG_OTA_VERSION_URL,
			),
			sttModelBaseUrl: null,
			ttsModelBaseUrl: null,
		},
		appUpdates: {
			mode: "store",
			storeUrls: { android: PLAY_STORE_URL, ios: APP_STORE_URL },
			reviewUrls: { android: PLAY_STORE_URL, ios: APP_STORE_REVIEW_URL },
		},
		content: {
			wallpaperUrls: [
				"https://mentra-wallpapers.mentraglass.com/landscape1.jpeg",
				"https://mentra-wallpapers.mentraglass.com/landscape2.jpeg",
				"https://mentra-wallpapers.mentraglass.com/landscape3.jpeg",
				"https://mentra-wallpapers.mentraglass.com/trees.jpg",
				"https://mentra-wallpapers.mentraglass.com/clouds.jpeg",
				"https://mentra-wallpapers.mentraglass.com/firewatch.jpg",
			],
		},
		links: {
			privacyPolicyUrl: "https://mentraglass.com/privacy-policy",
			termsOfServiceUrl: "https://mentraglass.com/terms-of-service",
			documentationUrl: "https://docs.mentraglass.com",
			supportUrl: null,
		},
		systemMiniapps: { approvedPackageNamesOverride: null },
		miniapps: { managed: [], configuration: {} },
		glasses: { allowedModelsOverride: null },
		features: {
			runtimeRealtimeSession: true,
			managedStreams: true,
			nativeMeetings: true,
			cloudSpeech: true,
			onDeviceSpeech: true,
			navigation: process.env.EXPO_PUBLIC_DEPLOYMENT_REGION !== "china",
		},
		telemetry: true,
	};
}

/**
 * True only in the Easy2See build variant (mobile/app.config.ts sets
 * `extra.easy2see` when EASY2SEE=1). Same packaged-config channel as
 * packagedOtaPin: the value ships inside the bundle, so a sideloaded or
 * re-signed binary cannot flip a stock Mentra install into local mode.
 */
export function isEasy2SeeBuild(
	extra: Record<string, unknown> | undefined = Constants.expoConfig?.extra,
): boolean {
	return extra?.easy2see === true;
}

/**
 * Easy2See's embedded deployment: a fully local, account-free profile. There
 * is no Mentra sign-in (auth.mode "local"), no Core/Runtime endpoints, no
 * cloud speech or realtime session, no telemetry, and no remote wallpapers.
 * The miniapp allowlist keeps only what works without the cloud:
 *   - com.mentra.translation — forceLocal zh-TW via the on-device Apple
 *     Speech + Translation pipeline (LocalTranslationPipeline.swift).
 *   - com.mentra.teleprompter — forceLocal Sherpa on-device STT with a
 *     timed-scroll fallback; never touches the cloud.
 *   - com.mentra.recorder — records glasses audio locally; its cloud
 *     transcription subscribe is wrapped in try/catch and simply yields no
 *     transcript offline.
 *   - com.mentra.captions — ported to on-device only: every subscription is
 *     {forceLocal, engine:"auto"}, the language list is restricted to locally
 *     runnable locales, speaker labels are dropped (no on-device diarizer),
 *     and a stall watchdog surfaces a visible hint instead of a blank screen.
 *   - org.audreyt.conversate — live transcript + AI cues + post-conversation
 *     review, entirely on-device: Apple Speech for transcription and Apple
 *     Foundation Models (session.llm) for cues and summaries.
 *   - com.mentra.camera / com.mentra.mirror / com.mentra.settings — host
 *     offline apps (gallery, screen mirror, settings); no cloud calls.
 *   - cloud.augmentos.notify — notification mirroring is a local phone→
 *     glasses path (hidden on iOS unless enabled in settings).
 * Excluded as cloud-only or broken without Core: com.mentra.ai (cloud LLM),
 * com.mentra.call (VoIP), com.mentra.livestreamer (RTMP ingest),
 * com.mentra.navigation (Mapbox tiles + cloud routing), com.mentra.merge and
 * com.mentra.notes (default cloud STT / cloud ingest),
 * com.mentra.feedback (submits reports to Core), com.mentra.miniappdev and
 * com.mentra.simulated (developer tooling).
 */
export function createEasy2SeeManifest(): DeploymentManifest {
	return {
		schemaVersion: 1,
		deploymentId: "easy2see-local",
		displayName: "Easy2See",
		services: { coreUrl: null, runtimeUrl: null },
		auth: { mode: "local" },
		artifacts: {
			mentraLiveOtaManifestUrl: null,
			sttModelBaseUrl: null,
			ttsModelBaseUrl: null,
		},
		appUpdates: {
			mode: "store",
			storeUrls: { android: null, ios: null },
			reviewUrls: { android: null, ios: null },
		},
		content: { wallpaperUrls: [] },
		links: {
			privacyPolicyUrl: "https://easy2see.app/privacy/",
			termsOfServiceUrl:
				"https://www.apple.com/legal/internet-services/itunes/dev/stdeula/",
			documentationUrl: null,
			supportUrl: "https://easy2see.app/support/",
		},
		systemMiniapps: {
			approvedPackageNamesOverride: [
				"com.mentra.camera",
				"com.mentra.mirror",
				"com.mentra.settings",
				"cloud.augmentos.notify",
				"com.mentra.translation",
				"com.mentra.teleprompter",
				"com.mentra.recorder",
				"com.mentra.captions",
				"org.audreyt.conversate",
			],
		},
		miniapps: { managed: [], configuration: {} },
		glasses: { allowedModelsOverride: null },
		features: {
			runtimeRealtimeSession: false,
			managedStreams: false,
			nativeMeetings: false,
			cloudSpeech: false,
			onDeviceSpeech: true,
			navigation: false,
		},
		telemetry: false,
	};
}

export function createConsumerDeployment(): ConsumerDeployment {
	return {
		kind: "consumer",
		source: "embedded",
		manifest: isEasy2SeeBuild()
			? createEasy2SeeManifest()
			: createOfficialManifest(),
	};
}
