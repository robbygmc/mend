# mend

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/robbygmc/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/robbygmc/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

`mend` is one patch tool for every AI edit format. It reads a patch from a
file or standard input and applies it to a tree of text files — every edit or
none at all.

```sh
node main.ts [options] [PATCH]
```

## Formats

It detects the format from the patch itself:

- **Unified diff** — `diff --git` sections or bare `---` / `+++` pairs, with
  hunks that carry wrong line numbers, renames, creations and deletions.
- **SEARCH/REPLACE blocks** — a path line, `<<<<<<< SEARCH`, old lines,
  `=======`, new lines, `>>>>>>> REPLACE`.
- **V4A patches** — `*** Begin Patch` / `*** End Patch` with `*** Add File`,
  `*** Delete File` and `*** Update File` sections, anchors and moves.
- **JSON tool calls** — one JSON array of edit objects, or JSON Lines.

## Matching

An edit's old lines are found at the first of three tiers that has a match:
exact, then trailing whitespace ignored, then leading and trailing whitespace
ignored. Context lines are written back exactly as the file has them; at the
loosest tier the other new lines are re-indented to the file's indentation.

## Options

- `--check` — report what would change, without writing anything.
- `--strict` — exact matching only (tier 0).
- `--format=<name>` — force `unified`, `search-replace`, `v4a` or `json`
  instead of detecting.
- `--` — end of options.

## Exit codes

- `0` — every edit applied; one line per changed file (`A` / `D` / `M` /
  `R <old> -> <new>`) plus `ok: <n> file(s)`.
- `1` — some edit failed; one `error: <code> <path>` line per failure plus
  `failed: <k> of <n> edits`. Nothing is written.
- `2` — the patch itself is unusable: `error: usage`, `error: no-patch`,
  `error: format`, or `error: parse <N>`.

Node 22, standard library alone. See [SPEC.md](SPEC.md) for the full rules.
