class AnnotationApp {
    constructor(config) {
        this.config = config;
        this.notes = [];
        this.duration = 0;
        this.viewStart = 0;
        this.viewSize = config.windowSeconds || 10;
        this.pitchBounds = { min: 21, max: 108 };
        this.wave = null;
        this.waveReady = false;
        this.currentTime = 0;

        this.dom = {
            waveformCanvas: document.getElementById("waveform-canvas"),
            waveformAudio: document.getElementById("waveform-audio"),
            waveformWrapper: document.getElementById("waveform-wrapper"),
            waveformCursor: document.getElementById("waveform-cursor"),
            midiGrid: document.getElementById("midi-grid"),
            midiCursor: document.getElementById("midi-cursor"),
            midiWrapper: document.getElementById("midi-wrapper"),
            noteButtons: document.getElementById("note-buttons"),
            noteReadout: document.getElementById("note-readout"),
            viewportSlider: document.getElementById("viewport-slider"),
            viewportLabel: document.getElementById("viewport-label"),
            windowSelect: document.getElementById("window-size"),
            playButton: document.getElementById("play-pause"),
            prevButton: document.getElementById("jump-prev"),
            nextButton: document.getElementById("jump-next"),
            annotationNoteLabel: document.getElementById("annotation-note-label"),
            tonalSelect: document.getElementById("tonal-technique"),
            articulationSelect: document.getElementById("articulation"),
            annotationStatus: document.getElementById("annotation-status"),
        };
        this.waveformData = null;
        this.slicePadding =
            typeof config.slicePaddingSeconds === "number"
                ? config.slicePaddingSeconds
                : 0.005;
        this.buttonFlashTimers = new Map();
        this.selectedNote = null;
        this.isSavingAnnotation = false;
        this.statusTimer = null;
        this.annotationSaveTimer = null;
        this.suspendAutosave = false;

        window.addEventListener("resize", () => {
            if (!this.waveReady) return;
            window.requestAnimationFrame(() => this.renderWaveform());
        });
    }

    async init() {
        await this.loadMidi();
        await this.loadWaveform();
        this.updateSliderBounds();
        this.setupWaveform();
        this.setupControls();
        this.renderNoteButtons();
        this.renderMidi();
        this.renderWaveform();
    }

    async loadMidi() {
        try {
            const response = await fetch(this.config.midiApiUrl);
            const payload = await response.json();
            const rawNotes = payload.notes || [];
            this.notes = rawNotes.map((note) => ({
                ...note,
                annotation: {
                    tonalTechnique: note.annotation?.tonalTechnique || "",
                    articulation: note.annotation?.articulation || "",
                },
            }));
            this.duration = payload.duration || 0;
            if (this.notes.length) {
                const pitches = this.notes.map((n) => n.pitch);
                this.pitchBounds = {
                    min: Math.min(...pitches),
                    max: Math.max(...pitches),
                };
            }
        } catch (error) {
            console.error("Failed to load MIDI data", error);
        }
    }

    async loadWaveform() {
        if (!this.config.waveformApiUrl) {
            return;
        }
        try {
            const response = await fetch(this.config.waveformApiUrl);
            if (!response.ok) {
                throw new Error(`Waveform fetch failed (${response.status})`);
            }
            const payload = await response.json();
            if (
                payload &&
                Array.isArray(payload.min) &&
                Array.isArray(payload.max) &&
                payload.bucketDuration
            ) {
                this.waveformData = {
                    min: payload.min,
                    max: payload.max,
                    bucketDuration: payload.bucketDuration,
                };
                if (payload.duration) {
                    this.duration = Math.max(this.duration, payload.duration);
                }
                this.renderWaveform();
            }
        } catch (error) {
            console.error("Failed to load waveform data", error);
        }
    }

    setupWaveform() {
        if (!window.WaveSurfer) {
            console.error("WaveSurfer is not available");
            return;
        }

        this.wave = WaveSurfer.create({
            container: this.dom.waveformAudio || this.dom.waveformWrapper,
            backend: "WebAudio",
            waveColor: "transparent",
            progressColor: "transparent",
            cursorWidth: 0,
            height: 0,
            normalize: true,
            hideScrollbar: true,
            interact: false,
        });

        this.wave.load(this.config.audioUrl);

        this.wave.on("ready", () => {
            this.waveReady = true;
            this.duration = Math.max(this.duration, this.wave.getDuration() || 0);
            this.updateSliderBounds();
            this.dom.playButton.disabled = false;
            this.dom.playButton.textContent = "Play";
            this.renderWaveform();
        });

        this.wave.on("audioprocess", (time) => this.updateCursor(time));
        this.wave.on("seek", () => this.updateCursor(this.wave.getCurrentTime()));
        this.wave.on("interaction", () => this.updateCursor(this.wave.getCurrentTime()));
        this.wave.on("finish", () => this.setPlaying(false));

        this.dom.playButton.addEventListener("click", () => {
            this.flashButton(this.dom.playButton);
            if (!this.waveReady) return;
            if (this.wave.isPlaying()) {
                this.wave.pause();
                this.setPlaying(false);
            } else {
                this.centerViewOn(this.currentTime);
                this.wave.play();
                this.setPlaying(true);
            }
        });

        this.renderWaveform();
    }

    setupControls() {
        this.dom.viewportSlider.addEventListener("input", (event) => {
            this.setViewStart(parseFloat(event.target.value));
        });

        this.dom.windowSelect.value = String(this.viewSize);
        this.dom.windowSelect.addEventListener("change", (event) => {
            this.viewSize = parseFloat(event.target.value) || this.viewSize;
            this.updateSliderBounds();
            this.renderMidi();
            this.renderWaveform();
        });

        if (this.dom.prevButton) {
            this.dom.prevButton.addEventListener("click", () => {
                this.flashButton(this.dom.prevButton);
                this.playNeighborNote("prev");
            });
        }

        if (this.dom.nextButton) {
            this.dom.nextButton.addEventListener("click", () => {
                this.flashButton(this.dom.nextButton);
                this.playNeighborNote("next");
            });
        }

        ["tonalSelect", "articulationSelect"].forEach((key) => {
            const control = this.dom[key];
            if (!control) return;
            ["change", "input"].forEach((eventName) => {
                control.addEventListener(eventName, () => {
                    if (this.suspendAutosave) return;
                    this.queueAnnotationSave();
                });
            });
        });

        this.handleKeydown = (event) => {
            const isSpace =
                event.code === "Space" ||
                event.key === " " ||
                event.key === "Spacebar";

            if (!isSpace && event.code !== "ArrowRight" && event.code !== "ArrowLeft") {
                return;
            }
            if (event.code === "ArrowRight") {
                event.preventDefault();
                this.flashButton(this.dom.nextButton);
                this.playNeighborNote("next");
                return;
            }

            if (event.code === "ArrowLeft") {
                event.preventDefault();
                this.flashButton(this.dom.prevButton);
                this.playNeighborNote("prev");
                return;
            }

            if (!isSpace) return;

            const activeTag =
                document.activeElement?.tagName?.toLowerCase() || "";
            const isTyping =
                activeTag === "input" ||
                activeTag === "textarea" ||
                document.activeElement?.isContentEditable;

            if (isTyping) return;

            event.preventDefault();
            this.flashButton(this.dom.playButton);
            if (!this.waveReady) return;

            if (this.wave.isPlaying()) {
                this.wave.pause();
                this.setPlaying(false);
            } else {
                this.centerViewOn(this.currentTime);
                this.wave.play();
                this.setPlaying(true);
            }
        };
        document.addEventListener("keydown", this.handleKeydown);

        this.dom.midiWrapper.addEventListener("click", (event) => {
            const rect = this.dom.midiWrapper.getBoundingClientRect();
            const ratio = (event.clientX - rect.left) / rect.width;
            const target = this.viewStart + ratio * this.viewSize;
            this.seekTo(target);
        });

        if (this.dom.waveformWrapper) {
            this.dom.waveformWrapper.addEventListener("click", (event) => {
                const rect = this.dom.waveformWrapper.getBoundingClientRect();
                const ratio = (event.clientX - rect.left) / rect.width;
                const target = this.viewStart + ratio * this.viewSize;
                this.seekTo(target);
            });
        }
    }

    renderMidi() {
        const { midiGrid } = this.dom;
        midiGrid.innerHTML = "";

        const viewEnd = this.viewStart + this.viewSize;
        const visibleNotes = this.notes.filter(
            (note) => note.end > this.viewStart && note.start < viewEnd
        );

        visibleNotes.forEach((note) => {
            const clippedStart = Math.max(note.start, this.viewStart);
            const clippedEnd = Math.min(note.end, viewEnd);
            const width = Math.max(((clippedEnd - clippedStart) / this.viewSize) * 100, 1);
            const left = ((clippedStart - this.viewStart) / this.viewSize) * 100;
            const pitchRange = this.pitchBounds.max - this.pitchBounds.min || 1;
            const top =
                ((this.pitchBounds.max - note.pitch) / pitchRange) * 100;

            const button = document.createElement("button");
            button.className = "midi-note";
            button.style.left = `${left}%`;
            button.style.width = `${width}%`;
            button.style.top = `calc(${top}% - 14px)`;
            button.style.height = "28px";
            const pitchLabel = this.getPitchLabel(note.pitch);
            button.textContent = pitchLabel;
            button.title = `Pitch ${pitchLabel} (${note.start.toFixed(2)}s → ${note.end.toFixed(2)}s)`;

            button.addEventListener("mouseenter", () => this.updateNoteReadout(note));
            button.addEventListener("focus", () => this.updateNoteReadout(note));
            button.addEventListener("click", (e) => {
                e.stopPropagation();
                this.focusNote(note);
                this.playSlice(note.start, note.end);
            });

            midiGrid.appendChild(button);
        });

        this.updateCursor(this.currentTime);
    }

    renderNoteButtons() {
        const container = this.dom.noteButtons;
        if (!container) {
            return;
        }
        container.innerHTML = "";
        const fragment = document.createDocumentFragment();

        this.notes.forEach((note, index) => {
            const button = document.createElement("button");
            button.className = "note-pill";
            button.textContent = `#${index + 1} · ${this.getPitchLabel(note.pitch)}`;
            button.addEventListener("click", () => {
                this.focusNote(note);
                this.playSlice(note.start, note.end);
            });
            fragment.appendChild(button);
        });

        if (!fragment.childNodes.length) {
            const empty = document.createElement("p");
            empty.textContent = "No note data in this range.";
            empty.className = "note-readout";
            container.appendChild(empty);
        } else {
            container.appendChild(fragment);
        }
    }

    updateCursor(time = 0) {
        this.currentTime = time;
        const viewEnd = this.viewStart + this.viewSize;

        if (time < this.viewStart || time > viewEnd) {
            this.setCursorOpacity(0);
            return;
        }

        const percentage = ((time - this.viewStart) / this.viewSize) * 100;
        this.setCursorOpacity(1);
        this.setCursorPosition(percentage);

        const shouldFollow =
            this.wave &&
            this.wave.isPlaying() &&
            (!this.dom.viewportSlider || !this.dom.viewportSlider.matches(":active"));

        if (shouldFollow && time > viewEnd - this.viewSize * 0.2) {
            const autoStart = Math.min(
                Math.max(time - this.viewSize * 0.8, 0),
                Math.max(this.duration - this.viewSize, 0)
            );
            if (Math.abs(autoStart - this.viewStart) >= 0.1) {
                this.setViewStart(autoStart, { silentSlider: true });
            }
        }
    }

    centerViewOn(time, options = {}) {
        if (!this.duration || !Number.isFinite(time)) {
            return;
        }
        const desiredStart = Math.min(
            Math.max(time - this.viewSize * 0.5, 0),
            Math.max(this.duration - this.viewSize, 0)
        );
        this.setViewStart(desiredStart, { silentSlider: options.silentSlider ?? false });
    }

    setCursorOpacity(value) {
        const cursors = [this.dom.midiCursor, this.dom.waveformCursor];
        cursors.forEach((cursor) => {
            if (cursor) {
                cursor.style.opacity = String(value);
            }
        });
    }

    setCursorPosition(percentage) {
        const cursors = [this.dom.midiCursor, this.dom.waveformCursor];
        cursors.forEach((cursor) => {
            if (cursor) {
                cursor.style.left = `${percentage}%`;
            }
        });
    }

    updateNoteReadout(note) {
        if (!this.dom.noteReadout) return;
        const label = this.getPitchLabel(note.pitch);
        this.dom.noteReadout.textContent = `Pitch ${label} · ${note.start.toFixed(2)}s → ${note.end.toFixed(2)}s`;
    }

    playNeighborNote(direction) {
        if (!this.notes.length) return;
        const epsilon = 0.0005;
        const time = this.currentTime;
        let target = null;

        if (direction === "next") {
            target = this.notes.find((note) => note.start > time + epsilon) ?? null;
        } else {
            for (let i = this.notes.length - 1; i >= 0; i -= 1) {
                if (this.notes[i].start < time - epsilon) {
                    target = this.notes[i];
                    break;
                }
            }
        }

        if (!target) {
            target = direction === "next" ? this.notes[this.notes.length - 1] : this.notes[0];
        }

        if (target) {
        this.focusNote(target);
            this.playSlice(target.start, target.end);
        }
    }

    flashButton(button) {
        if (!button) return;
        button.classList.add("is-pressed");
        const existing = this.buttonFlashTimers.get(button);
        if (existing) {
            clearTimeout(existing);
        }
        const timer = window.setTimeout(() => {
            button.classList.remove("is-pressed");
            this.buttonFlashTimers.delete(button);
        }, 180);
        this.buttonFlashTimers.set(button, timer);
    }

    getPitchLabel(midiNote) {
        const names = ["c", "c", "d", "d", "e", "f", "f", "g", "g", "a", "a", "b"];
        return names[midiNote % 12] || "c";
    }

    focusNote(note) {
        if (!note) return;
        this.selectedNote = note;
        const label = `${this.getPitchLabel(note.pitch)} · ${note.start.toFixed(2)}s`;
        if (this.dom.annotationNoteLabel) {
            this.dom.annotationNoteLabel.textContent = `Selected: ${label}`;
        }
        const tonal = note.annotation?.tonalTechnique || "";
        const articulation = note.annotation?.articulation || "";
        this.suspendAutosave = true;
        if (this.dom.tonalSelect) {
            this.dom.tonalSelect.value = tonal;
        }
        if (this.dom.articulationSelect) {
            this.dom.articulationSelect.value = articulation;
        }
        this.suspendAutosave = false;
        this.setAnnotationStatus("Editing note…", false);
    }

    queueAnnotationSave() {
        if (!this.selectedNote || this.isSavingAnnotation) {
            return;
        }
        if (this.annotationSaveTimer) {
            clearTimeout(this.annotationSaveTimer);
        }
        this.annotationSaveTimer = window.setTimeout(() => {
            this.annotationSaveTimer = null;
            this.saveAnnotation({ auto: true });
        }, 250);
    }

    async saveAnnotation({ auto = false } = {}) {
        if (!this.config.annotationApiUrl || !this.selectedNote || this.isSavingAnnotation) {
            return;
        }

        const tonal = this.dom.tonalSelect?.value || "";
        const articulation = this.dom.articulationSelect?.value || "";

        const payload = {
            pitch: this.selectedNote.pitch,
            start: this.selectedNote.start,
            end: this.selectedNote.end,
            tonalTechnique: tonal,
            articulation,
        };

        this.isSavingAnnotation = true;
        this.setAnnotationStatus(auto ? "Saving…" : "Saving annotation…", false);

        try {
            const response = await fetch(this.config.annotationApiUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });
            if (!response.ok) {
                throw new Error(`Save failed (${response.status})`);
            }
            this.selectedNote.annotation = {
                tonalTechnique: tonal,
                articulation,
            };
            this.setAnnotationStatus(auto ? "Changes autosaved." : "Annotation saved.", false);
        } catch (error) {
            console.error("Failed to save annotation", error);
            this.setAnnotationStatus("Save failed. Please try again.", true);
        } finally {
            this.isSavingAnnotation = false;
        }
    }

    setAnnotationStatus(message, isError) {
        if (!this.dom.annotationStatus) return;
        this.dom.annotationStatus.textContent = message;
        this.dom.annotationStatus.style.color = isError ? "#e16981" : "var(--muted)";
        if (this.statusTimer) {
            clearTimeout(this.statusTimer);
        }
        if (!isError && message) {
            this.statusTimer = window.setTimeout(() => {
                if (this.dom.annotationStatus) {
                    this.dom.annotationStatus.textContent = "";
                }
            }, 3000);
        }
    }

    updateSliderBounds() {
        const max = Math.max(this.duration - this.viewSize, 0);
        this.dom.viewportSlider.max = max.toFixed(2);
        this.dom.viewportSlider.value = Math.min(this.viewStart, max).toFixed(2);
        this.updateViewportLabel();
    }

    updateViewportLabel() {
        if (!this.dom.viewportLabel) return;
        const start = this.viewStart.toFixed(2);
        const end = Math.min(this.viewStart + this.viewSize, this.duration).toFixed(2);
        this.dom.viewportLabel.textContent = `${start}s – ${end}s`;
    }

    setViewStart(start, options = {}) {
        const max = Math.max(this.duration - this.viewSize, 0);
        this.viewStart = Math.min(Math.max(start, 0), max);
        const slider = this.dom.viewportSlider;
        const userInteracting = slider?.matches(":active");
        if (
            slider &&
            (!options.silentSlider || !userInteracting)
        ) {
            slider.value = this.viewStart.toFixed(2);
        }
        this.updateViewportLabel();
        this.renderMidi();
        this.renderWaveform();
    }

    seekTo(seconds) {
        if (!this.waveReady) return;
        this.wave.setTime(Math.max(0, Math.min(seconds, this.duration)));
        this.updateCursor(seconds);
    }

    // Playing a slice of the audio waveform from given midi note start and end times
    // with 10ms padding for mido note playback buffer
    // and centering the view on the start of the slice
    playSlice(start, end) {
        if (!this.waveReady) return;
        const padding = this.slicePadding;
        const adjustedStart = Math.max(start - padding, 0);
        const adjustedEnd = Math.min(end + padding, this.duration);
        this.centerViewOn(adjustedStart, { silentSlider: false });
        this.currentTime = adjustedStart;
        this.updateCursor(this.currentTime);
        if (adjustedEnd <= adjustedStart) {
            this.seekTo(adjustedStart);
            this.wave.play();
        } else {
            this.wave.play(adjustedStart, adjustedEnd);
        }
        this.setPlaying(true);
    }

    setPlaying(isPlaying) {
        if (!this.dom.playButton) return;
        this.dom.playButton.textContent = isPlaying ? "Pause" : "Play";
    }

    renderWaveform() {
        const canvas = this.dom.waveformCanvas;
        const data = this.waveformData;
        if (
            !canvas ||
            !data ||
            !Array.isArray(data.min) ||
            !Array.isArray(data.max) ||
            !data.bucketDuration
        ) {
            return;
        }
        const { min: mins, max: maxs, bucketDuration } = data;
        const bucketCount = Math.min(mins.length, maxs.length);
        if (!bucketCount || data.bucketDuration <= 0) {
            return;
        }
        const context = canvas.getContext("2d");
        if (!context) {
            return;
        }

        const wrapper = this.dom.waveformWrapper || canvas;
        const width = wrapper.clientWidth || 1;
        const height = wrapper.clientHeight || 160;
        const dpr = window.devicePixelRatio || 1;

        if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
            canvas.width = width * dpr;
            canvas.height = height * dpr;
            canvas.style.width = `${width}px`;
            canvas.style.height = `${height}px`;
        }

        context.save();
        context.scale(dpr, dpr);
        context.clearRect(0, 0, width, height);

        let globalMax = 0;
        for (let i = 0; i < bucketCount; i += 1) {
            const hi = Math.abs(maxs[i] || 0);
            const lo = Math.abs(mins[i] || 0);
            if (hi > globalMax) globalMax = hi;
            if (lo > globalMax) globalMax = lo;
        }
        const gain = globalMax > 0 ? 1 / globalMax : 1;

        const midY = height / 2;
        const amplitude = (height / 2) * 0.95;
        const secondsPerPixel = this.viewSize / Math.max(width, 1);
        context.strokeStyle = "#7f55b1";
        context.lineWidth = 1;
        context.beginPath();

        for (let x = 0; x < width; x += 1) {
            const time = this.viewStart + x * secondsPerPixel;
            const idx = Math.min(
                bucketCount - 1,
                Math.max(0, Math.floor(time / bucketDuration))
            );
            const peakMax = (maxs[idx] || 0) * gain;
            const peakMin = (mins[idx] || 0) * gain;
            const top = midY - peakMax * amplitude;
            const bottom = midY - peakMin * amplitude;
            context.moveTo(x, top);
            context.lineTo(x, bottom);
        }

        context.stroke();
        context.restore();
    }
}

document.addEventListener("DOMContentLoaded", () => {
    const config = loadAppConfig();
    if (!config || !document.getElementById("annotation-app")) {
        return;
    }
    const app = new AnnotationApp(config);
    app.init();
});

function loadAppConfig() {
    if (window.APP_CONFIG) {
        return window.APP_CONFIG;
    }
    const script = document.getElementById("app-config");
    if (!script) {
        return null;
    }
    try {
        window.APP_CONFIG = JSON.parse(script.textContent);
        return window.APP_CONFIG;
    } catch (error) {
        console.error("Failed to parse APP_CONFIG", error);
        return null;
    }
}

