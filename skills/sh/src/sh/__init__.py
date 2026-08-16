"""Shell, file read, and grep helpers that survive non-ASCII output.

Two shell conventions break when a kernel treats them as Python values:

- a non-zero exit is a normal answer for ``grep``, ``ls``, ``test`` and ``diff``,
  yet a raised ``CalledProcessError`` hides the output that answered the
  question;
- ``cut -c`` and ``head -c`` count bytes, so they split a multi-byte character
  and the decode that follows raises ``UnicodeDecodeError``.

Every function here returns text or Python objects, decodes with
``errors="replace"``, and cuts on character and line boundaries.
"""

from __future__ import annotations

import asyncio
import re
import subprocess
from pathlib import Path


def _decode(raw: bytes) -> str:
    return raw.decode("utf-8", errors="replace")


def _clip(text: str, chars: int, lines: int) -> str:
    """Cut by lines first, then by characters. Never by bytes."""
    total_lines = text.count("\n") + 1
    if lines and total_lines > lines:
        text = "\n".join(text.split("\n")[:lines]) + f"\n… (+{total_lines - lines} more lines)"
    if chars and len(text) > chars:
        text = text[:chars] + f"… (+{len(text) - chars} more chars)"
    return text


async def run(
    cmd: str,
    cwd: str = "",
    chars: int = 4000,
    lines: int = 0,
    timeout: float = 600.0,
) -> str:
    """Run one bash command and return its output as text.

    Never raises: a non-zero exit, a timeout, and a failed launch all come back
    as text.

    Args:
        cmd: Command line, run through ``bash -c``.
        cwd: Working directory; empty means the kernel's current directory.
        chars: Character budget for the returned text; 0 keeps all of it.
        lines: Line budget, applied before ``chars``; 0 keeps all of them.
        timeout: Seconds before the command is killed.

    Returns:
        Stdout, then a ``--- stderr`` block when the command wrote to stderr,
        then ``--- exit N`` when it failed. A failing command is a value to
        read, not an exception: ``grep`` with no match and ``ls`` of a missing
        path both exit 1 while answering the question that was asked.
    """
    try:
        done = await asyncio.to_thread(
            subprocess.run,
            ["bash", "-c", cmd],
            cwd=cwd or None,
            timeout=timeout,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except subprocess.TimeoutExpired:
        return f"--- timeout after {timeout:g}s: {cmd}"
    except OSError as error:
        # No bash on PATH, or a cwd that does not exist: the launch itself failed.
        return f"--- cannot run bash: {error}"
    parts = [_clip(_decode(done.stdout), chars, lines)]
    if err := _decode(done.stderr).strip():
        parts.append("--- stderr\n" + _clip(err, 1000, 0))
    if done.returncode:
        parts.append(f"--- exit {done.returncode}")
    return "\n".join(part for part in parts if part).strip() or f"--- exit 0, no output: {cmd}"


def read(path: str | Path, start: int = 1, end: int = 0, chars: int = 0) -> str:
    """Read a file by line number, 1-based and inclusive.

    Args:
        path: File to read.
        start: First line to return; 0 and 1 both start at the first line.
        end: Last line to return; 0 reads to the end of the file.
        chars: Character budget for the result; 0 keeps all of it.

    Returns:
        The selected lines, decoded with ``errors="replace"``.
    """
    rows = Path(path).read_text(encoding="utf-8", errors="replace").split("\n")
    return _clip("\n".join(rows[max(start - 1, 0) : end or None]), chars, 0)


def grep(
    pattern: str,
    *paths: str | Path,
    glob: str = "**/*",
    ignore_case: bool = False,
    max_hits: int = 200,
    width: int = 200,
) -> list[tuple[str, int, str]]:
    """Search files for a regex and return ``(path, lineno, line)`` tuples.

    Pure Python, so a non-ASCII pattern needs no shell quoting and a miss is an
    empty list rather than exit code 1. A directory argument is walked with
    ``glob``; unreadable files are skipped.

    Args:
        pattern: Python regular expression.
        paths: Files or directories to search; defaults to the current directory.
        glob: Pattern used to walk a directory argument.
        ignore_case: Case-insensitive matching.
        max_hits: Stop after this many hits.
        width: Characters kept per line.

    Returns:
        One tuple per matching line, in file and line order.
    """
    matcher = re.compile(pattern, re.IGNORECASE if ignore_case else 0)
    hits: list[tuple[str, int, str]] = []
    targets: list[Path] = []
    for raw in paths or (".",):
        found = Path(raw)
        targets.extend(
            sorted(child for child in found.glob(glob) if child.is_file())
            if found.is_dir()
            else [found]
        )
    for target in targets:
        try:
            body = target.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for number, line in enumerate(body.split("\n"), 1):
            if matcher.search(line):
                hits.append((str(target), number, line.strip()[:width]))
                if len(hits) >= max_hits:
                    return hits
    return hits
