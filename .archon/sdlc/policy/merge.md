# Merge policy

Add project-specific required checks and merge authority above this managed block.

<!-- FACTORY AUTONOMY: START (managed by factory-setup) -->
Preset: standard
- Merge only when written merge policy clearly permits it and evidence is fresh for the exact head; otherwise ask.
<!-- FACTORY AUTONOMY: END -->

A red `factory/app-check` at a pull request's head is a finding about this change, even on a pull request the owner approved. Do not wait on it and do not ask: return the pull request to the build queue, with a brief that says to read the check's comment on the pull request and fix what it names. A check that did not finish says so in its status; that one waits for the next check, it is not a finding.
