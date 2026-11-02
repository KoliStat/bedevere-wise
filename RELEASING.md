# Releasing

bedevere wise and bedevere desktop release **in lockstep**: same version, same codename, same release date. The version string in `package.json` is **clean semver** (no codename suffix) so npm's `@latest` dist-tag works; the codename lives in the git tag, the CHANGELOG heading, and the user-visible About display.

## When to release

A release cuts when `dev-X.Y` (on both repos) has accumulated enough work for a public version bump. Cadence is feature-driven; calendar-based releases are not enforced.

A release does **not** require a desktop binary change — if only wise changed, the desktop's published 0.X.Y is functionally identical to 0.X.(Y-1) plus the new wise dependency. The version invariant is what matters; small overhead beats version-drift confusion.

## Lockstep version strings

Each release bumps **five** version strings:

| Repo | File | Field | Format |
| --- | --- | --- | --- |
| bedevere-wise | `package.json` | `version` | `0.X.0` (npm-clean, no codename) |
| bedevere-wise | `src/version.ts` | `APP_VERSION` | `0.X-codename` (shown in the status bar, the About tab and `/about`) |
| bedevere-desktop | `renderer/package.json` | `version` | `0.X.0` (matches wise) |
| bedevere-desktop | `CMakeLists.txt` | `project(... VERSION 0.X.0)` | `0.X.0` (matches wise) |
| bedevere-desktop | `package-helper.bat` | `VERSION` | `0.X.0` (names the installer file) |

Text updates that go with them:

- bedevere-wise `src/components/HelpPanel/aboutHtml.ts`: the `"What's new in 0.X"` heading and bullet list, rewritten for the cycle's work. A test fails when the heading does not match `APP_VERSION`.
- bedevere-wise `CHANGELOG.md`: rename `## Unreleased` to `## v0.X-codename`. Check that every user-facing change of the cycle has an entry: `git log --no-merges v<previous tag>..dev-0.X`.
- bedevere-desktop `THIRD-PARTY-NOTICES.txt`: the versions of the bundled components, and the release named in the header.
- If `@duckdb/duckdb-wasm` changed during the cycle, the stats_duck file under `public/extensions/stats-duck/<duckdb version>/` must be built for the new DuckDB version. A file built for another version does not load, and `VISUALIZE` stops working.

## Codename theme

Monty Python: the opening scene of *Monty Python and the Holy Grail*, at the castle, where Arthur and Patsy arrive with the coconuts. Each release takes the next line:

| Released | Codename |
| --- | --- |
| 0.1 | `arthur` |
| 0.2 | `whoa-there` |
| 0.3 | `guard` |
| 0.4 | `halt` |
| 0.5 | `who-goes-there` |
| 0.6 | `it-is-i` |
| 0.7 | `son-of-uther-pendragon` |
| 0.8 | `from-the-castle-of-camelot` |
| 0.9 | `king-of-the-britons` |
| 0.10 | `defeator-of-the-saxons` |
| 0.11 | `sovereign-of-all-england` |
| 0.12 | `pull-the-other-one` |
| 0.13 | `i-am` |
| 0.14 | `and-this` |
| 0.15 | `my-trusty-servant` |
| 0.16 | `patsy` |

When in doubt, watch the scene and pick the next thing said.

## Release ritual

Done from the maintainer's machine. Assumes `dev-0.X` on both repos is feature-complete and CI is green.

### 1. Pick the codename

Per the table above. Write it down — you'll type it ~10 times.

### 2. Release prep on `dev-0.X`

Open one pull request per repo into `dev-0.X` with the version strings and text updates above. Before merging the wise one, run:

```sh
bunx vitest run
bun run notices:check
bun run build          # type checks, production build, output check
bun run build:lib
```

The desktop pull request's CI builds the exe and the installer.

### 3. Wise: merge to main, tag, publish

1. Open a pull request from `dev-0.X` to `main` and merge it with a merge commit.
2. Tag the merge commit and push the tag:

   ```sh
   git checkout main && git pull
   git tag -a "v0.X-codename" -m "v0.X-codename"
   git push origin "v0.X-codename"
   ```

3. Publish from `main`. `prepublishOnly` rebuilds the library, and `npm publish` needs the maintainer's npm login:

   ```sh
   npm publish                                         # lands as @latest
   npm dist-tag add @kolistat/bedevere-wise@0.X.0 next
   ```

   `npm view @kolistat/bedevere-wise dist-tags` should then show `latest` and `next` at `0.X.0`.

The web app deploys by itself when `main` changes (`.github/workflows/deploy.yml`).

### 4. Desktop: pin wise, merge to main, tag

Merge the wise release first. The desktop CI builds the renderer against the wise branch with the same name, so the desktop release pull request builds against wise `main`.

1. On `dev-0.X`, pin the renderer to the published version, and update the lockfile:

   ```sh
   # renderer/package.json:  "@kolistat/bedevere-wise": "0.X.0"
   cd renderer && bun install
   ```

2. Open a pull request from `dev-0.X` to `main`, and merge it with a merge commit once CI is green.
3. Tag the merge commit `v0.X-codename` and push the tag, as in step 3.

### 5. Publish the desktop installer

1. Take `bedevere-wise-0.X.0-setup.exe` from the `bedevere-wise-setup` artifact of the `main` build.
2. In KoliStat/bedevere-desktop-releases, draft a pre-release `v0.X.0-beta`. Upload the installer as `Bedevere-Desktop-0.X.0-win-x64-setup.exe` and put its SHA-256 in the release text. Update `README.md`, `CHANGELOG.md`, `LICENSE.txt` (the EULA, ASCII only) and `THIRD-PARTY-NOTICES.txt` on a branch.
3. Install the exact uploaded file and smoke-test it. Then merge the docs and publish the draft.
4. Point the installer link on kolistat.com (`products/bedevere.html`) at the new file.

### 6. Close the cycle

1. Review the `0.X` milestone in both repos. Close the issues that shipped: GitHub does not close an issue when the pull request that fixed it targeted `dev-0.X`, not `main`. Move the rest to the next milestone, then close `0.X`.
2. Open the next cycle, wise first, because the desktop CI looks for the wise branch with the same name:

   ```sh
   # in bedevere-wise, then in bedevere-desktop
   git checkout main && git pull
   git checkout -b dev-0.X+1
   git push -u origin dev-0.X+1
   ```

   The version strings stay at the shipped values until the next release prep. In bedevere-desktop, set the renderer's wise dependency back to `"next"`.

Per [[feedback-release-branches]] in memory: the moment a release is tagged + merged, `dev-X.Y` is closed. Post-release work goes on `dev-X.(Y+1)`.

## Versioning subtleties

- **npm version is clean semver**: `0.13.0`, not `0.13.0-i-am`. Anything after a `-` is a pre-release per semver, and npm refuses to assign `@latest` to pre-release versions automatically. Keeping the codename out of `package.json` means `npm publish` Just Works.
- **The codename is the release identity** for humans: git tag, CHANGELOG heading, About tab, blog post, GitHub Release page. All those carry `v0.X-codename`.
- **Releases publish from `main` only**: every `npm publish` runs from `main`, after the `dev-0.X` → `main` merge (step 3 above) — never from a `dev-0.X` branch. Publishing a clean `0.X.0` from a dev branch consumes the release version number before the real release ships (it happened once with `0.13.0` — the recovery was to release as `0.13.1`). During active dev the desktop renderer tracks wise through a local `bun link` (see `renderer/README.md`) rather than a published `@next` build, and the desktop CI builds wise from source. The release ritual then pins the renderer to the exact published version so the tagged desktop release is reproducible. Keep `@next` aligned to the latest published release (`npm dist-tag add @kolistat/bedevere-wise@0.X.Y next`) so it never points at stale bytes.
- **Patch releases**: same ritual, patch level only. Bump `package.json` to `0.X.1` on both; the **git tag stays `v0.X-codename`** to match the tag series — the patch level lives only in `package.json`, never in the tag. `v0.13` shipped exactly this way: npm `0.13.1` (because `0.13.0` was burned by the premature publish), git tag `v0.13-i-am`.
- **Desktop-only fix between wise releases**: bump both repos' patch level. Wise's publish is essentially a no-op (same code, new version) but preserves the version invariant. For now this is rare and tolerable; if it becomes frequent, revisit the lockstep model.

## Anti-patterns

- Don't commit post-release features to the just-shipped `dev-0.X` branch. Branch `dev-0.X+1` immediately on merge.
- Don't put the codename in `package.json` `version`. It breaks `npm publish` `@latest` promotion.
- Don't `npm publish` from a `dev-X.Y` branch — releases publish from `main` only (see Versioning subtleties). Pre-release publishing to `@next` from dev is what burned `0.13.0`.
- Don't release wise without releasing desktop, or vice versa. Lockstep means lockstep — even if one side has no changes, bump and re-publish.
- Don't tag without merging to main. Tags should always point to commits reachable from `main`.
- Don't `git push --force` on `main` or any `dev-X.Y` after it's been pushed. Other tooling (npm publish, installer pipelines, CHANGELOG diffs) assumes those refs are stable.
