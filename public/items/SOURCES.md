# Item icon sources

The Black Desert Online item icons in `garmoth/` were retrieved from the Garmoth asset server using the drop paths
returned by its grind-tracker API. `scripts/sync-grind-spots.mjs` adds icons for newly imported spots and never removes
existing ones:

- https://api.garmoth.com/api/external/grind-tracker
- https://assets.garmoth.com/

The icons for the hand-written grind spot profiles were retrieved on 2026-08-30 for Garmoth grind spots 194, 200, 201,
213, 214, and 215. `artifact.png`, used for artifact drops, was added in commit b4dffba without a recorded source.

The artwork belongs to Pearl Abyss Corp. and is not covered by the project license. See `THIRD_PARTY_NOTICES.md`.
