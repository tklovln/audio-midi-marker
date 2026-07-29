#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import re
import shutil
import sys
import csv
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Literal
import mido


ANNOTATION_HEADERS = [
    "pitch",
    "start",
    "end",
    "tonalTechnique",
    "articulation",
    "stringId",
    "position",
    "finger",
    "legato",
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


def extract_midi_notes(midi_path: Path) -> list[dict]:
    mid = mido.MidiFile(midi_path)
    # Merge tracks to handle all notes in one timeline
    merged = mido.merge_tracks(mid.tracks)
    
    notes = []
    active_notes = {} # pitch -> start_time
    current_time = 0.0
    # Use default tempo 120 BPM if not set
    tempo = mido.bpm2tempo(120)
    
    for msg in merged:
        # Update time
        current_time += mido.tick2second(msg.time, mid.ticks_per_beat, tempo)
        
        if msg.type == 'set_tempo':
            tempo = msg.tempo
        
        if msg.type == 'note_on' and msg.velocity > 0:
            if msg.note in active_notes:
                start = active_notes.pop(msg.note)
                notes.append({
                    "pitch": msg.note,
                    "start": start,
                    "end": current_time
                })
            active_notes[msg.note] = current_time
            
        elif (msg.type == 'note_off') or (msg.type == 'note_on' and msg.velocity == 0):
            if msg.note in active_notes:
                start = active_notes.pop(msg.note)
                notes.append({
                    "pitch": msg.note,
                    "start": start,
                    "end": current_time
                })
                
    # Sort by start time, then pitch
    notes.sort(key=lambda x: (x['start'], x['pitch']))
    return notes


def sync_annotation_csv(csv_path: Path, midi_path: Path):
    if not midi_path or not midi_path.exists():
        return

    # 1. Read MIDI notes
    try:
        midi_notes = extract_midi_notes(midi_path)
    except Exception as e:
        print(f"Warning: Failed to read MIDI {midi_path}: {e}", file=sys.stderr)
        return
    
    # 2. Read existing CSV if it exists
    existing_rows = []
    if csv_path.exists():
        try:
            with open(csv_path, 'r', encoding='utf-8') as f:
                reader = csv.DictReader(f)
                existing_rows = list(reader)
        except Exception as e:
            print(f"Error: Failed to read existing CSV {csv_path}: {e}. Skipping sync to avoid data loss.", file=sys.stderr)
            return
            
    # 3. Merge with robust matching (by pitch and approximate start time)
    # We want to align existing rows to midi notes to preserve annotations.
    
    # Helper to parse float safely
    def get_float(val):
        try:
            return float(val)
        except (ValueError, TypeError):
            return None

    # Load existing rows into a list of dicts for easier processing
    # We'll try to match each MIDI note to an existing row.
    # If matched, we use the existing row (and update timestamps if needed/empty).
    # If not matched, we create a new row.
    
    # Load existing rows into a list of dicts for easier processing
    # We'll try to match each MIDI note to an existing row.
    # If matched, we use the existing row (and update timestamps if needed/empty).
    # If not matched, we create a new row.
    
    available_rows = []
    for row in existing_rows:
        p = row.get('pitch')
        s = get_float(row.get('start'))
        # Store original row and metadata for matching
        available_rows.append({'row': row, 'pitch': str(p) if p else None, 'start': s, 'matched': False})

    new_rows = []
    
    # Tolerance for time matching (e.g. 0.05 seconds)
    TIME_TOLERANCE = 0.05

    for note in midi_notes:
        note_pitch = str(note['pitch'])
        note_start = note['start']
        
        # Find best match in available_rows
        best_match_idx = -1
        best_match_diff = float('inf')
        
        for i, item in enumerate(available_rows):
            if item['matched']:
                continue
            
            # Check pitch (must match exactly)
            if item['pitch'] != note_pitch:
                continue
                
            # Check start time (must be close)
            if item['start'] is None:
                continue
                
            diff = abs(item['start'] - note_start)
            if diff < TIME_TOLERANCE and diff < best_match_diff:
                best_match_diff = diff
                best_match_idx = i
        
        row = {}
        if best_match_idx != -1:
            # Found a match! Use existing row
            available_rows[best_match_idx]['matched'] = True
            row = available_rows[best_match_idx]['row'].copy()
        else:
            # No match found, create new row from MIDI note
            row = {
                'pitch': str(note['pitch']),
                'start': f"{note['start']:.6f}",
                'end': f"{note['end']:.6f}"
            }

        # Ensure all standard headers are present
        for h in ANNOTATION_HEADERS:
            if h not in row:
                row[h] = ""
        
        # Fill/Update MIDI data only if empty in the matched row
        if not row.get('pitch'):
            row['pitch'] = str(note['pitch'])
        if not row.get('start'):
            row['start'] = f"{note['start']:.6f}"
        if not row.get('end'):
            row['end'] = f"{note['end']:.6f}"
            
        new_rows.append(row)
    
    # Add remaining unmatched rows (user might have added extra annotations not in MIDI)
    for item in available_rows:
        if not item['matched']:
            row = item['row'].copy()
            # Ensure headers
            for h in ANNOTATION_HEADERS:
                if h not in row:
                    row[h] = ""
            new_rows.append(row)
            
    # Sort by start time
    def sort_key(r):
        try:
            return float(r.get('start', 0))
        except:
            return 0.0
            
    new_rows.sort(key=sort_key)
    
    # Detect existing headers to preserve them
    fieldnames = list(ANNOTATION_HEADERS)
    if existing_rows:
        existing_keys = set()
        for row in existing_rows:
            existing_keys.update(row.keys())
        for k in existing_keys:
            if k not in fieldnames:
                fieldnames.append(k)

    # 4. Write back with backup
    try:
        if csv_path.exists():
            backup_path = csv_path.with_suffix('.csv.bak')
            shutil.copy2(csv_path, backup_path)
            
        with open(csv_path, 'w', encoding='utf-8', newline='') as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction='ignore')
            writer.writeheader()
            writer.writerows(new_rows)
    except Exception as e:
        print(f"Error: Failed to write CSV {csv_path}: {e}", file=sys.stderr)


def ensure_annotation_csv(dest_folder: Path, midi_path: Path, *, overwrite: bool) -> None:
    csv_path = dest_folder / "annotation_revised.csv"
    
    if csv_path.exists():
        # NEVER delete existing annotation file, even if overwrite is True.
        # Instead, always sync/merge to preserve user data.
        sync_annotation_csv(csv_path, midi_path)
        return

    # Create new file
    csv_path.parent.mkdir(parents=True, exist_ok=True)
    # Create empty file with headers first
    csv_path.write_text(",".join(ANNOTATION_HEADERS) + "\n", encoding="utf-8")
    
    # Then sync with MIDI to populate
    sync_annotation_csv(csv_path, midi_path)


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
            "Organize pooled audio/video/midi files into /nas_data/tkwang/audio-midi-marker/data/<song>/ folders "
            "for the Flask annotator (app.py)."
        )
    )
    parser.add_argument(
        "--src",
        type=Path,
        default=Path("/nas_data/tkwang/Violin_Media_Dataset/Wohlfahrt"),
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
        help="Create annotation_revised.csv with headers in each created song folder (optional).",
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
        default="merge",
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

        
        midi_trim = pick_one("trim.mid")
        midi_merge = pick_one("merge.mid")
        midi = None
        if args.prefer_midi == "trim":
            audio = pick_one("trim_cut.wav") or pick_one("trim_cut.mp3")
            video = pick_one("trim_cut.mp4")
            midi = pick_one("trim.mid")
        elif args.prefer_midi == "merge":
            audio = pick_one("cut.wav") or pick_one("cut.mp3")
            video = pick_one("cut.mp4")
            midi = pick_one("merge.mid")
        else:
            raise ValueError(f"Unknown prefer-midi: {args.prefer_midi}")

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
                print(f"[DRY] init {dest_folder / 'annotation_revised.csv'}")
            else:
                ensure_annotation_csv(dest_folder, midi, overwrite=args.overwrite)

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






