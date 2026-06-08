# Releasing

Bedevere Wise and bedevere-desktop release **in lockstep**: same version, same codename, same release date. The version string in `package.json` is **clean semver** (no codename suffix) so npm's `@latest` dist-tag works; the codename lives in the git tag, the CHANGELOG heading, and the user-visible About display.

## When to release

A release cuts when `dev-X.Y` (on both repos) has accumulated enough work for a public version bump. Cadence is feature-driven; calendar-based releases are not enforced.

A release does **not** require a desktop binary change — if only wise changed, the desktop's published 0.X.Y is functionally identical to 0.X.(Y-1) plus the new wise dependency. The version invariant is what matters; small overhead beats version-drift confusion.

## Lockstep version strings

Each release bumps **four** version strings, two per repo:

| Repo | File | Field | Format |
| --- | --- | --- | --- |
| bedevere-wise | `package.json` | `version` | `0.X.0` (npm-clean, no codename) |
| bedevere-wise | `src/main.ts` | `appVersion` | `0.X-codename` (user-visible display) |
| bedevere-desktop | `renderer/package.json` | `version` | `0.X.0` (matches wise) |
| bedevere-desktop | `CMakeLists.txt` | `project(... VERSION 0.X.0)` | `0.X.0` (matches wise) |

Plus two text bumps that always go with the four version strings:

- bedevere-wise `src/components/HelpPanel/aboutHtml.ts`: `"What's new in 0.X"` heading + bullet list (rewrite for the cycle's actual work)
- bedevere-wise `CHANGELOG.md`: prepend `## v0.X-codename` section with the release notes

## Codename theme

Monty Python — specifically the witch scene from *Monty Python and the Holy Grail*. Each release picks a line:

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

When in doubt, watch the scene and pick the next thing said.

## Release ritual

Done from the maintainer's machine. Assumes `dev-0.X` on both repos is feature-complete + tests green.

### 1. Pick the codename

Per the table above. Write it down — you'll type it ~10 times.

### 2. Wise: prep + tag + publish

```sh
cd bedevere-wise
git checkout dev-0.X && git pull

# Bump the strings (codename only on display + tag + changelog)
# - package.json `version` → "0.X.0"
# - src/main.ts `appVersion` → "0.X-codename"
# - src/components/HelpPanel/aboutHtml.ts heading + bullets
# - CHANGELOG.md prepend ## v0.X-codename

# Verify clean
bun x tsc --noEmit
bun run build:lib
npm pack --dry-run     # check tarball file list + size

# Commit + tag + merge
git add -A
git commit -m "Release v0.X-codename"
git tag -a "v0.X-codename" -m "v0.X-codename"

git checkout main
git merge --no-ff dev-0.X -m "Merge dev-0.X: release v0.X-codename"
git push origin main
git push origin "v0.X-codename"

# Publish to npm (prepublishOnly script rebuilds via bun run build:lib)
npm publish              # publishes as @latest because 0.X.0 is clean semver
```

After this, `npm view @caerbannogwhite/bedevere-wise dist-tags` should show `latest: 0.X.0`.

### 3. Desktop: bump wise pin + tag

```sh
cd ../kolistat/bedevere-desktop
git checkout dev-0.X && git pull

# Pin the wise dependency to the just-published version
# renderer/package.json:
#   "@caerbannogwhite/bedevere-wise": "0.X.0"
cd renderer && bun install     # locks the new pin into bun.lock
cd ..

# Verify the lockstep version strings already match (should already
# have been bumped to 0.X.0 when the cycle opened — see "Opening the
# next cycle" below)

# Build + smoke test
cmd /C "build-helper.bat"      # one-shot conan install
cmd /C "dev-helper.bat"        # build + stage DLLs
# launch the .exe, confirm renderer reads from the just-published
# wise version (not bun link) and the test query runs

# Commit + tag + merge
git add -A
git commit -m "Release v0.X-codename"
git tag -a "v0.X-codename" -m "v0.X-codename"

git checkout main
git merge --no-ff dev-0.X -m "Merge dev-0.X: release v0.X-codename"
git push origin main
git push origin "v0.X-codename"
```

### 4. Build + upload installers

Out of scope for this doc until Phase 3 packaging lands (see PROJECT_PLAN.md §7 in bedevere-desktop). When it does: the installer build + winget manifest + Homebrew cask + AppImage all carry `0.X.0` (the lockstep version).

### 5. Opening the next cycle

Immediately after merging the release to main:

```sh
# wise
cd bedevere-wise
git checkout main && git pull
git checkout -b dev-0.X+1

# bump the four version strings to 0.X+1.0 (codename can be a placeholder
# like "tbd" until the release picks one)
# - package.json `version` → "0.X+1.0"
# - src/main.ts `appVersion` → "0.X+1-tbd"
# - aboutHtml.ts heading → "What's new in 0.X+1" + empty bullet list
# - CHANGELOG.md: optional placeholder section

git add -A
git commit -m "Open dev-0.X+1"
git push -u origin dev-0.X+1

# desktop — same shape
cd ../kolistat/bedevere-desktop
git checkout main && git pull
git checkout -b dev-0.X+1

# bump
# - renderer/package.json `version` → "0.X+1.0"
# - CMakeLists.txt project VERSION → 0.X+1.0
# - renderer/package.json wise dep back to "next" (so dev tracks pre-release builds)

git add -A
git commit -m "Open dev-0.X+1"
git push -u origin dev-0.X+1
```

Per [[feedback-release-branches]] in memory: the moment a release is tagged + merged, `dev-X.Y` is closed. Post-release work goes on `dev-X.(Y+1)`.

## Versioning subtleties

- **npm version is clean semver**: `0.13.0`, not `0.13.0-i-am`. Anything after a `-` is a pre-release per semver, and npm refuses to assign `@latest` to pre-release versions automatically. Keeping the codename out of `package.json` means `npm publish` Just Works.
- **The codename is the release identity** for humans: git tag, CHANGELOG heading, About tab, blog post, GitHub Release page. All those carry `v0.X-codename`.
- **`@next` during active dev**: bedevere-desktop's renderer pins `@caerbannogwhite/bedevere-wise` to `"next"` while `dev-0.X` is in flight. Wise pre-release builds can be published via `npm publish --tag next` from a `dev-0.X` branch without affecting `@latest`. The release ritual above bumps the pin to the exact version `"0.X.0"` so the tagged desktop release is reproducible.
- **Patch releases**: same ritual, patch level only. Bump to `0.X.1` on both, codename stays the same (e.g. `v0.X.1-i-am` git tag if you want to be explicit, or just `v0.X.1` — both work, pick one).
- **Desktop-only fix between wise releases**: bump both repos' patch level. Wise's publish is essentially a no-op (same code, new version) but preserves the version invariant. For now this is rare and tolerable; if it becomes frequent, revisit the lockstep model.

## Anti-patterns

- Don't commit post-release features to the just-shipped `dev-0.X` branch. Branch `dev-0.X+1` immediately on merge.
- Don't put the codename in `package.json` `version`. It breaks `npm publish` `@latest` promotion.
- Don't release wise without releasing desktop, or vice versa. Lockstep means lockstep — even if one side has no changes, bump and re-publish.
- Don't tag without merging to main. Tags should always point to commits reachable from `main`.
- Don't `git push --force` on `main` or any `dev-X.Y` after it's been pushed. Other tooling (npm publish, installer pipelines, CHANGELOG diffs) assumes those refs are stable.
