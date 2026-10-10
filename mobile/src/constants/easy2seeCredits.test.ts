import {readFileSync} from "fs"
import {join} from "path"

import {MENTRAOS_COPYRIGHT} from "./easy2seeCredits"
import {MENTRAOS_LICENSE} from "./mentraosLicense"

describe("Easy2See credits", () => {
  const repositoryLicense = readFileSync(join(__dirname, "../../../LICENSE"), "utf8")

  it("ships the repository's license text verbatim", () => {
    expect(MENTRAOS_LICENSE).toBe(repositoryLicense)
  })

  it("names the copyright holder the repository names", () => {
    expect(readFileSync(join(__dirname, "../../../README.md"), "utf8")).toContain(MENTRAOS_COPYRIGHT)
  })
})
