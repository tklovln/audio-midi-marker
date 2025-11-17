from __future__ import annotations

import mimetypes
import csv
from dataclasses import dataclass
from pathlib import Path
from typing import List

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
)

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
DEFAULT_BPM = 120
DEFAULT_TEMPO = mido.bpm2tempo(DEFAULT_BPM)
DEFAULT_VIEW_SECONDS = 10
WAVEFORM_BUCKETS = 4096
ANNOTATION_HEADERS = ["pitch", "start", "end", "tonalTechnique", "articulation"]


@dataclass
class Song:
    name: str
    title: str
    midi_path: Path
    audio_path: Path


def _format_title(name: str) -> str:
    # Simple title formatting for nicer display
    return name.replace("_", " ")


def discover_songs() -> List[Song]:
    if not DATA_DIR.exists():
        return []

    songs: List[Song] = []
    for folder in sorted(DATA_DIR.iterdir()):
        if not folder.is_dir():
            continue

        midi_path = next(folder.glob("*_midi.mid"), None)
        audio_path = None
        for ext in ("mp3", "wav"):
            audio_candidate = next(folder.glob(f"*_audio.{ext}"), None)
            if audio_candidate:
                audio_path = audio_candidate
                break

        if midi_path and audio_path:
            songs.append(
                Song(
                    name=folder.name,
                    title=_format_title(folder.name),
                    midi_path=midi_path,
                    audio_path=audio_path,
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
            annotations[key] = {
                "pitch": int(row.get("pitch", 0)),
                "start": float(row.get("start", 0.0)),
                "end": float(row.get("end", 0.0)),
                "tonalTechnique": row.get("tonalTechnique", ""),
                "articulation": row.get("articulation", ""),
            }
    return annotations


def write_annotations(song: Song, annotation_map):
    path = annotation_file(song)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as csvfile:
        writer = csv.DictWriter(csvfile, fieldnames=ANNOTATION_HEADERS)
        writer.writeheader()
        for key in sorted(annotation_map.keys(), key=lambda k: (k[0], k[1])):
            writer.writerow(annotation_map[key])


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


def create_app():
    flask_app = Flask(__name__)

    @flask_app.route("/")
    def index():
        songs = discover_songs()
        return render_template("index.html", songs=songs)

    @flask_app.route("/annotate/<song_name>")
    def annotate(song_name: str):
        song = get_song(song_name)
        if not song:
            abort(404)

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
            "audioUrl": url_for("audio_file", song_name=song.name),
            "midiApiUrl": url_for("midi_api", song_name=song.name),
            "waveformApiUrl": url_for("waveform_api", song_name=song.name),
            "annotationApiUrl": url_for("annotation_api", song_name=song.name),
            "windowSeconds": DEFAULT_VIEW_SECONDS,
            "palette": palette,
            "slicePaddingSeconds": 0.05,  # 50ms padding for midi note playback buffer
        }

        return render_template(
            "annotation.html",
            song=song,
            app_config=app_config,
        )

    @flask_app.route("/audio/<song_name>")
    def audio_file(song_name: str):
        song = get_song(song_name)
        if not song:
            abort(404)
        return send_file(song.audio_path, mimetype=_guess_mimetype(song.audio_path))

    @flask_app.route("/midi/<song_name>")
    def midi_file(song_name: str):
        song = get_song(song_name)
        if not song:
            abort(404)
        return send_file(song.midi_path, mimetype=_guess_mimetype(song.midi_path))

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
            note["annotation"] = {
                "tonalTechnique": annotation.get("tonalTechnique", ""),
                "articulation": annotation.get("articulation", ""),
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

        annotations = read_annotations(song)
        annotations[(pitch, start)] = {
            "pitch": pitch,
            "start": start,
            "end": end,
            "tonalTechnique": tonal,
            "articulation": articulation,
        }
        write_annotations(song, annotations)
        return jsonify({"status": "ok"})

    @flask_app.route("/api/waveform/<song_name>")
    def waveform_api(song_name: str):
        song = get_song(song_name)
        if not song:
            abort(404)
        data = waveform_points(song)
        return jsonify(data)

    return flask_app


app = create_app()


if __name__ == "__main__":
    app.run(debug=True)

