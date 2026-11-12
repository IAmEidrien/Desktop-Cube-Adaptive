<!-- SPDX-FileCopyrightText: Eidrien -->
<!-- SPDX-License-Identifier: CC-BY-4.0 -->

# Desktop Cube Adaptive

Credit fork changes to Eidrien (GitHub: IAmEidrien). Preserve upstream authorship
and licenses. Do not use a ChatGPT profile name in files, commits or metadata.

Develop and publish candidates on `testing`; `main` is the release branch.
See TESTING-WORKFLOW.md. Never bypass a paused or failed promotion.

This is a real fork of Schneegans/Desktop-Cube, with upstream ancestry retained.
Merge upstream release tags into testing through a reviewed PR; do not copy a
new upstream tree over the fork. Preserve the Adaptive UUID, settings and policy.

Before changing Shell integration, inspect the relevant GNOME Shell/Mutter
source for the versions being targeted, plus the applicable V-Shell/Dash to Dock
code. Their private APIs and monkey-patches vary by version and activation order.

Spatial dragging must reuse the existing workspace actors and native DND targets.
Do not add workspace thumbnails or enable V-Shell thumbnails. Respect workspace
orientation and the effective per-monitor dock position, with a manual fallback.
Keep the feature optional. Restore adjustments, gestures, barriers, timers and
workspace tracking on drop, cancellation, overview exit and extension disable.

Run `python3 .github/scripts/validate.py` and the repository formatting/license
checks. For geometry, picking, gestures or DND changes, also test a real isolated
GNOME Shell with a real window and virtual pointer; method-level mocks alone are
insufficient. Cover GNOME 46 with V-Shell, thumbnails disabled, both workspace
axes and D2D-A, plus the available 48/50/51 environments. State any untested
versions, session types and hardware behavior accurately.

Keep direct Git/Gitpulsar installs usable: regenerate committed resources/locales
when their sources change and compile schemas when installing. Disable the old
Cube UUID before enabling the Adaptive UUID; the GSettings schema stays shared
to preserve existing preferences.

License policy: follow LICENSING.md. Prefer MIT for independent original work,
then GPL-2.0-or-later where compatible; preserve stricter upstream grants,
attribution and asset licenses. Never infer permission for unlicensed code.

## Public documentation and agent-neutral publication policy

These instructions apply to **every agent or automated workflow** that reads this repository, regardless of provider, model, tool, or execution environment. They apply to future agents as well as the current maintainer's tools. Treat all repository-visible artifacts as potentially public, including commits, PRs, issues, changelogs, release notes, comments, CI reports, examples, and documentation, even when a repository is presently private.

- **Audience:** Write for an independent reader with no access to chats, prompts, personal history, local paths, or project-specific shorthand. Describe behavior, rationale, test conditions, and limitations self-sufficiently. Do not address the maintainer as the assumed reader of public artifacts or leak internal instructions into them.
- **Evidence:** Ground claims in checked-in source, explicit approved specifications, or actual test results. Clearly distinguish a declared compatibility range from versions exercised, mock/static checks from native Shell tests, and intentions from implemented behavior. Never invent verification, security assurances, priority, or novelty claims.
- **Scope and provenance:** A conversation, prior task, local configuration, private theme, unreleased asset, or other project's files are *not* permission to add or publish them. Never import personal settings, unpublished assets, unrelated dependencies, or private conversation excerpts without explicit authorization for this repository. Preserve licensing and upstream attribution; inspect additions for secrets and identifying information.
- **Documentation ownership:** The human maintainer owns the README's introduction, user-facing feature lists, motivation, UX descriptions, and other product narrative. Agents must not draft, rewrite, reorder, or silently "improve" those sections absent explicit task-specific permission. Agents maintain implementation/architecture notes, testing instructions and results, technical compatibility details, and tightly scoped factual installation/build changes. The permission to correct a command or version does not authorize rewriting surrounding narrative.
- **Change handoff:** For every functional change, report user-visible differences, new settings, limitations, affected README claims, and any needed maintainer-authored updates. Keep that report in the task/PR handoff rather than inserting agent-written feature prose into the README. Flag incorrect protected prose and request a maintainer decision; do not quietly edit it. An inaccurate README claim must not be treated as resolved merely because an agent says documentation is complete.
- **Release discipline:** Documentation and public-facing PR/release text must be checked for audience, accuracy, provenance, and human-owned sections before publication. If user-facing documentation is pending or materially false, explicitly mark it as unresolved and use the repository's existing release-pause mechanism when available; never claim an automated gate exists unless the workflow actually enforces it. The human maintainer decides whether a narrative update is complete or unnecessary. Technical checks alone are not such approval.
- **Minimal changes:** Preserve current documentation voice and repository-specific instructions. Do not rewrite old narrative wholesale during unrelated engineering work. If unsure whether text or an asset is authorized for publication, omit it and flag the question in the handoff.
