---
name: sh
description: Run shell commands, read files, and grep from the IPython kernel and keep the output as a Python value. Use when a command may exit non-zero (grep with no match, ls of a missing path, diff, test), when the output must be sliced, filtered, or reused later, or when the text is not ASCII and byte-based truncation would split a character.
---

# sh

Shell access that returns text instead of raising. `run()` returns stdout, the
stderr block, and the exit status as one string, so a failing command stays a
value you can inspect. `read()` and `grep()` do the same for files, and both cut
on character and line boundaries, never on bytes.

## Call it

```python
out = await sh.run("git log --oneline -5", cwd="/path/to/repo")   # never raises
await sh("rg -n TODO src")                                        # same as sh.run
hits = sh.grep(r"TODO", "src")                                    # (path, lineno, line) tuples
body = sh.read("docs/skills.md", start=40, end=70)                # by line number
```

## API

- `await sh.run(cmd, cwd="", chars=4000, lines=0, timeout=600.0)` — run one
  command through `bash -c`. The result is stdout, then `--- stderr` when the
  command wrote to stderr, then `--- exit N` when it failed. `lines` applies
  before `chars`; both count characters, so a multi-byte character stays whole.
  A timeout returns `--- timeout after Ns: <cmd>`, and a launch that fails
  returns `--- cannot run bash: <reason>`.
- `sh.read(path, start=1, end=0, chars=0)` — read a file by line number, 1-based
  and inclusive. `end=0` reads to the end of the file.
- `sh.grep(pattern, *paths, glob="**/*", ignore_case=False, max_hits=200, width=200)`
  — search files for a Python regex and get `(path, lineno, line)` tuples. A
  directory argument is walked with `glob`. A miss is an empty list.

## When a `%%bash` cell is still right

Use `%%bash` for multi-line scripts, for a run you want to watch as it streams,
and for any command whose output you do not need to slice. A non-zero exit in a
`%%bash` cell prints `--- exit N` on stderr and keeps the cell result, so it
costs no exception either.

Reach for `sh.run()` when the output belongs in a variable, and for `sh.grep()`
when the pattern would need shell quoting.
