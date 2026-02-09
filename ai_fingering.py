from __future__ import annotations

import logging
import sys
from collections import defaultdict
from functools import lru_cache
from pathlib import Path
from typing import Dict, Iterable, List, Sequence, Tuple

import librosa
import numpy as np
from midi2audio import FluidSynth
from tensorflow import keras

# Add project repo for direct imports of the reference inference code
BASE_DIR = Path(__file__).resolve().parent
MODEL_REPO = BASE_DIR.parent / "Violin-Fingering-Generation-Through-Audio-Symbolic-Fusion" / "Code"
sys.path.insert(0, str(MODEL_REPO))

import inference as vf_inference  # noqa: E402  (import after sys.path mutation)

LOGGER = logging.getLogger(__name__)

CHECKPOINT_PATH = MODEL_REPO / "checkpoints" / "audio_symbolic_model.h5"
SOUNDFONT_PATH = MODEL_REPO / "default-GM.sf2"

# Constants reused from generate_audio_feature.py
N_FFT = 4410
HOP_SIZE = 2205
EPSILON = 1e-9


def _is_up_to_date(target: Path, sources: Iterable[Path]) -> bool:
    if not target.exists():
        return False
    target_mtime = target.stat().st_mtime
    for src in sources:
        if not Path(src).exists():
            return False
        if target_mtime < Path(src).stat().st_mtime:
            return False
    return True


def _parse_float(value, default: float = 0.0) -> float:
    try:
        return float(value)
    except Exception:
        return default


def _parse_int(value, default: int | None = None) -> int | None:
    try:
        return int(value)
    except Exception:
        return default


def note_key_from_parts(pitch: int, start: float) -> str:
    return f"{int(pitch)}@{float(start):.6f}"


def make_symbolic_array(notes: Sequence[Dict]) -> np.ndarray:
    """Convert note dicts to (N,3) [pitch, onset, duration]."""
    symbolic = np.zeros((len(notes), 3), dtype=np.float32)
    for idx, note in enumerate(notes):
        pitch = _parse_int(note.get("pitch"), 0) or 0
        start = _parse_float(note.get("start"), 0.0)
        end = _parse_float(note.get("end"), start)
        symbolic[idx] = [pitch, start, max(end - start, 0.0)]
    return symbolic


def estimate_same_onset_flags(notes: Sequence[Dict], tol: float = 1e-3) -> List[int]:
    """Mimic generate_audio_feature.py logic for chord handling."""
    flags: List[int] = []
    prev_start: float | None = None
    for note in notes:
        start = _parse_float(note.get("start"), 0.0)
        if prev_start is None:
            flags.append(1)
        else:
            flags.append(0 if abs(start - prev_start) <= tol else 1)
        prev_start = start
    return flags


def _time_list_from_flags(durations: Sequence[float], onset_flags: Sequence[int]) -> List[float]:
    onset = 0.0
    previous_duration = 0.0
    time_list: List[float] = []
    for dur, flag in zip(durations, onset_flags):
        if flag == 1:
            onset += previous_duration
            previous_duration = dur
        time_list.append(onset)
    return time_list


def _nearest_mapping(mapping: Dict[int, List[int]], idx: int) -> List[int]:
    if idx in mapping:
        return mapping[idx]
    if not mapping:
        return [0]
    keys = sorted(mapping.keys())
    nearest = min(keys, key=lambda k: abs(k - idx))
    return mapping[nearest]


def synthesize_midi(midi_path: Path, out_path: Path) -> Path:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    fs = FluidSynth(str(SOUNDFONT_PATH))
    fs.midi_to_audio(str(midi_path), str(out_path))
    return out_path


def extract_audio_features(
    recording_path: Path,
    midi_path: Path,
    notes: Sequence[Dict],
    cache_dir: Path | None = None,
    force: bool = False,
) -> np.ndarray:
    """
    Reproduce the generate_audio_feature.py flow to build per-note audio features.
    """
    cache_dir = cache_dir or midi_path.parent
    cache_dir.mkdir(parents=True, exist_ok=True)
    audio_feature_path = cache_dir / "ai_audio_feature.npy"
    midi_render_path = cache_dir / "ai_midi_render.wav"

    if not force and _is_up_to_date(audio_feature_path, [recording_path, midi_path]):
        LOGGER.info("Reusing cached audio features at %s", audio_feature_path)
        return np.load(audio_feature_path)

    annotated_pitch = [int(n.get("pitch", 0)) for n in notes]
    annotated_duration = [_parse_float(n.get("end"), 0.0) - _parse_float(n.get("start"), 0.0) for n in notes]
    annotated_duration = [max(d, 0.0) for d in annotated_duration]
    annotated_type = estimate_same_onset_flags(notes)
    time_list = _time_list_from_flags(annotated_duration, annotated_type)

    # Synthesize MIDI to audio (following generate_audio_feature.py)
    synth_path = synthesize_midi(midi_path, midi_render_path)

    x_recording, sr = librosa.load(str(recording_path))
    x_synth, _ = librosa.load(str(synth_path))

    x_recording_chroma = librosa.feature.chroma_stft(
        y=x_recording, sr=sr, tuning=0, norm=2, hop_length=HOP_SIZE, n_fft=N_FFT
    )
    x_synth_chroma = librosa.feature.chroma_stft(
        y=x_synth, sr=sr, tuning=0, norm=2, hop_length=HOP_SIZE, n_fft=N_FFT
    )
    _, wp = librosa.sequence.dtw(X=x_recording_chroma, Y=x_synth_chroma, metric="euclidean")

    s_recording = np.abs(librosa.stft(x_recording, hop_length=HOP_SIZE, n_fft=N_FFT))

    midi_to_audio: Dict[int, List[int]] = defaultdict(list)
    for a, b in wp:
        midi_to_audio[b].append(a)

    audio_features: List[np.ndarray] = []
    for idx in range(len(annotated_pitch)):
        time_start = int(time_list[idx] * (sr / HOP_SIZE))
        time_end = min(
            int((time_list[idx] + annotated_duration[idx]) * (sr / HOP_SIZE)),
            x_synth_chroma.shape[1] - 1,
        )
        start_mapping = _nearest_mapping(midi_to_audio, time_start)
        end_mapping = _nearest_mapping(midi_to_audio, time_end)
        s2_to_s1_start = start_mapping[-1]
        s2_to_s1_end = end_mapping[0]
        start = int(s2_to_s1_start)
        end = min(int(s2_to_s1_end) + 1, s_recording.shape[1])
        if end <= start:
            end = min(start + 1, s_recording.shape[1])
        audio_slice = s_recording[:, start:end].copy()
        audio_features.append(np.mean(audio_slice, axis=1))

    audio_feature = np.array(audio_features, dtype=np.float32)
    np.save(audio_feature_path, audio_feature)
    return audio_feature


@lru_cache(maxsize=1)
def _load_model(checkpoint: str):
    LOGGER.info("Loading fingering model from %s", checkpoint)
    return keras.models.load_model(checkpoint)


def run_model(
    symbolic: np.ndarray,
    audio_features: np.ndarray,
    topk: int = 3,
    checkpoint_path: Path = CHECKPOINT_PATH,
) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    if symbolic.shape[0] != audio_features.shape[0]:
        raise ValueError("Symbolic and audio feature counts must match.")
    if audio_features.shape[1] != vf_inference.audio_dim:
        raise ValueError(f"Audio feature dim must be {vf_inference.audio_dim}")

    sym_cls = vf_inference.preprocess_symbolic(symbolic[:, :3])
    sym_seq, audio_seq = vf_inference.make_sequences(sym_cls, audio_features, gap_len=vf_inference.seq_len)

    model = _load_model(str(checkpoint_path))
    probs = model.predict(
        [sym_seq[:, :, 0], sym_seq[:, :, 1], sym_seq[:, :, 2], audio_seq],
        verbose=0,
    )
    probs[:, :, :2] = 0  # ignore padding classes

    note_count = symbolic.shape[0]
    probs_flat = vf_inference.flatten_sequences(probs, note_count)
    topk_idx = np.argsort(-probs_flat, axis=-1)[..., :topk]
    decoded_topk = np.zeros((note_count, topk, 3), dtype=np.int32)
    for n in range(note_count):
        for k in range(topk):
            decoded_topk[n, k] = vf_inference.decode_spf(int(topk_idx[n, k]))
    return decoded_topk, topk_idx, probs_flat


def generate_predictions(
    midi_path: Path,
    audio_path: Path,
    notes: Sequence[Dict],
    *,
    cache_dir: Path | None = None,
    topk: int = 3,
    force: bool = False,
) -> Dict:
    """
    Full pipeline: symbolic + audio feature extraction + model inference.
    Returns a dict with per-note predictions.
    """
    if not notes:
        raise ValueError("No note data available for inference.")

    cache_dir = cache_dir or midi_path.parent / "ai_cache"
    cache_dir.mkdir(parents=True, exist_ok=True)

    symbolic = make_symbolic_array(notes)
    symbolic_path = cache_dir / "ai_symbolic.npy"
    if force or not _is_up_to_date(symbolic_path, [midi_path]):
        np.save(symbolic_path, symbolic)
    else:
        try:
            symbolic = np.load(symbolic_path)
        except Exception:
            np.save(symbolic_path, symbolic)

    audio_features = extract_audio_features(audio_path, midi_path, notes, cache_dir=cache_dir, force=force)
    decoded_topk, topk_idx, probs_flat = run_model(symbolic, audio_features, topk=topk)

    predictions = []
    for idx, note in enumerate(notes):
        top1 = decoded_topk[idx, 0]
        predictions.append(
            {
                "pitch": int(note.get("pitch", 0)),
                "start": _parse_float(note.get("start"), 0.0),
                "end": _parse_float(note.get("end"), 0.0),
                "stringId": int(top1[0]),
                "position": int(top1[1]),
                "finger": int(top1[2]),
                "topkDecoded": decoded_topk[idx].tolist(),
                "topkIndices": topk_idx[idx].tolist(),
                "noteKey": note_key_from_parts(note.get("pitch", 0), note.get("start", 0.0)),
            }
        )

    return {
        "predictions": predictions,
        "symbolic": symbolic,
        "audio_features": audio_features,
    }







