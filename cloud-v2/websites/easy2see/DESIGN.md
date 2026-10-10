# Easy2See site: design record

Three static pages (`/`, `/support/`, `/privacy/`) and one stylesheet (`assets/site.css`). No JavaScript, no framework, no analytics, no third-party requests. This file is not a served page; `.assetsignore` and the deploy step decide what ships.

## Direction

The user asked for an aesthetic that is completely compatible with the sibling `pi-ds4` guide and the wider pi.dev world, with color tone and fonts taken from the closer sibling `Easy2Say`. Priority order when the references disagree:

1. **Easy2Say wins on color and type.** Palette, font families, and light/dark values are copied exactly.
2. **pi-ds4 / pi.dev win on layout and restraint.** A letter on paper: one reading column, quiet mono letterhead, hairline rules, dotted links, nothing that moves, no cards, no pills, no hero graphic.
3. The old design (dark SaaS, pill nav, big "lens" graphic, rounded cards, mint accent) is removed entirely.

## Reference mapping

| Concern          | Source                         | What we take                                                                                                                                                                                |
| ---------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Palette (light)  | Easy2Say `docs/css/styles.css` | paper `#faf8f3`, shell `#f2efe8`, ink `#1c1718`, text `#2a2325`, plum `#4d2a33`, muted `#75685f`, stone `#b2a496`, border `#e5ddd2`, peach `#fadbc9`, coral `#f4a499`, coral-deep `#d97967` |
| Palette (dark)   | Easy2Say                       | paper `#1d1719`, shell `#211a1c`, ink `#f2ece4`, text `#cfc4ba`, muted `#97887d`, stone `#8a7d70`, border `#382e30`, peach `#d29a80`, coral `#f4a499`, coral-deep `#e58b78`                 |
| Body font        | Easy2Say                       | Newsreader (reading serif)                                                                                                                                                                  |
| Display font     | Easy2Say                       | DM Sans (headings, brand, feature names)                                                                                                                                                    |
| UI font          | Easy2Say                       | JetBrains Mono (letterhead, nav, labels, tags)                                                                                                                                              |
| Light/dark       | Easy2Say + pi-ds4              | `prefers-color-scheme` only; `color-scheme: light dark`; no toggle, so no JS                                                                                                                |
| Reading measure  | pi-ds4 (`--column: 46rem`)     | one column, 46rem, prose-first                                                                                                                                                              |
| Letterhead       | pi-ds4 / pi.dev                | small uppercase mono bar: mark, name, three links                                                                                                                                           |
| Links            | pi-ds4                         | inherit color, dotted underline, solid on hover                                                                                                                                             |
| Rules            | pi-ds4                         | 1px hairlines between sections; no boxes, no shadows                                                                                                                                        |
| Headline         | pi.dev + Easy2Say              | DM Sans headline with one italic Newsreader phrase in the accent (Easy2Say `h1 em`, pi.dev "yours")                                                                                         |
| Controls / tags  | pi.dev                         | mono caps in square brackets, e.g. `[ NEEDS DISPLAY GLASSES ]`                                                                                                                              |
| Selection, focus | pi-ds4 + Easy2Say              | ink-on-paper selection, 2px coral-deep focus ring                                                                                                                                           |

pi.dev itself (inspected in the browser) uses Plantin Now and Departure Mono with a blue accent and a faint grid. We deliberately do not copy those fonts or the blue: that would override the Easy2Say tone the user asked for.

## Tokens (all in `:root` of `assets/site.css`)

Color tokens above, plus: `--serif`, `--display`, `--mono` stacks; `--column: 46rem`; spacing scale `--s1..--s7` (0.25, 0.5, 1, 1.5, 2.5, 4, 6 rem); `--rule: 1px solid var(--border)`; sizes `--text-body` (clamp 1.0625 to 1.1875rem), `--text-ui` (0.72rem mono).

Text accent: `--accent` is plum in light and coral in dark. `--accent` in light is `#a9503f`, a darkened coral-deep (about 5:1 on paper). `--coral-deep` is used for decoration (underlines, markers, focus) because it does not reach 4.5:1 on paper.

## Fonts: self-hosted

Files in `assets/fonts/`, latin subset only, `font-display: swap`, same-origin, so no third-party font request is made.

| Family                      | File                                                      | Weights used | License                               |
| --------------------------- | --------------------------------------------------------- | ------------ | ------------------------------------- |
| Newsreader (variable, opsz) | `newsreader-latin.woff2`, `newsreader-italic-latin.woff2` | 400-500      | SIL OFL 1.1, `OFL-Newsreader.txt`     |
| DM Sans (variable, opsz)    | `dm-sans-latin.woff2`                                     | 500-700      | SIL OFL 1.1, `OFL-DM-Sans.txt`        |
| JetBrains Mono (variable)   | `jetbrains-mono-latin.woff2`                              | 400-500      | SIL OFL 1.1, `OFL-JetBrains-Mono.txt` |

Source: Google Fonts (download only; the site never contacts it). Easy2Say also loads justfont Lanyang for Traditional Chinese; this site is English-only, so it is not included.

## Page structure

- Letterhead: mark (the existing `easy2see-mark.svg`, recolored with a CSS mask so it reads on paper), `EASY2SEE`, nav (Home, Support, Privacy).
- Home: headline and lede, status note, feature list (rows, not cards), "stays on your device", "Built on MentraOS" credit, "Why this fork", questions.
- Support and Privacy: legal and help text unchanged, set as a letter.
- Footer (identical on all pages): author, upstream credit with GitHub and Apache-2.0 links, page links, email.

## Content rules

- Upstream license: Apache-2.0 (the default branch `dev` of MentraOS; links use `blob/HEAD/LICENSE`, not `main`, which still holds an older MIT copy).
- Credit Mentra, MentraOS and its contributors prominently on the home page and concisely in the footer, linking https://github.com/Mentra-Community/MentraOS and its Apache-2.0 license.
- Explain the fork: an account-free, on-device variant focused on captions, translation, teleprompter and local conversation AI; Mentra cloud sessions and telemetry are disabled so speech and transcripts stay on the phone; targets display glasses such as Even G2, with phone-only use supported.
- Describe the upstream platform respectfully and only with claims we can support; do not promise "no networking" (model downloads and update hosting remain, as the privacy page says).
- Mentra Live has no display and cannot show captions or teleprompter text.
- Support and privacy wording, domains and paths (`/support/`, `/privacy/`, canonical `easy2see.app`) are preserved.
