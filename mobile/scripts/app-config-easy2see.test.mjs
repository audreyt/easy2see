import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

test("Easy2See resolves production configuration without a navigation token", () => {
	const config = JSON.parse(
		execFileSync("bun", ["expo", "config", "--json"], {
			encoding: "utf8",
			env: {
				...process.env,
				EASY2SEE: "1",
				NODE_ENV: "production",
				EXPO_NO_TELEMETRY: "1",
				EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN: "",
			},
			maxBuffer: 16 * 1024 * 1024,
		}),
	);
	assert.equal(config.extra.easy2see, true);
	assert.equal(config.ios.bundleIdentifier, "org.audreyt.easy2see");
});
