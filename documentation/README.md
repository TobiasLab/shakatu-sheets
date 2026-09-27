# Documentation

- [Architecture](architecture/): system boundaries, persistence, integrations, and [live loot recognition](architecture/live-loot.md).
- [Self-improvement](architecture/quantity-learning.md): opt-in learning, correction examples, and automatic recovery.
- [Database](database/): schema, migrations, and data lifecycle.
- [Dependency management](dependency_management/): dependency policy and tooling.
- [Product behavior](design/): session, recognition-review, history, and upload behavior, and the
  [design language](design/design-language.md) every UI change follows.
- [Development](development/): setup, testing, packaging, and branch workflow, including
  [Windows support](development/windows.md), [loot benchmarks](development/live-loot-benchmark.md), and
  [performance verification](development/performance.md).
- [External services](misc/): integration notes.

Keep documentation short, factual, and current. Update the relevant reference instead of adding a new implementation
plan, completion report, or per-investigation write-up. Keep temporary plans and measurements in task or PR context;
retain durable decisions, reproduction commands, and unresolved limitations here. Removed historical documents remain
available in Git history.
