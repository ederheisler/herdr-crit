Before architectural changes or proposing alternatives to established choices, read relevant records linked from [project decisions](docs/decisions/README.md).

## Publishing

When Eder says **publish**, complete this project's Release Please workflow for the requested changes: commit and push the scoped changes, inspect and merge the generated release PR into `main`, wait for publishing, and verify the released version, GitHub release, and `crit.zip` asset before reporting success.
The publish request authorizes these scoped commits, pushes, and the release PR merge; preserve required checks and exclude unrelated changes.
Use the existing release workflow rather than manually bumping versions or creating tags. If publishing fails or requires unavailable access, report the exact blocker and completed steps; a code push alone is not a published release.
