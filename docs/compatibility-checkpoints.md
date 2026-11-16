<!-- SPDX-FileCopyrightText: Eidrien -->
<!-- SPDX-License-Identifier: CC-BY-4.0 -->

# Cube compatibility checkpoints

This candidate is incomplete and must remain paused with `do-not-merge`.
The existing seven-day promotion interval and current-head validation requirements
remain unchanged. README feature descriptions are human-maintained.

1. Lifecycle: inspect and validate extension ordering, override ownership,
   reconfiguration and teardown before introducing new behavior.
2. Workspace policy: use effective V-Shell preferences without modifying either
   extension's saved settings; validate runtime and preferences ownership.
3. Sticky presentation: restrict cube presentation to the active face without
   changing actual window stickiness; validate both Shell presentation paths.

Each implementation checkpoint requires a separate commit, automated regression
checks and native validation. Results and limitations will be recorded here.
