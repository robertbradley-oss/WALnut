# WALnut

Read `GAMEPLAN.md` for the intended outcome and scope; use `ROADMAP.md` for the stage being worked on. `docs/architecture.md` and `docs/file-format.md` describe the implemented foundation.

- Keep the storage engine usable independently of the inspector. The inspector displays actual engine events and verified bytes.
- Stage 1 supports normal persistence/reopen. Do not describe it as crash-safe, transactional, a B+ tree, or WAL-backed.
- Keep development databases, compiler downloads, and test artifacts out of Git. Use `work/` for scratch work and disposable tests, and `data/` for the local demo.
- The Node command wrappers support either a normal Rust installation or this workspace's optional Windows toolchain. Use the documented npm commands for portable validation.
- Scope verification to behavior changed: core tests for storage, browser tests for interactions and engine/UI agreement, and a visual check for layout changes.
