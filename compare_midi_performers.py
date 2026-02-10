#!/usr/bin/env python3
from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Literal

import mido


Strategy = Literal["first", "largest_note_count"]


FILENAME_RE = re.compile(
    r"^(?P<base>.+)_(?P<yt>[A-Za-z0-9_-]{11})-(?P<t0>\d{4})-(?P<t1>\d{4})_(?P<tag>.+)\.(?P<ext>mid)$"
)


@dataclass(frozen=True)
class MidiIdentity:
    piece_key: str  # e.g. Paganini_Op01-01
    performer: str  # e.g. AlicanSuner
    base: str  # e.g. Paganini_Op01-01_AlicanSuner
    clip_id: str  # yt-t0-t1
    tag: str  # trim or merge (or other)


@dataclass(frozen=True)
class NoteRec:
    pitch: int
    start_tick: int
    end_tick: int
    channel: int
    start_order: int  # tie-breaker for same-tick onsets


def ticks_to_sec(ticks: int, ticks_per_beat: int, bpm: float = 120.0) -> float:
    """Convert MIDI ticks to seconds assuming a constant tempo."""
    return ticks * 60.0 / (bpm * ticks_per_beat)


def iter_midis(root: Path) -> Iterable[Path]:
    for p in root.rglob("*.mid"):
        if p.is_file():
            yield p


def parse_identity(path: Path) -> MidiIdentity | None:
    """
    Supports pooled filenames like:
      Paganini_Op01-01_AlicanSuner_lTsRFEpD6Jg-0001-0149_trim.mid

    Also supports already-organized data folders by using the filename only
    (the parent folder name is not required).
    """
    m = FILENAME_RE.match(path.name)
    if not m:
        return None

    base = m.group("base")
    # base is assumed to be <piece_key>_<performer> (performer may not contain underscores)
    if "_" not in base:
        return None
    piece_key, performer = base.rsplit("_", 1)
    clip_id = f'{m.group("yt")}-{m.group("t0")}-{m.group("t1")}'
    tag = m.group("tag")
    return MidiIdentity(
        piece_key=piece_key,
        performer=performer,
        base=base,
        clip_id=clip_id,
        tag=tag,
    )


def extract_notes_ticks(midi_path: Path) -> tuple[list[NoteRec], int]:
    """
    Extract notes using tick timeline (tempo-independent) and keep a deterministic
    onset ordering using the message order for same-tick events.
    """
    mid = mido.MidiFile(midi_path)
    merged = mido.merge_tracks(mid.tracks)
    tick = 0

    # key: (channel, pitch) -> list of (start_tick, start_order)
    active: dict[tuple[int, int], list[tuple[int, int]]] = {}
    notes: list[NoteRec] = []
    start_order = 0

    for msg in merged:
        tick += int(getattr(msg, "time", 0) or 0)

        if msg.type == "note_on" and getattr(msg, "velocity", 0) > 0:
            key = (int(getattr(msg, "channel", 0)), int(getattr(msg, "note", 0)))
            active.setdefault(key, []).append((tick, start_order))
            start_order += 1
            continue

        is_note_off = msg.type == "note_off" or (
            msg.type == "note_on" and getattr(msg, "velocity", 0) == 0
        )
        if not is_note_off:
            continue

        key = (int(getattr(msg, "channel", 0)), int(getattr(msg, "note", 0)))
        starts = active.get(key)
        if not starts:
            continue
        start_tick, order = starts.pop(0)
        end_tick = max(start_tick, tick)
        notes.append(
            NoteRec(
                pitch=key[1],
                start_tick=start_tick,
                end_tick=end_tick,
                channel=key[0],
                start_order=order,
            )
        )

    notes.sort(key=lambda n: (n.start_tick, n.start_order))
    return notes, mid.ticks_per_beat


def compare_pair(a_notes: list[NoteRec], b_notes: list[NoteRec]) -> dict:
    a_pitch = [n.pitch for n in a_notes]
    b_pitch = [n.pitch for n in b_notes]

    same_pitch_seq = a_pitch == b_pitch

    # Only meaningful when lengths match
    onset_diff = 0
    offset_diff = 0
    if same_pitch_seq and len(a_notes) == len(b_notes):
        for na, nb in zip(a_notes, b_notes):
            if na.start_tick != nb.start_tick:
                onset_diff += 1
            if na.end_tick != nb.end_tick:
                offset_diff += 1

    # All mismatch indices (pitch sequence)
    mismatch_indices: list[int] = []
    if not same_pitch_seq:
        limit = min(len(a_pitch), len(b_pitch))
        for i in range(limit):
            if a_pitch[i] != b_pitch[i]:
                mismatch_indices.append(i)

    return {
        "same_pitch_seq": same_pitch_seq,
        "a_count": len(a_notes),
        "b_count": len(b_notes),
        "onset_tick_diff_count": onset_diff,
        "offset_tick_diff_count": offset_diff,
        "mismatch_indices": mismatch_indices,
    }


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Check whether the MIDI note pitch sequence (ordered by note-on) is identical "
            "across performers for the same piece. Timing differences (onset/offset ticks) "
            "are reported separately."
        )
    )
    parser.add_argument(
        "--root",
        type=Path,
        default=Path("/mnt/hdd/Violin_Media_Dataset/Paganini"),
        help="Directory to scan for MIDI files (default: %(default)s).",
    )
    parser.add_argument(
        "--piece",
        action="append",
        default=[],
        help="Only analyze a specific piece_key (repeatable), e.g. Paganini_Op01-01.",
    )
    parser.add_argument(
        "--prefer-tag",
        choices=("trim", "merge", "any"),
        default="trim",
        help="Which MIDI tag to prefer when multiple exist for the same performer (default: %(default)s).",
    )
    parser.add_argument(
        "--strategy",
        choices=("first", "largest_note_count"),
        default="largest_note_count",
        help="How to pick one MIDI when multiple clips exist for the same performer (default: %(default)s).",
    )
    parser.add_argument(
        "--max-pieces",
        type=int,
        default=0,
        help="If set, stop after analyzing this many pieces (0 = no limit).",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Print per-performer selections and more detail.",
    )
    parser.add_argument(
        "--summary-only",
        action="store_true",
        help="Only print per-piece and global summary counts (no per-performer lines).",
    )

    args = parser.parse_args(argv)
    root: Path = args.root
    if not root.exists():
        print(f"ERROR: --root does not exist: {root}", file=sys.stderr)
        return 2

    wanted_pieces = set(args.piece or [])

    # Collect candidates
    # piece_key -> performer -> [ (identity, path) ... ]
    candidates: dict[str, dict[str, list[tuple[MidiIdentity, Path]]]] = {}
    for p in iter_midis(root):
        ident = parse_identity(p)
        if not ident:
            continue
        if wanted_pieces and ident.piece_key not in wanted_pieces:
            continue
        if args.prefer_tag != "any" and ident.tag != args.prefer_tag:
            continue
        candidates.setdefault(ident.piece_key, {}).setdefault(ident.performer, []).append((ident, p))

    if not candidates:
        print("No matching MIDI files found.")
        return 0

    analyzed = 0
    all_ok = True
    total_pairs = 0
    total_note_count_mismatch = 0
    total_pitch_mismatch = 0
    total_both_mismatch = 0
    pieces_with_note_count_mismatch = 0
    pieces_with_pitch_mismatch = 0

    for piece_key in sorted(candidates.keys()):
        perf_map = candidates[piece_key]
        if len(perf_map) < 2:
            continue

        selected: dict[str, Path] = {}
        note_cache: dict[str, list[NoteRec]] = {}
        tpb_cache: dict[str, int] = {}

        for performer, items in sorted(perf_map.items()):
            # Pick a file
            if args.strategy == "first":
                pick = sorted(items, key=lambda t: t[1].name)[0]
                selected[performer] = pick[1]
            else:
                # largest_note_count: parse all and pick the one with most notes
                best_path = None
                best_notes: list[NoteRec] | None = None
                best_tpb: int = 480
                for ident, path in sorted(items, key=lambda t: t[1].name):
                    try:
                        notes, tpb = extract_notes_ticks(path)
                    except Exception as exc:
                        if args.verbose:
                            print(f"[skip] {path}: {exc}", file=sys.stderr)
                        continue
                    if best_notes is None or len(notes) > len(best_notes):
                        best_notes = notes
                        best_path = path
                        best_tpb = tpb
                if best_path is None or best_notes is None:
                    continue
                selected[performer] = best_path
                note_cache[performer] = best_notes
                tpb_cache[performer] = best_tpb

        performers = sorted(selected.keys())
        if len(performers) < 2:
            continue

        if args.verbose:
            print(f"\n== {piece_key} ==")
            for performer in performers:
                print(f"- {performer}: {selected[performer]}")

        # Ensure notes loaded for all
        for performer in performers:
            if performer in note_cache:
                continue
            try:
                notes, tpb = extract_notes_ticks(selected[performer])
                note_cache[performer] = notes
                tpb_cache[performer] = tpb
            except Exception as exc:
                print(f"[error] failed to parse {selected[performer]}: {exc}", file=sys.stderr)
                continue

        ref = performers[0]
        ref_notes = note_cache.get(ref)
        ref_tpb = tpb_cache.get(ref, 480)
        if not ref_notes:
            continue

        piece_ok = True
        piece_note_count_mismatch = 0
        piece_pitch_mismatch = 0
        piece_pairs = 0
        mismatch_lines: list[str] = []

        for performer in performers[1:]:
            other_notes = note_cache.get(performer)
            if not other_notes:
                continue
            result = compare_pair(ref_notes, other_notes)
            piece_pairs += 1
            total_pairs += 1

            note_count_mismatch = result["a_count"] != result["b_count"]
            pitch_mismatch = not result["same_pitch_seq"]
            both = note_count_mismatch and pitch_mismatch

            if note_count_mismatch:
                piece_note_count_mismatch += 1
                total_note_count_mismatch += 1
            if pitch_mismatch:
                piece_pitch_mismatch += 1
                total_pitch_mismatch += 1
            if both:
                total_both_mismatch += 1

            if not result["same_pitch_seq"]:
                piece_ok = False
                mm_indices: list[int] = result["mismatch_indices"]
                if not args.summary_only:
                    mismatch_lines.append(
                        f"- mismatch vs {performer}: pitch_seq DIFFERENT (ref_count={result['a_count']}, other_count={result['b_count']}, mismatch_notes={len(mm_indices)})"
                    )
                    other_tpb = tpb_cache.get(performer, 480)
                    for idx in mm_indices:
                        if 0 <= idx < len(ref_notes) and 0 <= idx < len(other_notes):
                            rn = ref_notes[idx]
                            on = other_notes[idx]
                            r_sec = ticks_to_sec(rn.start_tick, ref_tpb)
                            o_sec = ticks_to_sec(on.start_tick, other_tpb)
                            mismatch_lines.append(
                                f"  [{idx:>5}] ref={rn.pitch:<3} other={on.pitch:<3} ref@{r_sec:.2f}s other@{o_sec:.2f}s"
                            )
            else:
                if not args.summary_only:
                    mismatch_lines.append(
                        f"- vs {performer}: pitch_seq OK; onset_tick_diff={result['onset_tick_diff_count']}, offset_tick_diff={result['offset_tick_diff_count']} (notes={result['a_count']})"
                    )

        analyzed += 1
        if piece_note_count_mismatch > 0:
            pieces_with_note_count_mismatch += 1
        if piece_ok:
            print(
                f"{piece_key}: PITCH ORDER IDENTICAL across {len(performers)} performers (ref={ref}) "
                f"[pairs={piece_pairs}, note_count_mismatch={piece_note_count_mismatch}, pitch_mismatch={piece_pitch_mismatch}]"
            )
        else:
            all_ok = False
            pieces_with_pitch_mismatch += 1
            print(f"{piece_key}: PITCH ORDER NOT identical across {len(performers)} performers (ref={ref})")
            if args.summary_only:
                print(
                    f"  summary: pairs={piece_pairs}, note_count_mismatch={piece_note_count_mismatch}, pitch_mismatch={piece_pitch_mismatch}"
                )
        if not args.summary_only:
            for line in mismatch_lines:
                print(line)

        if args.max_pieces and analyzed >= args.max_pieces:
            break

    if analyzed == 0:
        print("No pieces with >=2 performers matched the filters.")
        return 0

    print("\n== Summary ==")
    print(f"pieces_analyzed={analyzed}")
    print(f"pairs_compared={total_pairs}")
    print(f"note_count_mismatch_pairs={total_note_count_mismatch}")
    print(f"pitch_mismatch_pairs={total_pitch_mismatch}")
    print(f"both_mismatch_pairs={total_both_mismatch}")
    print(f"pieces_with_note_count_mismatch={pieces_with_note_count_mismatch}")
    print(f"pieces_with_pitch_mismatch={pieces_with_pitch_mismatch}")

    return 0 if all_ok else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))


