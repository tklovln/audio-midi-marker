from __future__ import annotations

import csv
import json
import mimetypes
import os
import subprocess
import urllib.parse
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Tuple

import numpy as np
import mido
import soundfile as sf
from flask import (
    Flask,
    abort,
    jsonify,
    render_template,
    request,
    send_file,
    url_for,
    redirect, 
    abort
)
from ai_fingering import generate_predictions, note_key_from_parts

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
DEFAULT_BPM = 120
DEFAULT_TEMPO = mido.bpm2tempo(DEFAULT_BPM)
DEFAULT_VIEW_SECONDS = 10
WAVEFORM_BUCKETS = 4096
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


def _safe_int(value, default=None):
    try:
        return int(value)
    except Exception:
        return default


def _safe_float(value, default=0.0):
    try:
        return float(value)
    except Exception:
        return default


def empty_annotation(pitch: int, start: float, end: float):
    return {
        "pitch": pitch,
        "start": start,
        "end": end,
        "tonalTechnique": "",
        "articulation": "",
        "stringId": None,
        "position": None,
        "finger": None,
        "legato": 0,
    }


def merge_annotation(existing: dict, updates: dict):
    merged = existing.copy()
    for field in ["pitch", "start", "end"]:
        if field in updates:
            merged[field] = updates[field]
    for field in ["tonalTechnique", "articulation", "stringId", "position", "finger", "legato"]:
        if updates.get(field) is not None:
            merged[field] = updates[field]
    return merged


@dataclass
class Song:
    name: str
    title: str
    composer: str
    song_name: str
    performer: str
    midi_path: Path
    audio_path: Path
    video_path: Path | None = None
    completed: bool = False


def _format_title(name: str) -> str:
    # Simple title formatting for nicer display
    return name.replace("_", " ")


def _status_path(folder: Path) -> Path:
    return folder / "status.json"


def read_completed_status(folder: Path) -> bool:
    """
    Manual completion flag stored per piece folder in status.json:
      { "completed": true/false }
    """
    try:
        path = _status_path(folder)
        if not path.exists():
            return False
        payload = json.loads(path.read_text(encoding="utf-8") or "{}")
        return bool(payload.get("completed"))
    except Exception:
        return False


def write_completed_status(folder: Path, completed: bool) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    path = _status_path(folder)
    path.write_text(json.dumps({"completed": bool(completed)}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _parse_song_folder_name(folder_name: str) -> Tuple[str, str, str]:
    """
    Expected folder structure: {Composer}_{Song_name}_{Performer}
    Example: Paganini_Op01-01_AlicanSuner

    We treat the first token as composer and the last token as performer,
    joining everything in between as the song_name to preserve underscores.
    """
    parts = [p for p in (folder_name or "").split("_") if p]
    if len(parts) >= 3:
        composer = parts[0]
        performer = parts[-1]
        song_name = "_".join(parts[1:-1])
        return composer, song_name, performer
    if len(parts) == 2:
        return parts[0], parts[1], ""
    if len(parts) == 1:
        return parts[0], parts[0], ""
    return "Unknown", folder_name or "Unknown", ""


def build_song_tree(songs: List[Song]):
    """
    Returns a structure suitable for Jinja rendering:
    [
      { composer: str, songs: [ { song_name: str, title: str, performers: [Song, ...] }, ... ] },
      ...
    ]
    """
    grouped: Dict[str, Dict[str, List[Song]]] = {}
    for song in songs:
        composer = song.composer or "Unknown"
        piece = song.song_name or song.name
        grouped.setdefault(composer, {}).setdefault(piece, []).append(song)

    result = []
    for composer in sorted(grouped.keys(), key=lambda s: (s or "").lower()):
        piece_map = grouped[composer]
        pieces = []
        for piece in sorted(piece_map.keys(), key=lambda s: (s or "").lower()):
            performers = sorted(
                piece_map[piece],
                key=lambda s: ((s.performer or "").lower(), (s.name or "").lower()),
            )
            pieces.append(
                {
                    "song_name": piece,
                    "title": _format_title(piece),
                    "performers": performers,
                }
            )
        result.append({"composer": composer, "songs": pieces})
    return result


def discover_songs() -> List[Song]:
    if not DATA_DIR.exists():
        return []

    songs: List[Song] = []
    for folder in sorted(DATA_DIR.iterdir()):
        if not folder.is_dir():
            continue

        composer, song_name, performer = _parse_song_folder_name(folder.name)
        completed = read_completed_status(folder)
        midi_path = next(folder.glob("*.mid"), None)
        audio_path = None
        for ext in ("mp3", "wav"):
            audio_candidate = next(folder.glob(f"*.{ext}"), None)
            if audio_candidate:
                audio_path = audio_candidate
                break
        
        video_path = next(folder.glob("*.mp4"), None)

        if midi_path and audio_path:
            songs.append(
                Song(
                    name=folder.name,
                    title=_format_title(song_name),
                    composer=composer,
                    song_name=song_name,
                    performer=performer,
                    midi_path=midi_path,
                    audio_path=audio_path,
                    video_path=video_path,
                    completed=completed,
                )
            )

    return songs


def get_song(song_name: str) -> Song | None:
    for song in discover_songs():
        if song.name == song_name:
            return song
    return None


def midi_notes(song: Song):
    mid = mido.MidiFile(song.midi_path)
    merged = mido.merge_tracks(mid.tracks)
    tempo = DEFAULT_TEMPO
    active_notes = {}
    notes = []
    timeline_sec = 0.0

    for message in merged:
        if message.time:
            timeline_sec += mido.tick2second(message.time, mid.ticks_per_beat, tempo)

        if message.type == "set_tempo":
            tempo = message.tempo
            continue

        if message.type == "note_on" and message.velocity > 0:
            key = (message.channel, message.note)
            active_notes.setdefault(key, []).append(timeline_sec)
        elif message.type in {"note_off", "note_on"}:
            is_note_off = message.type == "note_off" or (
                message.type == "note_on" and message.velocity == 0
            )
            if not is_note_off:
                continue

            key = (message.channel, message.note)
            starts = active_notes.get(key)
            if starts:
                start_time = starts.pop(0)
                notes.append(
                    {
                        "pitch": message.note,
                        "start": round(start_time, 6),
                        "end": round(max(start_time, timeline_sec), 6),
                        "channel": message.channel,
                        "velocity": message.velocity,
                    }
                )

    notes.sort(key=lambda n: n["start"])
    return notes
def annotation_file(song: Song) -> Path:
    return song.midi_path.parent / "annotation.csv"


def read_annotations(song: Song):
    path = annotation_file(song)
    annotations = {}
    if not path.exists():
        return annotations

    with path.open(newline="", encoding="utf-8") as csvfile:
        reader = csv.DictReader(csvfile)
        for row in reader:
            try:
                key = (int(row["pitch"]), float(row["start"]))
            except (ValueError, KeyError):
                continue
            string_id = _safe_int(row.get("stringId"))
            annotations[key] = {
                "pitch": int(row.get("pitch", 0)),
                "start": float(row.get("start", 0.0)),
                "end": float(row.get("end", 0.0)),
                "tonalTechnique": row.get("tonalTechnique", ""),
                "articulation": row.get("articulation", ""),
                "stringId": string_id,
                "position": _safe_int(row.get("position")),
                "finger": _safe_int(row.get("finger")),
                "legato": _safe_int(row.get("legato"), 0) or 0,
            }
    return annotations


def write_annotations(song: Song, annotation_map):
    path = annotation_file(song)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as csvfile:
        writer = csv.DictWriter(csvfile, fieldnames=ANNOTATION_HEADERS)
        writer.writeheader()
        # Sort by start time ascending, then pitch to keep rows stable
        for key in sorted(annotation_map.keys(), key=lambda k: (k[1], k[0])):
            record = annotation_map[key]
            writer.writerow(
                {
                    "pitch": record.get("pitch", 0),
                    "start": record.get("start", 0.0),
                    "end": record.get("end", 0.0),
                    "tonalTechnique": record.get("tonalTechnique", ""),
                    "articulation": record.get("articulation", ""),
                    "stringId": "" if record.get("stringId") is None else record.get("stringId"),
                    "position": "" if record.get("position") is None else record.get("position"),
                    "finger": "" if record.get("finger") is None else record.get("finger"),
                    "legato": record.get("legato", 0) or 0,
                }
            )


def waveform_points(song: Song, buckets: int = WAVEFORM_BUCKETS):
    try:
        samples, sample_rate = sf.read(song.audio_path, dtype="float32", always_2d=False)
    except (RuntimeError, OSError) as exc:
        raise RuntimeError(f"Failed to read audio for {song.name}") from exc

    if samples.ndim > 1:
        samples = samples.mean(axis=1)

    total_samples = len(samples)
    if total_samples == 0 or sample_rate == 0:
        return {"min": [], "max": [], "bucketDuration": 0, "duration": 0}

    bucket_count = min(buckets, max(1, total_samples // 512))
    edges = np.linspace(0, total_samples, num=bucket_count + 1, dtype=int)
    mins = np.empty(bucket_count, dtype=np.float32)
    maxs = np.empty(bucket_count, dtype=np.float32)

    for idx in range(bucket_count):
        start, end = edges[idx], edges[idx + 1]
        segment = samples[start:end]
        if segment.size == 0:
            mins[idx] = 0
            maxs[idx] = 0
        else:
            mins[idx] = float(segment.min())
            maxs[idx] = float(segment.max())

    duration = total_samples / sample_rate
    bucket_duration = duration / bucket_count if bucket_count else 0
    return {
        "min": mins.tolist(),
        "max": maxs.tolist(),
        "bucketDuration": bucket_duration,
        "duration": duration,
    }


def _guess_mimetype(path: Path) -> str:
    mimetype, _ = mimetypes.guess_type(path)
    return mimetype or "application/octet-stream"


def _probe_video_codec(path: Path) -> str | None:
    """
    Returns ffprobe codec_name for the first video stream (e.g., 'h264', 'mpeg4').
    """
    try:
        result = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_entries",
                "stream=codec_name",
                "-of",
                "default=nw=1:nk=1",
                str(path),
            ],
            check=False,
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            return None
        codec = (result.stdout or "").strip()
        return codec or None
    except Exception:
        return None


def _ensure_browser_video(video_path: Path) -> Path:
    """
    Many browsers don't reliably play MP4 files encoded with MPEG-4 Part 2 ('mpeg4').
    If the codec isn't H.264, transcode once to H.264 for HTML5 playback.
    """
    codec = _probe_video_codec(video_path)
    if codec == "h264":
        return video_path

    out_path = video_path.with_name(f"{video_path.stem}.h264.mp4")
    try:
        if out_path.exists() and out_path.stat().st_size > 0:
            # Reuse cached transcode if it's at least as new as the input.
            if out_path.stat().st_mtime >= video_path.stat().st_mtime:
                return out_path
    except Exception:
        pass

    # Best-effort transcode (video only; audio comes from the separate waveform audio file).
    try:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-i",
                str(video_path),
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-preset",
                "veryfast",
                "-crf",
                "23",
                "-movflags",
                "+faststart",
                "-an",
                str(out_path),
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        if out_path.exists() and out_path.stat().st_size > 0:
            return out_path
    except Exception:
        # Fall back to original file (may not play in-browser, but keep endpoint working).
        return video_path

    return video_path


def create_app():
    flask_app = Flask(__name__)

    @flask_app.route("/")
    def index():
        songs = discover_songs()
        song_tree = build_song_tree(songs)
        return render_template("index.html", songs=songs, song_tree=song_tree)

    @flask_app.route("/annotate/<song_name>")
    def annotate(song_name: str):
        song = get_song(song_name)
        if not song:
            abort(404)

        enable_finger_tracking = str(os.environ.get("ENABLE_FINGER_TRACKING", "1")).lower() not in {
            "0",
            "false",
            "no",
            "off",
        }

        # Determine audio URL (static Nginx or Flask route)
        static_audio_prefix = os.environ.get("STATIC_AUDIO_PREFIX")
        if static_audio_prefix:
            # Use Nginx static path: /data/<folder_name>/<filename>
            # Ensure proper URL encoding for paths
            folder_part = urllib.parse.quote(song.name)
            file_part = urllib.parse.quote(song.audio_path.name)
            # Remove trailing slash from prefix if present to avoid double slashes
            prefix = static_audio_prefix.rstrip("/")
            audio_url = f"{prefix}/{folder_part}/{file_part}"
        else:
            # Fallback to Flask route
            audio_url = url_for("audio_file", song_name=song.name)

        palette = [
            "#7f55b1",
            "#9b7ebd",
            "#f49bab",
            "#ffe1e0",
            "#eeece1",
            "#e16981",
        ]
        app_config = {
            "songName": song.name,
            "audioUrl": audio_url,
            "videoUrl": url_for("video_file", song_name=song.name) if song.video_path else None,
            "midiApiUrl": url_for("midi_api", song_name=song.name),
            "waveformApiUrl": url_for("waveform_api", song_name=song.name),
            "annotationApiUrl": url_for("annotation_api", song_name=song.name),
            "legatoApiUrl": url_for("legato_api", song_name=song.name),
            "aiGenerateApiUrl": url_for("ai_generate", song_name=song.name),
            "aiCommitApiUrl": url_for("ai_commit", song_name=song.name),
            "statusApiUrl": url_for("status_api", song_name=song.name),
            "completed": bool(song.completed),
            "enableFingerTracking": bool(enable_finger_tracking),
            "windowSeconds": DEFAULT_VIEW_SECONDS,
            "palette": palette,
            "slicePaddingSeconds": 0.05,  # 50ms padding for midi note playback buffer
        }

        return render_template(
            "annotation.html",
            song=song,
            app_config=app_config,
            enable_finger_tracking=enable_finger_tracking,
        )

    @flask_app.get("/audio_test")
    def audio_test():
        return ("ok\n", 200, {"Content-Type": "text/plain"})

    import sys, time, os

    # @flask_app.route("/audio/<song_name>")
    # def audio_file(song_name: str):
    #     import time
        
    #     song = get_song(song_name)

    #     if not song:
    #         abort(404)
       
    #     return send_file(
    #         song.audio_path, 
    #         mimetype=_guess_mimetype(song.audio_path), 
    #         conditional=True
    #     )
    from flask import Response, abort
    @flask_app.get("/audio/<song_name>")
    def audio_file(song_name):
        song = get_song(song_name)
        if not song:
            abort(404)
        path = song.audio_path
        size = os.path.getsize(path)
        # 先回 1KB，確認 headers/first bytes 在外部是能送出的
        with open(path, "rb") as f:
            head = f.read(1024)

        return Response(
            head,
            status=206,
            mimetype="audio/wav",
            headers={
                "Content-Range": f"bytes 0-1023/{size}",
                "Accept-Ranges": "bytes",
            },
        )

    # STATIC_BASE = "http://192.168.44.131:18080"  # 之後可換成 nginx/80/443
    # import urllib.parse
    # @flask_app.route("/audio/<song_name>")
    # def audio_file(song_name: str):
    #     song = get_song(song_name)
    #     if not song:
    #         abort(404)

    #     # 只把檔名露出去（避免路徑穿越）
    #     fname = os.path.basename(song.audio_path)
    #     return redirect(f"{STATIC_BASE}/{urllib.parse.quote(fname)}", code=302)

    @flask_app.route("/midi/<song_name>")
    def midi_file(song_name: str):
        song = get_song(song_name)
        if not song:
            abort(404)
        return send_file(song.midi_path, mimetype=_guess_mimetype(song.midi_path))

    @flask_app.route("/video/<song_name>")
    def video_file(song_name: str):
        song = get_song(song_name)
        if not song or not song.video_path:
            abort(404)
        playable = _ensure_browser_video(song.video_path)
        return send_file(playable, mimetype=_guess_mimetype(playable))

    @flask_app.route("/api/midi/<song_name>")
    def midi_api(song_name: str):
        song = get_song(song_name)
        if not song:
            abort(404)
        notes = midi_notes(song)
        annotations = read_annotations(song)
        for note in notes:
            key = (note["pitch"], note["start"])
            annotation = annotations.get(key) or {}
            note["noteKey"] = note_key_from_parts(note["pitch"], note["start"])
            note["annotation"] = {
                "tonalTechnique": annotation.get("tonalTechnique", ""),
                "articulation": annotation.get("articulation", ""),
                "stringId": annotation.get("stringId"),
                "position": annotation.get("position"),
                "finger": annotation.get("finger"),
                "legato": annotation.get("legato", 0) or 0,
            }
        duration = max((note["end"] for note in notes), default=0)
        return jsonify({"notes": notes, "duration": duration})

    @flask_app.route("/api/annotation/<song_name>", methods=["POST"])
    def annotation_api(song_name: str):
        song = get_song(song_name)
        if not song:
            abort(404)
        payload = request.get_json() or {}
        try:
            pitch = int(payload["pitch"])
            start = float(payload["start"])
            end = float(payload["end"])
        except (KeyError, ValueError, TypeError):
            abort(400, description="Invalid pitch/start/end")

        tonal = (payload.get("tonalTechnique") or "").strip()
        articulation = (payload.get("articulation") or "").strip()
        string_id = _safe_int(payload.get("stringId"))
        position = _safe_int(payload.get("position"))
        finger = _safe_int(payload.get("finger"))
        legato = _safe_int(payload.get("legato"))

        annotations = read_annotations(song)
        key = (pitch, start)
        base = annotations.get(key) or empty_annotation(pitch, start, end)
        updates = {
            "pitch": pitch,
            "start": start,
            "end": end,
            "tonalTechnique": tonal,
            "articulation": articulation,
        }
        if string_id is not None:
            updates["stringId"] = string_id
        if position is not None:
            updates["position"] = position
        if finger is not None:
            updates["finger"] = finger
        if legato is not None:
            updates["legato"] = legato

        annotations[key] = merge_annotation(base, updates)
        write_annotations(song, annotations)
        return jsonify({"status": "ok"})

    @flask_app.route("/api/legato/<song_name>", methods=["POST"])
    def legato_api(song_name: str):
        """Batch-update the legato flag for multiple notes at once."""
        song = get_song(song_name)
        if not song:
            abort(404)

        payload = request.get_json(silent=True) or {}
        note_updates = payload.get("notes") or []
        if not isinstance(note_updates, list):
            abort(400, description="notes must be a list")

        annotations = read_annotations(song)
        updated = 0

        for item in note_updates:
            try:
                p = int(item["pitch"])
                s = float(item["start"])
            except (KeyError, TypeError, ValueError):
                continue

            legato_val = _safe_int(item.get("legato"), 0) or 0
            key = (p, s)
            base = annotations.get(key)
            if base is None:
                end = _safe_float(item.get("end"), 0.0)
                base = empty_annotation(p, s, end)
            base["legato"] = legato_val
            annotations[key] = base
            updated += 1

        write_annotations(song, annotations)
        return jsonify({"status": "ok", "updated": updated})

    @flask_app.route("/api/ai/generate/<song_name>", methods=["POST"])
    def ai_generate(song_name: str):
        song = get_song(song_name)
        if not song:
            abort(404)

        payload = request.get_json(silent=True) or {}
        topk = _safe_int(payload.get("topk"), 3) or 3
        force = bool(payload.get("force"))

        notes = midi_notes(song)
        try:
            print(f"Generating predictions for {song.name}")
            result = generate_predictions(
                song.midi_path,
                song.audio_path,
                notes,
                cache_dir=song.midi_path.parent / "ai_cache",
                topk=topk,
                force=force,
            )
            print(f"Successfully generated predictions for {song.name}")
        except Exception as exc:  # pragma: no cover
            abort(500, description=f"Inference failed: {exc}")

        annotations = read_annotations(song)
        changed_count = 0
        predictions = []
        for pred in result["predictions"]:
            key = (pred["pitch"], float(pred["start"]))
            existing = annotations.get(key)
            existing_triplet = (
                existing.get("stringId"),
                existing.get("position"),
                existing.get("finger"),
            ) if existing else (None, None, None)
            proposed = (pred["stringId"], pred["position"], pred["finger"])
            changed = existing_triplet != proposed
            if changed:
                changed_count += 1
            pred["changed"] = changed
            predictions.append(pred)

        return jsonify(
            {
                "predictions": predictions,
                "noteCount": len(notes),
                "changedCount": changed_count,
            }
        )

    @flask_app.route("/api/ai/commit/<song_name>", methods=["POST"])
    def ai_commit(song_name: str):
        song = get_song(song_name)
        if not song:
            abort(404)

        payload = request.get_json(silent=True) or {}
        predictions = payload.get("predictions") or []
        if not isinstance(predictions, list):
            abort(400, description="predictions must be a list")

        annotations = read_annotations(song)
        updated = 0

        for pred in predictions:
            try:
                pitch = int(pred["pitch"])
                start = float(pred["start"])
                end = _safe_float(pred.get("end"), 0.0)
            except (KeyError, TypeError, ValueError):
                continue

            key = (pitch, start)
            base = annotations.get(key) or empty_annotation(pitch, start, end)
            updates = {
                "pitch": pitch,
                "start": start,
                "end": end if end else base.get("end", 0.0),
                "stringId": _safe_int(pred.get("stringId")),
                "position": _safe_int(pred.get("position")),
                "finger": _safe_int(pred.get("finger")),
            }
            annotations[key] = merge_annotation(base, updates)
            updated += 1

        write_annotations(song, annotations)
        return jsonify({"status": "ok", "updated": updated})

    @flask_app.route("/api/waveform/<song_name>")
    def waveform_api(song_name: str):
        song = get_song(song_name)
        if not song:
            abort(404)
        data = waveform_points(song)
        return jsonify(data)

    @flask_app.route("/api/status/<song_name>", methods=["GET", "POST"])
    def status_api(song_name: str):
        song = get_song(song_name)
        if not song:
            abort(404)

        folder = song.midi_path.parent
        if request.method == "GET":
            return jsonify({"completed": bool(read_completed_status(folder))})

        payload = request.get_json(silent=True) or {}
        completed = bool(payload.get("completed"))
        write_completed_status(folder, completed)
        return jsonify({"status": "ok", "completed": completed})

    return flask_app


app = create_app()


if __name__ == "__main__":
    app.run(debug=True)

