# Easy2See

Words you can see, *right when you need them.*

Easy2See turns speech into live captions and translation on your phone, and puts a teleprompter on supported display glasses such as Even G2. No account. Your content stays on your device.

[Website](https://easy2see.app/) •
[Support](https://easy2see.app/support/) •
[Privacy](https://easy2see.app/privacy/) •
[Source](https://github.com/audreyt/easy2see)

> **Status:** Easy2See's first App Store release is being prepared. It is not yet available to download.

## What Easy2See does

| Feature | What it does | Needs |
|---|---|---|
| Live captions | See what is being said as it is said, on your phone screen. | Works without glasses |
| Translation | Read speech translated into another language. | Works without glasses |
| Teleprompter | Load a script and read it hands-free on the glasses display. | Needs display glasses, such as Even G2 |
| Recorder | Record audio and export it as a WAV file when you choose to. | WAV export |
| Easy2Say | Conversation support that helps you reply, with AI cues on devices that support them. | AI cues need iOS 26+ and Apple Intelligence |

## Built to stay on your device

Captions, translation, teleprompter, Recorder WAV exports and Easy2Say conversation AI run locally. The developer does not receive your speech, transcripts, scripts or recordings.

There is no account to create, and Easy2See does not include app analytics or crash-reporting services. Read the [privacy policy](https://easy2see.app/privacy/) for the details.

## Requirements

- An iPhone that can run the app.
- Microphone and speech recognition access for captions and translation.
- Supported display glasses, such as Even G2, for the glasses teleprompter.
- iOS 26 or later with Apple Intelligence available, for AI cues.

## Setup

Captions and translation work on your phone alone: open Easy2See and choose "Set up without glasses", allow microphone and speech recognition access, prepare the language models you want to use, then choose captions or translation and start.

The teleprompter needs supported glasses with a display, such as Even G2. Mentra Live has no display and cannot show captions or teleprompter text. Pair the glasses in the app over Bluetooth; camera, photos and local network access are each optional and only needed for the feature that uses them.

Some language and speech models are downloaded to your phone before first use from Apple and GitHub hosting. Full steps and troubleshooting are on the [support page](https://easy2see.app/support/).

## Built on MentraOS

Easy2See is derived from [MentraOS](https://github.com/Mentra-Community/MentraOS), the open source operating system, app store and development framework for smart glasses, created by Mentra Labs, Inc. and the MentraOS contributors. Easy2See starts from their code and inherits the app, the glasses connection and the miniapp runtime from their work. Thank you to Mentra Labs and to every contributor.

MentraOS is released under the [Apache-2.0 license](https://github.com/Mentra-Community/MentraOS/blob/HEAD/LICENSE). [Source](https://github.com/Mentra-Community/MentraOS) and [contributors](https://github.com/Mentra-Community/MentraOS/graphs/contributors) are on GitHub. Easy2See is an independently modified fork. It is not affiliated with or endorsed by Mentra Labs, Inc.

## Why a fork

MentraOS is a general platform: the Mentra App runs miniapps on your phone and connects to Mentra's cloud services. This fork is narrower on purpose. It is an account-free, on-device variant that focuses on captions, translation, a teleprompter and local conversation AI.

It disables Mentra cloud sessions and telemetry, so your speech and transcripts stay on your phone. It is built for display glasses such as Even G2, and it also works with only your phone for captions, translation and review.

If you want the full platform, the miniapp store or Mentra's own glasses, use the Mentra App. Easy2See is maintained independently; send questions about it to [au@civic.ai](mailto:au@civic.ai), not to Mentra.

## This repository

This repo holds the Easy2See fork: the app in `mobile/`, the bundled on-device miniapps in `miniapps/` (captions, translation, teleprompter, conversate), and this product's website source in `cloud-v2/websites/easy2see/` (deployed to [easy2see.app](https://easy2see.app/)).

Upstream development happens at [Mentra-Community/MentraOS](https://github.com/Mentra-Community/MentraOS); this fork tracks its `dev` branch. Build and contribution guidance for the codebase lives in [AGENTS.md](./AGENTS.md).

## Support

Email [au@civic.ai](mailto:au@civic.ai?subject=Easy2See%20support) with your iPhone model, iOS version, and what you were doing when the problem happened. Please do not attach recordings or other sensitive content.

## License

Apache License 2.0. This fork's modifications are by Audrey Tang; the upstream MentraOS code is copyright Mentra Labs, Inc. and contributors.
