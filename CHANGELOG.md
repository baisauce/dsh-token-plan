# Changelog

## 0.1.0 — 2026-11-22

- `token_plan` tool and `/tokenplan` command for the Qianwen Token Plan.
- dsh-pet custom balance bubble: remaining Credits, usage bar, share/used
  percentages, and reading time.
- Snapshot-based reads so the pet's 20-second fetch window never waits on the
  20–40 second CLI query.
- Automatic renewal of the Qwen CLI login through Edge + CDP (headless first,
  visible window only when a sign-in is required).