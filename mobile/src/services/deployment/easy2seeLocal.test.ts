/**
 * Easy2See local-mode deployment: the packaged `extra.easy2see` flag selects
 * the account-free manifest, the schema accepts it, and a fresh
 * DeploymentStore treats it as resolved (no Mentra-vs-workspace selector).
 */
jest.mock("expo-constants", () => ({
	__esModule: true,
	default: { expoConfig: { extra: { easy2see: true } } },
}));

import { createConsumerDeployment } from "./officialManifest";
import { deploymentManifestSchema } from "./schema";
import { type DeploymentStorage, DeploymentStore } from "./store";

const emptyStorage: DeploymentStorage = {
	load: () => null,
	save: () => {},
	remove: () => {},
};

describe("Easy2See local deployment", () => {
	it("selects the local manifest when extra.easy2see is packaged", () => {
		const deployment = createConsumerDeployment();
		expect(deployment.kind).toBe("consumer");
		expect(deployment.manifest.auth).toEqual({ mode: "local" });
		expect(deployment.manifest.services).toEqual({
			coreUrl: null,
			runtimeUrl: null,
		});
		expect(deployment.manifest.telemetry).toBe(false);
		expect(deployment.manifest.features).toEqual({
			runtimeRealtimeSession: false,
			managedStreams: false,
			nativeMeetings: false,
			cloudSpeech: false,
			onDeviceSpeech: true,
			navigation: false,
		});
		expect(deployment.manifest.content.wallpaperUrls).toEqual([]);
		expect(deployment.manifest.artifacts.mentraLiveOtaManifestUrl)
			.toBeNull();
	});

	it("passes manifest schema validation", () => {
		const parsed = deploymentManifestSchema.safeParse(
			createConsumerDeployment().manifest,
		);
		expect(parsed.success).toBe(true);
	});

	it("uses Easy2See's published privacy and support pages", () => {
		const links = createConsumerDeployment().manifest.links;
		expect(links.privacyPolicyUrl).toBe("https://easy2see.app/privacy/");
		expect(links.supportUrl).toBe("https://easy2see.app/support/");
		expect(links.termsOfServiceUrl).toBe(
			"https://www.apple.com/legal/internet-services/itunes/dev/stdeula/",
		);
	});

	it("allowlists only miniapps that work without the cloud", () => {
		const allowlist = createConsumerDeployment().manifest.systemMiniapps
			.approvedPackageNamesOverride;
		expect(allowlist).toEqual(
			expect.arrayContaining([
				"com.mentra.captions",
				"com.mentra.translation",
				"com.mentra.teleprompter",
			]),
		);
		// Cloud-only tiles must not ship: they would render broken without Core.
		// (Captions is on-device in this fork, so it is allowlisted above.)
		for (
			const cloudOnly of [
				"com.mentra.ai",
				"com.mentra.call",
				"com.mentra.livestreamer",
				"com.mentra.navigation",
				"com.mentra.merge",
				"com.mentra.notes",
				"com.mentra.feedback",
				"com.mentra.miniappdev",
				"com.mentra.simulated",
			]
		) {
			expect(allowlist).not.toContain(cloudOnly);
		}
	});

	it("is resolved on a fresh install — no selector, no /auth/start", () => {
		const store = new DeploymentStore(emptyStorage);
		expect(store.isResolved()).toBe(true);
		expect(store.isTelemetryAllowed()).toBe(false);
	});

	it("stays resolved even through a selection clear", async () => {
		const store = new DeploymentStore(emptyStorage);
		await store.clearSelection();
		expect(store.isResolved()).toBe(true);
		expect(store.getActive().manifest.auth.mode).toBe("local");
	});
});
