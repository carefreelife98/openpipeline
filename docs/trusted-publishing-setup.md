# npm Trusted Publishing setup (one-time, per package)

This is a **one-time** manual setup a maintainer performs in the npm web UI for
each of the 9 `@openpipeline/*` packages. Once done, `.github/workflows/release.yml`
can publish new versions with zero npm tokens, zero secrets, and zero manual OTP
entry — GitHub Actions and npm authenticate each other via OIDC.

Reference: [Trusted publishing for npm packages](https://docs.npmjs.com/trusted-publishers)
(npm Docs, accessed 2026-07-27).

## Prerequisites

- You must already be an **owner** (not just a maintainer/collaborator) of each
  `@openpipeline/*` package on npmjs.com to change its Trusted Publisher config.
- `.github/workflows/release.yml` must already be committed to `main` under
  exactly that path/filename — the workflow filename you register below must
  match the real file byte-for-byte in name, or the OIDC exchange is rejected.
- This only needs to be done **once per package**. It does not need to be
  repeated per release, per tag, or when the package version bumps.

## The 9 packages

Repeat the steps below for each of:

1. `@openpipeline/core`
2. `@openpipeline/nodes`
3. `@openpipeline/planner`
4. `@openpipeline/mcp`
5. `@openpipeline/store-memory`
6. `@openpipeline/store-prisma`
7. `@openpipeline/react`
8. `@openpipeline/runtime`
9. `@openpipeline/server`

> If a package has never been published before (first-ever publish), npm still
> lets you configure a Trusted Publisher up front for the *scoped package
> name* — you do not need an existing version on the registry first. If you
> hit a wall doing this for a brand-new package, publish v0 once manually
> (see the "Fallback: manual publish" section of `RELEASING.md`) and then
> configure Trusted Publishing for all subsequent releases.

## Steps (per package)

1. Go to `https://www.npmjs.com/package/<package-name>` (e.g.
   `https://www.npmjs.com/package/@openpipeline/core`), signed in as an owner.
2. Open **Settings** (top-right of the package page).
3. Find the **Trusted Publisher** section.
4. Click **Add trusted publisher** (or **Configure**) and choose
   **GitHub Actions** as the provider.
5. Fill in the fields **exactly** (all fields are case-sensitive):

   | Field | Value |
   |---|---|
   | Organization or user | `carefreelife98` |
   | Repository | `openpipeline` |
   | Workflow filename | `release.yml` |
   | Environment name | *(leave blank)* |
   | Allowed actions | Check **`npm publish`** only. Leave `npm stage publish` **unchecked**. |

   Leave **Environment name** blank unless you have deliberately added a
   [GitHub Environment](https://docs.github.com/en/actions/deployment/targeting-different-environments/using-environments-for-deployment)
   to the `publish` job in `release.yml` (`environment: <name>` under
   `jobs.publish`) — if you do that later, the environment name here must
   match the workflow's `environment:` value exactly, or publishing will be
   rejected. `release.yml` does not set one by default (see the comment
   above `jobs.publish` in the workflow).

   **Allowed actions is required** — npm's form will not save with zero
   boxes checked ("At least one must be selected"). `release.yml` only ever
   runs `npm publish "$tarball"` (never `npm stage publish`), so check only
   `npm publish`; leaving `npm stage publish` checked as well grants a
   publish capability this pipeline never uses and doesn't need.
6. Save.
7. Repeat for the remaining 8 packages. (npm's UI as of this writing does not
   offer a bulk-apply action across scoped packages in one form submission —
   each package's Trusted Publisher entry must be added individually. If npm
   later ships bulk configuration for trusted publishers, prefer it — but
   still verify each package's entry individually per the checklist below.)

## Verification

After configuring all 9 packages:

1. On each package's Settings page, confirm the Trusted Publisher section now
   shows:
   - Provider: GitHub Actions
   - `carefreelife98/openpipeline`
   - Workflow: `release.yml`
   - Environment: *(blank, unless intentionally set)*
   - Allowed actions: `npm publish` checked, `npm stage publish`
     **unchecked**. A blank/unset value here is not possible (npm requires
     at least one), so specifically confirm it's `npm publish` and not the
     stage variant left checked by mistake.
2. Confirm `.github/workflows/release.yml` on `main` has, at minimum:
   ```yaml
   permissions:
     id-token: write
     contents: read
   ```
   at the workflow level (or on the `publish` job) — without `id-token:
   write`, GitHub Actions cannot mint the OIDC token npm needs, and the
   publish step will fail with an authentication error even though Trusted
   Publishing is configured correctly on the npm side.
3. Do a real end-to-end test with a throwaway pre-release tag once, before
   relying on this for a real release:
   - Bump all 9 `packages/*/package.json` versions to something like
     `0.2.1-tp-test.0` (lockstep).
   - Commit, tag `v0.2.1-tp-test.0`, push the tag.
   - Watch the `release.yml` run in the Actions tab: `verify-gate` should go
     green, then `publish` should complete with no auth errors and no
     prompts.
   - Confirm on npmjs.com that each package shows a **Provenance** badge on
     the new version (provenance is generated automatically by trusted
     publishing — see `RELEASING.md`).
   - `npm deprecate @openpipeline/core@0.2.1-tp-test.0 "trusted-publishing smoke test, ignore"`
     (repeat per package) so the throwaway version doesn't look like a real
     release to consumers. Do **not** `npm unpublish` — npm restricts
     unpublish to a short window and it can break other people's installs if
     anyone already resolved the version.
4. If the workflow fails at the `npm publish` step with something like
   `403 Forbidden - you do not have permission to publish` or an OIDC/audience
   error, re-check (in order): the workflow filename matches `release.yml`
   exactly, the org/repo matches `carefreelife98/openpipeline` exactly, and
   the environment name matches (blank vs blank, or set vs set with the exact
   same string).

## After Trusted Publishing is configured: revoke old tokens

Once all 9 packages have a working Trusted Publisher and step 3's smoke test
has gone green:

1. Go to `https://www.npmjs.com/settings/<your-username>/tokens` (Access
   Tokens).
2. Identify any **granular access tokens** (or classic automation tokens)
   that were previously used to publish `@openpipeline/*` packages from CI
   or by hand.
3. **Revoke** those tokens. Trusted Publishing replaces the need for them for
   the publish flow in `release.yml`; keeping unused long-lived publish
   tokens around is unnecessary standing risk (a leaked token has no
   expiry-by-default and no repo/workflow scoping, unlike the OIDC exchange).
4. Keep the manual-publish fallback in mind (`RELEASING.md`, "Fallback:
   manual publish" section) — if that path is ever needed again, a maintainer
   authenticates interactively (`npm login` / OTP) at publish time rather
   than relying on a stored token, so revoking stored tokens does not break
   the fallback.

## Troubleshooting

- **"Trusted publisher" option does not appear in package Settings** — the
  npm CLI/account may not yet have this feature enabled, or you are not an
  owner of the package. Confirm ownership with `npm owner ls <package-name>`.
- **Workflow runs but `npm publish` still asks for/fails auth** — check the
  npm CLI version actually used in the run's logs. `release.yml` runs `npm
  install -g npm@^11.5.1` before publishing specifically because trusted
  publishing requires **npm CLI ≥11.5.1** and **Node ≥22.14.0**
  ([docs.npmjs.com/trusted-publishers](https://docs.npmjs.com/trusted-publishers)) —
  Node 22's bundled npm is 10.x, which does not support the OIDC exchange at
  all and will fall back to demanding a classic token.
- **Publish succeeds for some packages but 404s for others** — almost always
  a dependency-order problem: a package that depends on another
  `@openpipeline/*` package published *before* its dependency exists on the
  registry. `release.yml`'s `publish` job hard-codes the leaf-first order
  (`core → nodes → mcp → store-memory → store-prisma → react → runtime →
  server`) for this reason; do not reorder it without re-checking the
  `@openpipeline/*` dependency graph in each `packages/*/package.json`.
