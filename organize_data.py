#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import re
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Literal


ANNOTATION_HEADERS = [
    "pitch",
    "start",
    "end",
    "tonalTechnique",
    "articulation",
    "stringId",
    "position",
    "finger",
]

Mode = Literal["copy", "symlink", "hardlink"]


# Example:
#   Paganini_Op01-03_AlicanSuner__j32FQFL0TY-0000-0222_cut_trim.wav
# base = Paganini_Op01-03_AlicanSuner
# yt   = _j32FQFL0TY
FILENAME_RE = re.compile(
    r"^(?P<base>.+)_(?P<yt>[A-Za-z0-9_-]{11})-(?P<t0>\d{4})-(?P<t1>\d{4})_(?P<tag>.+)\.(?P<ext>mp4|wav|mp3|mid)$"
)


@dataclass(frozen=True)
class MediaGroup:
    base: str  # destination folder name under /data
    clip_id: str  # yt-t0-t1 (helps grouping, but filenames remain unchanged)


def parse_group(path: Path) -> tuple[MediaGroup, str, str] | None:
    """
    Returns (group, tag, ext) for recognized filenames, else None.
    tag is the part after the timecodes, e.g. "cut_trim" or "trim".
    """
    m = FILENAME_RE.match(path.name)
    if not m:
        return None
    base = m.group("base")
    clip_id = f'{m.group("yt")}-{m.group("t0")}-{m.group("t1")}'
    return MediaGroup(base=base, clip_id=clip_id), m.group("tag"), m.group("ext")


def iter_candidate_files(src_dir: Path) -> Iterable[Path]:
    # Current pool is a single directory, but keep recursive search for flexibility.
    for p in src_dir.rglob("*"):
        if p.is_file():
            yield p


def ensure_annotation_csv(dest_folder: Path, *, overwrite: bool) -> None:
    csv_path = dest_folder / "annotation.csv"
    if csv_path.exists() and not overwrite:
        return
    csv_path.parent.mkdir(parents=True, exist_ok=True)
    csv_path.write_text(",".join(ANNOTATION_HEADERS) + "\n", encoding="utf-8")


def install_file(src: Path, dst: Path, *, mode: Mode, overwrite: bool, dry_run: bool) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)

    if dst.exists() or dst.is_symlink():
        if not overwrite:
            return
        if dry_run:
            return
        dst.unlink()

    if dry_run:
        return

    if mode == "copy":
        shutil.copy2(src, dst)
    elif mode == "symlink":
        # Absolute link so the dataset is robust to CWD changes
        dst.symlink_to(src.resolve())
    elif mode == "hardlink":
        os.link(src, dst)
    else:  # pragma: no cover
        raise ValueError(f"Unknown mode: {mode}")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Organize pooled audio/video/midi files into /root/audio-midi-marker/data/<song>/ folders "
            "for the Flask annotator (app.py)."
        )
    )
    parser.add_argument(
        "--src",
        type=Path,
        default=Path("/mnt/hdd/violin_media_outputs/Paganini"),
        help="Source directory that contains pooled files (default: %(default)s).",
    )
    parser.add_argument(
        "--dst",
        type=Path,
        default=Path(__file__).resolve().parent / "data",
        help="Destination data directory (default: <repo>/data).",
    )
    parser.add_argument(
        "--mode",
        choices=("copy", "symlink", "hardlink"),
        default="copy",
        help="How to place files in destination: copy, symlink, or hardlink (default: %(default)s).",
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Overwrite existing destination files.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print planned actions only; do not touch the filesystem.",
    )
    parser.add_argument(
        "--init-annotation",
        action="store_true",
        help="Create annotation.csv with headers in each created song folder (optional).",
    )
    parser.add_argument(
        "--only-base",
        action="append",
        default=[],
        help="Only process a specific base folder name (repeatable), e.g. Paganini_Op01-01_AlicanSuner.",
    )
    parser.add_argument(
        "--prefer-midi",
        choices=("trim", "merge"),
        default="trim",
        help="When both *_trim.mid and *_merge.mid exist, pick which one to copy/link (default: %(default)s).",
    )

    args = parser.parse_args(argv)
    src_dir: Path = args.src
    dst_dir: Path = args.dst
    mode: Mode = args.mode

    if not src_dir.exists():
        print(f"ERROR: --src does not exist: {src_dir}", file=sys.stderr)
        return 2

    wanted_bases = set(args.only_base or [])

    # Group candidates by (base, clip_id)
    groups: dict[MediaGroup, dict[str, list[Path]]] = {}
    for path in iter_candidate_files(src_dir):
        parsed = parse_group(path)
        if not parsed:
            continue
        group, tag, ext = parsed
        if wanted_bases and group.base not in wanted_bases:
            continue
        groups.setdefault(group, {}).setdefault(f"{tag}.{ext}", []).append(path)

    if not groups:
        print("No matching files found.")
        return 0

    # For each group, choose the files we actually want in the song folder:
    # - audio: *_cut_trim.wav (or .mp3)
    # - video: *_cut_trim.mp4 (optional)
    # - midi : *_trim.mid (or *_merge.mid if preferred/only)
    created_folders = 0
    installed_files = 0
    skipped_files = 0
    problems: list[str] = []

    for group in sorted(groups.keys(), key=lambda g: (g.base, g.clip_id)):
        catalog = groups[group]
        dest_folder = dst_dir / group.base

        def pick_one(key: str) -> Path | None:
            items = catalog.get(key) or []
            if not items:
                return None
            # deterministic pick if duplicates
            return sorted(items)[0]

        audio = pick_one("cut_trim.wav") or pick_one("cut_trim.mp3")
        video = pick_one("cut_trim.mp4")
        midi_trim = pick_one("trim.mid")
        midi_merge = pick_one("merge.mid")
        midi = None
        if args.prefer_midi == "trim":
            midi = midi_trim or midi_merge
        else:
            midi = midi_merge or midi_trim

        if not audio or not midi:
            problems.append(
                f"Missing required files for {group.base} ({group.clip_id}): "
                f"audio={'OK' if audio else 'MISSING'}, midi={'OK' if midi else 'MISSING'}"
            )
            continue

        if args.dry_run:
            print(f"[DRY] {group.base} ({group.clip_id}) -> {dest_folder}")
        else:
            if not dest_folder.exists():
                created_folders += 1
                dest_folder.mkdir(parents=True, exist_ok=True)

        # Install chosen files
        for src in [audio, video, midi]:
            if not src:
                continue
            dst = dest_folder / src.name
            before_exists = dst.exists() or dst.is_symlink()
            install_file(src, dst, mode=mode, overwrite=args.overwrite, dry_run=args.dry_run)
            after_exists = dst.exists() or dst.is_symlink()

            if before_exists and not args.overwrite:
                skipped_files += 1
            else:
                # In dry-run, treat as "would install"
                if args.dry_run or after_exists:
                    installed_files += 1

        if args.init_annotation:
            if args.dry_run:
                print(f"[DRY] init {dest_folder / 'annotation.csv'}")
            else:
                ensure_annotation_csv(dest_folder, overwrite=args.overwrite)

    if problems:
        print("\nWarnings / missing groups:", file=sys.stderr)
        for msg in problems[:200]:
            print(f"- {msg}", file=sys.stderr)
        if len(problems) > 200:
            print(f"- ... {len(problems) - 200} more", file=sys.stderr)

    print(
        f"Done. groups={len(groups)}, created_folders={created_folders}, "
        f"installed_files={installed_files}, skipped_files={skipped_files}, problems={len(problems)}"
    )
    return 0 if not problems else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))






