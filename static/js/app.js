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
            tonalPie: document.getElementById("pie-tonal"),
            articulationPie: document.getElementById("pie-articulation"),
            tonalPieLabel: document.getElementById("pie-tonal-label"),
            articulationPieLabel: document.getElementById("pie-articulation-label"),
            annotationStatus: document.getElementById("annotation-status"),
            videoPanel: document.getElementById("video-panel"),
            videoPlayer: document.getElementById("video-player"),
            videoOverlay: document.getElementById("video-overlay"),
            trackingCanvas: document.getElementById("tracking-canvas"),
            aiGenerateButton: document.getElementById("ai-generate"),
            aiModal: document.getElementById("ai-modal"),
            aiModalSummary: document.getElementById("ai-modal-summary"),
            aiModalDiff: document.getElementById("ai-modal-diff"),
            aiModalCancel: document.getElementById("ai-modal-cancel"),
            aiModalCommit: document.getElementById("ai-modal-commit"),
            stringPie: document.getElementById("pie-string"),
            positionPie: document.getElementById("pie-position"),
            fingerPie: document.getElementById("pie-finger"),
            stringPieLabel: document.getElementById("pie-string-label"),
            positionPieLabel: document.getElementById("pie-position-label"),
            fingerPieLabel: document.getElementById("pie-finger-label"),
            completionToggle: document.getElementById("completion-toggle"),
        };
        this.completed = !!config.completed;
        this.waveformData = null;
        this.hands = null;
        this.handsReady = false;
        this.handsError = false;
        this.slicePadding =
            typeof config.slicePaddingSeconds === "number"
                ? config.slicePaddingSeconds
                : 0.005;
        this.buttonFlashTimers = new Map();
        this.legatoRanges = [];
        this.legatoDragState = null;
        this.legatoDragPreventClick = false;
        this.pieColors = ["#ffe1e0", "#eeece1", "#9b7ebd", "#f49bab", "#7f55b1", "#e16981"];
        this.selectedNote = null;
        this.isSavingAnnotation = false;
        this.statusTimer = null;
        this.annotationSaveTimer = null;
        this.pendingAnnotationSave = null;
        this.annotationSaveQueue = [];
        this.suspendAutosave = false;
        this.pieCharts = {};
        this.aiSuggestions = new Map();
        this.aiPending = false;
        this.aiChangedCount = 0;
        this.tonalOptions = [
            { value: "", label: "none", abbrev: "Non" },
            { value: "pizzicato", label: "pizzicato", abbrev: "PIZ" },
            { value: "harmonics", label: "harmonics", abbrev: "HAR" },
            // { value: "muted", label: "muted", abbrev: "MUT" },
            // { value: "sul ponticello", label: "sul ponticello", abbrev: "SPT" },
            // { value: "sul tasto", label: "sul tasto", abbrev: "STS" },
        ];
        this.articulationOptions = [
            { value: "", label: "none", abbrev: "NON" },
            { value: "release", label: "release", abbrev: "REL" },
            { value: "staccato", label: "staccato", abbrev: "STC" },
            { value: "spiccato", label: "spiccato", abbrev: "SPC" },
            // { value: "accent", label: "accent", abbrev: "ACC" },
            // { value: "legato", label: "legato", abbrev: "LEG" },
            // { value: "tenuto", label: "tenuto", abbrev: "TEN" },
            // { value: "marcato", label: "marcato", abbrev: "MAR" },
        ];
        this.stringOptions = [
            { value: "", label: "none", abbrev: "–" },
            { value: 0, label: "G string", abbrev: "G" },
            { value: 1, label: "D string", abbrev: "D" },
            { value: 2, label: "A string", abbrev: "A" },
            { value: 3, label: "E string", abbrev: "E" },
        ];
        this.positionOptions = [
            { value: "", label: "none", abbrev: "–" },
            { value: 1, label: "1st pos", abbrev: "1" },
            { value: 2, label: "2nd pos", abbrev: "2" },
            { value: 3, label: "3rd pos", abbrev: "3" },
            { value: 4, label: "4th pos", abbrev: "4" },
            { value: 5, label: "5th pos", abbrev: "5" },
            { value: 6, label: "6th pos", abbrev: "6" },
            { value: 7, label: "7th pos", abbrev: "7" },
            { value: 8, label: "8th pos", abbrev: "8" },
            { value: 9, label: "9th pos", abbrev: "9" },
            { value: 10, label: "10th pos", abbrev: "10" },
            { value: 11, label: "11th pos", abbrev: "11" },
            { value: 12, label: "12th pos", abbrev: "12" },
        ];
        this.fingerOptions = [
            { value: "", label: "none", abbrev: "–" },
            { value: 0, label: "Open", abbrev: "0" },
            { value: 1, label: "1st finger", abbrev: "1" },
            { value: 2, label: "2nd finger", abbrev: "2" },
            { value: 3, label: "3rd finger", abbrev: "3" },
            { value: 4, label: "4th finger", abbrev: "4" },
        ];
        this.pieCharts = {};

        window.addEventListener("resize", () => {
            if (!this.waveReady) return;
            window.requestAnimationFrame(() => this.renderWaveform());
            if (this.dom.videoOverlay) {
                this.resizeCanvas();
            }
        });
    }

    async init() {
        // Status should appear immediately; don't wait on MIDI/waveform fetch.
        this.setupCompletionToggle();
        await this.loadMidi();
        await this.loadWaveform();
        this.updateSliderBounds();
        this.setupVideo();
        this.setupWaveform();
        this.setupControls();
        this.setupAiControls();
        this.renderNoteButtons();
        this.setupLegatoDrag();
        this.reconstructLegatoRanges();
        this.renderMidi();
        this.renderWaveform();
    }

    setupCompletionToggle() {
        const button = this.dom.completionToggle;
        if (!button) return;
        if (!this.config.statusApiUrl) {
            button.disabled = true;
            button.title = "Status endpoint unavailable";
            return;
        }

        const applyUi = (completed) => {
            this.completed = !!completed;
            button.textContent = this.completed ? "Done" : "Not done";
            button.classList.toggle("pill--done", this.completed);
            button.classList.toggle("pill--todo", !this.completed);
            button.setAttribute("aria-pressed", this.completed ? "true" : "false");
        };

        // initial state from server (source of truth)
        fetch(this.config.statusApiUrl)
            .then((r) => (r.ok ? r.json() : null))
            .then((data) => {
                if (data && typeof data.completed !== "undefined") {
                    applyUi(!!data.completed);
                } else {
                    applyUi(this.completed);
                }
            })
            .catch(() => applyUi(this.completed));

        button.addEventListener("click", async () => {
            const next = !this.completed;
            button.disabled = true;
            try {
                const resp = await fetch(this.config.statusApiUrl, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ completed: next }),
                });
                if (!resp.ok) {
                    throw new Error(`Status update failed (${resp.status})`);
                }
                const data = await resp.json();
                applyUi(!!data.completed);
                this.setAnnotationStatus(this.completed ? "Marked as: Done" : "Marked as: Not done", false);
            } catch (e) {
                console.error(e);
                this.setAnnotationStatus("Failed to update completion status (please retry).", true);
            } finally {
                button.disabled = false;
            }
        });

        // apply config value immediately while fetch resolves
        applyUi(this.completed);
    }

    async loadMidi() {
        try {
            const response = await fetch(this.config.midiApiUrl);
            const payload = await response.json();
            const rawNotes = payload.notes || [];
            this.notes = rawNotes.map((note) => {
                const noteKey = note.noteKey || this.makeNoteKey(note);
                return {
                    ...note,
                    noteKey,
                    annotation: {
                        tonalTechnique: note.annotation?.tonalTechnique || "",
                        articulation: note.annotation?.articulation || "",
                        stringId: note.annotation?.stringId ?? null,
                        position: note.annotation?.position ?? null,
                        finger: note.annotation?.finger ?? null,
                        legato: note.annotation?.legato ?? 0,
                    },
                    aiSuggestion: null,
                    aiChanged: false,
                };
            });
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

    setupVideo() {
        if (!this.config.videoUrl || !this.dom.videoPlayer) return;
        
        this.dom.videoPanel.hidden = false;
        this.dom.videoPlayer.src = this.config.videoUrl;
        // Ensure muted as requested
        this.dom.videoPlayer.muted = true;

        const onReady = () => {
            this.resizeCanvas();
            this.resizeTrackingCanvas();
            this.setupMediaPipe();
        };
        this.dom.videoPlayer.addEventListener("loadedmetadata", onReady, { once: true });
        this.dom.videoPlayer.addEventListener("loadeddata", onReady, { once: true });

        if (window.ResizeObserver) {
            this.videoResizeObserver = new ResizeObserver(() => {
                this.resizeCanvas();
                this.resizeTrackingCanvas();
            });
            this.videoResizeObserver.observe(this.dom.videoPlayer);
        }
    }
    
    resizeCanvas() {
        const video = this.dom.videoPlayer;
        const canvas = this.dom.videoOverlay;
        const wrapper = this.dom.videoPanel?.querySelector(".video-wrapper");
        if (!video || !canvas || !wrapper) return;

        const videoRect = video.getBoundingClientRect();
        const parentRect = wrapper.getBoundingClientRect();

        const width = Math.max(1, Math.round(videoRect.width));
        const height = Math.max(1, Math.round(videoRect.height));
        const offsetX = videoRect.left - parentRect.left;
        const offsetY = videoRect.top - parentRect.top;

        // Position canvas exactly over the rendered video area
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
        canvas.style.left = `${offsetX}px`;
        canvas.style.top = `${offsetY}px`;

        // Internal resolution matches rendered size (CSS px) to align landmarks
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (ctx) {
            ctx.clearRect(0, 0, width, height);
        }
    }

    resizeTrackingCanvas() {
        const canvas = this.dom.trackingCanvas;
        if (!canvas) return;
        const width = Math.max(1, Math.round(canvas.clientWidth || 640));
        const height = Math.max(1, Math.round(canvas.clientHeight || width * 0.5625));
        if (canvas.width !== width || canvas.height !== height) {
            canvas.width = width;
            canvas.height = height;
        }
    }

    setupMediaPipe() {
        if (!this.config.enableFingerTracking) {
            return;
        }
        if (this.hands || this.handsError) return;
        if (!window.Hands) {
            console.warn("MediaPipe Hands not loaded");
            this.handsError = true;
            return;
        }

        const HANDS_VERSION = "0.4.1646424915";

        try {
            this.hands = new Hands({
                locateFile: (file) => {
                    return `https://cdn.jsdelivr.net/npm/@mediapipe/hands@${HANDS_VERSION}/${file}`;
                },
            });

            this.hands.setOptions({
                maxNumHands: 2,
                modelComplexity: 1,
                minDetectionConfidence: 0.5,
                minTrackingConfidence: 0.5,
            });
        } catch (e) {
            console.warn("MediaPipe init error:", e);
            this.handsError = true;
            return;
        }

        this.hands.onResults((results) => {
            this.handsReady = true;
            this.onHandsResults(results);
        });

        const processVideo = async () => {
            if (this.handsError) return;
            const video = this.dom.videoPlayer;
            if (video && video.readyState >= 2 && !video.paused && !video.ended) {
                try {
                    await this.hands.send({ image: video });
                } catch (e) {
                    console.warn("MediaPipe error:", e);
                    this.handsError = true;
                    return;
                }
            }
            if (this.dom.videoPanel && !this.dom.videoPanel.hidden) {
                requestAnimationFrame(processVideo);
            }
        };
        requestAnimationFrame(processVideo);

        this.dom.videoPlayer.addEventListener("seeked", async () => {
            if (this.handsError) return;
            const video = this.dom.videoPlayer;
            if (video && video.readyState >= 2) {
                try {
                    await this.hands.send({ image: video });
                } catch (e) {
                    console.warn("MediaPipe seek error:", e);
                    this.handsError = true;
                }
            }
        });
    }

    onHandsResults(results) {
        if (!this.handsReady) return;
        const video = this.dom.videoPlayer;
        const canvas = this.dom.trackingCanvas;
        if (!canvas || !video || !video.videoWidth || !video.videoHeight) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        // Fit video frame into tracking canvas preserving aspect ratio
        const aspect = video.videoWidth / video.videoHeight;
        const targetW = Math.max(1, Math.round(canvas.clientWidth || canvas.width || video.videoWidth));
        const targetH = Math.max(1, Math.round(targetW / aspect));
        if (canvas.width !== targetW || canvas.height !== targetH) {
            canvas.width = targetW;
            canvas.height = targetH;
        }

        ctx.save();
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        if (results.multiHandLandmarks) {
            for (const landmarks of results.multiHandLandmarks) {
                drawConnectors(ctx, landmarks, HAND_CONNECTIONS, { color: "#00FF00", lineWidth: 2 });
                drawLandmarks(ctx, landmarks, { color: "#FF0000", lineWidth: 1, radius: 3 });
            }
        }
        ctx.restore();
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

        this.wave.on("audioprocess", (time) => {
            this.updateCursor(time);
            this.syncVideo(time);
        });
        this.wave.on("seek", () => {
            this.updateCursor(this.wave.getCurrentTime());
            this.syncVideo(this.wave.getCurrentTime(), true);
        });
        this.wave.on("interaction", () => {
            this.updateCursor(this.wave.getCurrentTime());
            this.syncVideo(this.wave.getCurrentTime(), true);
        });
        this.wave.on("finish", () => this.setPlaying(false));

        this.wave.on("play", () => {
            if (this.dom.videoPlayer) {
                const p = this.dom.videoPlayer.play();
                if (p && p.catch) p.catch(() => {});
            }
        });
        this.wave.on("pause", () => {
            if (this.dom.videoPlayer) this.dom.videoPlayer.pause();
        });

        this.dom.playButton.addEventListener("click", () => {
            this.flashButton(this.dom.playButton);
            if (!this.waveReady) return;
            if (this.wave.isPlaying()) {
                this.wave.pause();
                this.setPlaying(false);
            } else {
                this.viewAtRatio(this.currentTime, 0.25);
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
                this.playNeighborNote("prev", { steps: 2 });
            });
        }

        if (this.dom.nextButton) {
            this.dom.nextButton.addEventListener("click", () => {
                this.flashButton(this.dom.nextButton);
                this.playNeighborNote("next");
            });
        }

        this.setupPieControls();

        this.handleKeydown = (event) => {
            const isSpace =
                event.code === "Space" ||
                event.key === " " ||
                event.key === "Spacebar";

            // if (!isSpace && event.code !== "ArrowRight" && event.code !== "ArrowLeft") {
            //     return;
            // }
            const activeTag =
                document.activeElement?.tagName?.toLowerCase() || "";
            const isTyping =
                activeTag === "input" ||
                activeTag === "textarea" ||
                document.activeElement?.isContentEditable;

            // Articulation shortcuts (A, S, D, F)

            const code = event.code;
            if (code === "KeyA") {
                this.setPieSelection("articulation", "");
                this.queueAnnotationSave({ immediate: true });
                return;
            }
            if (code === "KeyS") {
                this.setPieSelection("articulation", "release");
                this.queueAnnotationSave({ immediate: true });
                return;
            }
            if (code === "KeyD") {
                this.setPieSelection("articulation", "staccato");
                this.queueAnnotationSave({ immediate: true });
                return;
            }
            if (code === "KeyF") {
                 this.setPieSelection("articulation", "spiccato");
                this.queueAnnotationSave({ immediate: true });
                return;
            }

            if (event.code === "ArrowRight") {
                event.preventDefault();
                // Keep keyboard behavior identical to the Next button (play + move cursor)
                if (this.dom.nextButton) {
                    this.dom.nextButton.click();
                } else {
                    this.flashButton(this.dom.nextButton);
                    this.playNeighborNote("next");
                }
                return;
            }

            if (event.code === "ArrowLeft") {
                event.preventDefault();
                // Keep keyboard behavior identical to the Prev button (play + move cursor)
                if (this.dom.prevButton) {
                    this.dom.prevButton.click();
                } else {
                    this.flashButton(this.dom.prevButton);
                    this.playNeighborNote("prev");
                }
                return;
            }

            if (!isSpace) return;

            event.preventDefault();
            this.flashButton(this.dom.playButton);
            if (!this.waveReady) return;

            if (this.wave.isPlaying()) {
                this.wave.pause();
                this.setPlaying(false);
            } else {
                this.viewAtRatio(this.currentTime, 0.25);
                this.wave.play();
                this.setPlaying(true);
            }
        };
        document.addEventListener("keydown", this.handleKeydown);

        this.setupScrubbing();
    }

    setupAiControls() {
        if (this.dom.aiGenerateButton) {
            this.dom.aiGenerateButton.addEventListener("click", () => this.handleAiGenerate());
            if (!this.config.aiGenerateApiUrl) {
                this.dom.aiGenerateButton.disabled = true;
                this.dom.aiGenerateButton.title = "AI endpoint unavailable";
            }
        }
        if (this.dom.aiModalCancel) {
            this.dom.aiModalCancel.addEventListener("click", () => this.discardAiSuggestions());
        }
        if (this.dom.aiModalCommit) {
            this.dom.aiModalCommit.addEventListener("click", () => this.commitAiSuggestions());
        }
        if (this.dom.aiModal) {
            this.dom.aiModal.addEventListener("click", (event) => {
                if (
                    event.target === this.dom.aiModal ||
                    event.target.classList.contains("ai-modal__backdrop")
                ) {
                    this.discardAiSuggestions();
                }
            });
        }
    }

    setupScrubbing() {
        const containers = [this.dom.midiWrapper, this.dom.waveformWrapper];

        containers.forEach((container) => {
            if (!container) return;

            container.addEventListener("mousedown", (e) => {
                if (e.button !== 0) return;

                const wasPlaying = this.wave.isPlaying();
                if (wasPlaying) {
                    this.wave.pause();
                    this.setPlaying(false);
                }

                const rect = container.getBoundingClientRect();

                const updateTime = (evt) => {
                    const ratio = (evt.clientX - rect.left) / rect.width;
                    const clampedRatio = Math.max(0, Math.min(1, ratio));
                    const target = this.viewStart + clampedRatio * this.viewSize;
                    this.seekTo(target);
                };

                updateTime(e);

                const onMouseMove = (evt) => {
                    evt.preventDefault();
                    window.requestAnimationFrame(() => updateTime(evt));
                };

                const onMouseUp = () => {
                    window.removeEventListener("mousemove", onMouseMove);
                    window.removeEventListener("mouseup", onMouseUp);
                    if (wasPlaying) {
                        this.wave.play();
                        this.setPlaying(true);
                    }
                };

                window.addEventListener("mousemove", onMouseMove);
                window.addEventListener("mouseup", onMouseUp);
            });
        });
    }

    async handleAiGenerate() {
        if (!this.config.aiGenerateApiUrl || this.aiPending) {
            return;
        }
        this.aiPending = true;
        this.setAnnotationStatus("Running AI fingering…", false);
        this.closeAiModal();
        this.clearAiSuggestions(true);
        try {
            const response = await fetch(this.config.aiGenerateApiUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ topk: 3 }),
            });
            if (!response.ok) {
                throw new Error(`AI request failed (${response.status})`);
            }
            const payload = await response.json();
            this.applyAiPredictions(payload);
            this.openAiModal();
            this.setAnnotationStatus("AI suggestions ready. Review before committing.", false);
        } catch (error) {
            console.error("AI generate failed", error);
            this.setAnnotationStatus("AI generate failed. See console for details.", true);
        } finally {
            this.aiPending = false;
        }
    }

    applyAiPredictions(payload) {
        this.aiSuggestions.clear();
        const predictions = payload?.predictions || [];
        predictions.forEach((pred) => {
            const key = pred.noteKey || this.makeNoteKey(pred);
            this.aiSuggestions.set(key, pred);
        });

        let changed = 0;
        this.notes.forEach((note) => {
            const key = this.makeNoteKey(note);
            const suggestion = this.aiSuggestions.get(key) || null;
            note.aiSuggestion = suggestion;
            if (suggestion) {
                const annotation = note.annotation || {};
                const isDifferent =
                    suggestion.stringId !== annotation.stringId ||
                    suggestion.position !== annotation.position ||
                    suggestion.finger !== annotation.finger;
                note.aiChanged = isDifferent;
                if (isDifferent) changed += 1;
            } else {
                note.aiChanged = false;
            }
        });
        this.aiChangedCount = changed;
        this.renderMidi();
        this.renderNoteButtons();
        this.updateAiModalDiff();
    }

    updateAiModalDiff() {
        if (this.dom.aiModalSummary) {
            const total = this.aiSuggestions.size;
            this.dom.aiModalSummary.textContent = total
                ? `${this.aiChangedCount} of ${total} notes differ from current annotations.`
                : "No AI suggestions available.";
        }
        if (!this.dom.aiModalDiff) return;
        this.dom.aiModalDiff.innerHTML = "";
        if (!this.aiSuggestions.size) {
            this.dom.aiModalDiff.textContent = "No suggestions to review.";
            return;
        }
        const fragment = document.createDocumentFragment();
        let shown = 0;
        this.notes.forEach((note) => {
            if (!note.aiSuggestion || shown >= 12) return;
            const suggestion = note.aiSuggestion;
            const annotation = note.annotation || {};
            const oldLabel = this.formatFingering(annotation);
            const newLabel = this.formatFingering(suggestion);
            const line = document.createElement("p");
            const pitchLabel = this.getPitchLabel(note.pitch);
            line.textContent = `${pitchLabel} @ ${note.start.toFixed(2)}s → ${note.end.toFixed(2)}s · ${oldLabel} → ${newLabel}${note.aiChanged ? " *" : ""}`;
            fragment.appendChild(line);
            shown += 1;
        });
        if (this.aiSuggestions.size > shown) {
            const more = document.createElement("p");
            more.textContent = `…and ${this.aiSuggestions.size - shown} more`;
            fragment.appendChild(more);
        }
        this.dom.aiModalDiff.appendChild(fragment);
    }

    openAiModal() {
        this.updateAiModalDiff();
        if (this.dom.aiModal) {
            this.dom.aiModal.classList.remove("hidden");
            this.dom.aiModal.setAttribute("aria-hidden", "false");
        }
    }

    closeAiModal() {
        if (this.dom.aiModal) {
            this.dom.aiModal.classList.add("hidden");
            this.dom.aiModal.setAttribute("aria-hidden", "true");
        }
    }

    clearAiSuggestions(resetNotes = false) {
        this.aiSuggestions.clear();
        this.aiChangedCount = 0;
        if (resetNotes) {
            this.notes.forEach((note) => {
                note.aiSuggestion = null;
                note.aiChanged = false;
            });
            this.renderMidi();
        }
    }

    discardAiSuggestions() {
        if (this.aiSuggestions.size) {
            this.setAnnotationStatus("AI suggestions discarded.", false);
        }
        this.clearAiSuggestions(true);
        this.closeAiModal();
    }

    async commitAiSuggestions() {
        if (!this.config.aiCommitApiUrl || !this.aiSuggestions.size || this.aiPending) {
            this.closeAiModal();
            return;
        }
        this.aiPending = true;
        this.setAnnotationStatus("Committing AI predictions…", false);
        const predictions = this.notes
            .filter((note) => !!note.aiSuggestion)
            .map((note) => ({
                pitch: note.pitch,
                start: note.start,
                end: note.end,
                stringId: note.aiSuggestion.stringId,
                position: note.aiSuggestion.position,
                finger: note.aiSuggestion.finger,
            }));
        try {
            const response = await fetch(this.config.aiCommitApiUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ predictions }),
            });
            if (!response.ok) {
                throw new Error(`Commit failed (${response.status})`);
            }
            this.notes.forEach((note) => {
                if (note.aiSuggestion) {
                    note.annotation = {
                        ...(note.annotation || {}),
                        stringId: note.aiSuggestion.stringId,
                        position: note.aiSuggestion.position,
                        finger: note.aiSuggestion.finger,
                    };
                    note.aiChanged = false;
                    note.aiSuggestion = null;
                }
            });
            this.setAnnotationStatus("AI fingering committed to annotation.csv.", false);
            this.renderMidi();
            this.renderNoteButtons();
        } catch (error) {
            console.error("AI commit failed", error);
            this.setAnnotationStatus("AI commit failed. See console for details.", true);
        } finally {
            this.closeAiModal();
            this.aiPending = false;
            this.clearAiSuggestions(false);
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
            button.dataset.noteKey = note.noteKey || this.makeNoteKey(note);
            button.style.left = `${left}%`;
            button.style.width = `${width}%`;
            button.style.top = `calc(${top}% - 14px)`;
            button.style.height = "28px";
            this.applyArticulationColorToMidiButton(button, note.annotation?.articulation || "");
            
            const tonal = note.annotation?.tonalTechnique;
            if (tonal) {
                button.classList.add(`tonal-${tonal.replace(/\s+/g, '-').toLowerCase()}`);
            }

            const pitchLabel = this.getPitchLabel(note.pitch);
            button.textContent = pitchLabel;
            button.title = `Pitch ${pitchLabel} (${note.start.toFixed(2)}s → ${note.end.toFixed(2)}s)`;
            if (note.aiSuggestion) {
                button.classList.add("ai-suggested");
                const suggestedLabel = this.formatFingering(note.aiSuggestion);
                button.title += ` · AI ${suggestedLabel}`;
            }
            if (note.aiChanged) {
                button.classList.add("ai-changed");
            }

            button.addEventListener("mousedown", (e) => {
                if (e.button !== 0) return;
                e.stopPropagation();
                this.startLegatoDrag(note);
            });
            button.addEventListener("mouseenter", () => {
                if (this.legatoDragState) {
                    this.updateLegatoDrag(note);
                }
                this.updateNoteReadout(note);
            });
            button.addEventListener("focus", () => this.updateNoteReadout(note));
            button.addEventListener("click", (e) => {
                e.stopPropagation();
                if (this.legatoDragPreventClick) {
                    this.legatoDragPreventClick = false;
                    return;
                }
                this.focusNote(note);
                this.playSlice(note.start, note.end);
            });

            midiGrid.appendChild(button);
        });

        this.renderLegatoOverlays();
        this.updateCursor(this.currentTime);
    }

    setupLegatoDrag() {
        document.addEventListener("mouseup", () => {
            if (this.legatoDragState) {
                this.endLegatoDrag();
            }
        });
    }

    startLegatoDrag(note) {
        const noteKey = note.noteKey || this.makeNoteKey(note);
        const noteIdx = this.notes.findIndex(
            (n) => (n.noteKey || this.makeNoteKey(n)) === noteKey
        );
        this.legatoDragState = {
            startNote: note,
            startNoteIdx: noteIdx,
            currentNote: note,
            currentNoteIdx: noteIdx,
        };
    }

    updateLegatoDrag(note) {
        if (!this.legatoDragState) return;
        const noteKey = note.noteKey || this.makeNoteKey(note);
        const noteIdx = this.notes.findIndex(
            (n) => (n.noteKey || this.makeNoteKey(n)) === noteKey
        );
        this.legatoDragState.currentNote = note;
        this.legatoDragState.currentNoteIdx = noteIdx;
        this.renderLegatoOverlays();
    }

    endLegatoDrag() {
        if (!this.legatoDragState) return;
        const { startNoteIdx, currentNoteIdx, startNote, currentNote } = this.legatoDragState;
        const startKey = startNote.noteKey || this.makeNoteKey(startNote);
        const endKey = currentNote.noteKey || this.makeNoteKey(currentNote);

        if (startKey !== endKey && startNoteIdx !== -1 && currentNoteIdx !== -1) {
            this.addLegatoRange(startNoteIdx, currentNoteIdx);
            this.legatoDragPreventClick = true;
            setTimeout(() => {
                this.legatoDragPreventClick = false;
            }, 100);
        }

        this.legatoDragState = null;
        this.renderLegatoOverlays();
    }

    addLegatoRange(idx1, idx2) {
        const fromIdx = Math.min(idx1, idx2);
        const toIdx = Math.max(idx1, idx2);
        const startNote = this.notes[fromIdx];
        const endNote = this.notes[toIdx];

        // Collect notes from overlapping ranges that fall OUTSIDE the new
        // legato=1 region (fromIdx+1..toIdx) — these need legato=0 persisted.
        const clearedNotes = [];
        this.legatoRanges.forEach((range) => {
            if (!(range.toIdx < fromIdx || range.fromIdx > toIdx)) {
                for (let i = range.fromIdx; i <= range.toIdx; i++) {
                    if (i <= fromIdx || i > toIdx) {
                        if (this.notes[i]) {
                            this.notes[i].annotation.legato = 0;
                            clearedNotes.push({
                                pitch: this.notes[i].pitch,
                                start: this.notes[i].start,
                                end: this.notes[i].end,
                                legato: 0,
                            });
                        }
                    }
                }
            }
        });

        // Remove any existing legato range that overlaps with this one
        this.legatoRanges = this.legatoRanges.filter((range) => {
            return range.toIdx < fromIdx || range.fromIdx > toIdx;
        });

        // Set legato=1 on notes i+1 through j (note i stays 0)
        const legatoNotes = [];
        
        // 1. Force the start note (fromIdx) to 0 to mark the beginning of the slur.
        if (this.notes[fromIdx]) {
             this.notes[fromIdx].annotation.legato = 0;
             legatoNotes.push({
                pitch: this.notes[fromIdx].pitch,
                start: this.notes[fromIdx].start,
                end: this.notes[fromIdx].end,
                legato: 0,
            });
        }

        // 2. Process the rest of the range.
        // Rule: If a note is within 50ms (0.05s) of the start note's onset, it should ALSO be 0 (chord/double stop).
        // Otherwise, it is part of the slur (legato=1).
        const startOnset = this.notes[fromIdx].start;
        const CHORD_THRESHOLD = 0.05; // 50ms

        for (let i = fromIdx + 1; i <= toIdx; i++) {
            const note = this.notes[i];
            // Check if this note is effectively simultaneous with the start note
            const isChord = Math.abs(note.start - startOnset) < CHORD_THRESHOLD;
            const newVal = isChord ? 0 : 1;

            note.annotation.legato = newVal;
            legatoNotes.push({
                pitch: note.pitch,
                start: note.start,
                end: note.end,
                legato: newVal,
            });
        }

        this.legatoRanges.push({
            fromIdx,
            toIdx,
            startTime: startNote.start,
            endTime: endNote.end,
            startNoteKey: startNote.noteKey || this.makeNoteKey(startNote),
            endNoteKey: endNote.noteKey || this.makeNoteKey(endNote),
        });

        this.saveLegatoBatch([...clearedNotes, ...legatoNotes]);
        this.renderLegatoOverlays();
    }

    removeLegatoRange(index) {
        if (index < 0 || index >= this.legatoRanges.length) return;

        const range = this.legatoRanges[index];

        // Set legato=0 on notes i+1 through j (note i was already 0)
        const legatoNotes = [];
        for (let i = range.fromIdx + 1; i <= range.toIdx; i++) {
            if (this.notes[i]) {
                this.notes[i].annotation.legato = 0;
                legatoNotes.push({
                    pitch: this.notes[i].pitch,
                    start: this.notes[i].start,
                    end: this.notes[i].end,
                    legato: 0,
                });
            }
        }

        this.legatoRanges.splice(index, 1);
        this.saveLegatoBatch(legatoNotes);
        this.renderLegatoOverlays();
    }

    reconstructLegatoRanges() {
        this.legatoRanges = [];
        let firstLegatoIdx = null;
        const CHORD_THRESHOLD = 0.05;

        const findStartIdx = (firstOneIdx) => {
            let startIdx = Math.max(firstOneIdx - 1, 0);
            if (startIdx === 0) return 0;
            
            const refTime = this.notes[startIdx].start;
            let curr = startIdx - 1;
            while (curr >= 0) {
                const note = this.notes[curr];
                // If we hit a legato=1 note, that belongs to a previous range.
                if (note.annotation?.legato === 1) break;
                
                // If the time difference is within threshold, include it as part of the start chord.
                if (Math.abs(refTime - note.start) < CHORD_THRESHOLD) {
                    startIdx = curr;
                    curr--;
                } else {
                    break;
                }
            }
            return startIdx;
        };

        for (let i = 0; i < this.notes.length; i++) {
            const isLegato = this.notes[i].annotation?.legato === 1;

            if (isLegato && firstLegatoIdx === null) {
                firstLegatoIdx = i;
            } else if (!isLegato && firstLegatoIdx !== null) {
                // Run of legato=1 was at indices firstLegatoIdx..(i-1).
                const fromIdx = findStartIdx(firstLegatoIdx);
                const toIdx = i - 1;
                this.legatoRanges.push({
                    fromIdx,
                    toIdx,
                    startTime: this.notes[fromIdx].start,
                    endTime: this.notes[toIdx].end,
                    startNoteKey: this.notes[fromIdx].noteKey || this.makeNoteKey(this.notes[fromIdx]),
                    endNoteKey: this.notes[toIdx].noteKey || this.makeNoteKey(this.notes[toIdx]),
                });
                firstLegatoIdx = null;
            }
        }

        // Handle run extending to the last note
        if (firstLegatoIdx !== null) {
            const fromIdx = findStartIdx(firstLegatoIdx);
            const toIdx = this.notes.length - 1;
            this.legatoRanges.push({
                fromIdx,
                toIdx,
                startTime: this.notes[fromIdx].start,
                endTime: this.notes[toIdx].end,
                startNoteKey: this.notes[fromIdx].noteKey || this.makeNoteKey(this.notes[fromIdx]),
                endNoteKey: this.notes[toIdx].noteKey || this.makeNoteKey(this.notes[toIdx]),
            });
        }
    }

    async saveLegatoBatch(notes) {
        if (!this.config.legatoApiUrl || !notes.length) return;
        try {
            const response = await fetch(this.config.legatoApiUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ notes }),
            });
            if (!response.ok) throw new Error(`Legato save failed (${response.status})`);
            this.setAnnotationStatus("Legato saved.", false);
        } catch (error) {
            console.error("Failed to save legato", error);
            this.setAnnotationStatus("Legato save failed.", true);
        }
    }

    renderLegatoOverlays() {
        const grid = this.dom.midiGrid;
        if (!grid) return;

        // Remove existing overlays
        grid.querySelectorAll(".legato-overlay").forEach((el) => el.remove());
        
        // Clear active legato styling from notes
        grid.querySelectorAll(".midi-note.legato-active, .midi-note.legato-start").forEach((el) => {
            el.classList.remove("legato-active", "legato-start");
        });

        const viewEnd = this.viewStart + this.viewSize;

        // Render committed legato ranges
        this.legatoRanges.forEach((range, rangeIdx) => {
            this.renderSingleLegatoOverlay(grid, range.startTime, range.endTime, viewEnd, {
                isPreview: false,
                rangeIdx,
            });
            
            // Highlight notes within this committed range
            for (let i = range.fromIdx; i <= range.toIdx; i++) {
                const note = this.notes[i];
                if (!note) continue;
                
                const key = note.noteKey || this.makeNoteKey(note);
                const btn = grid.querySelector(`[data-note-key="${CSS.escape(key)}"]`);
                if (btn) {
                    if (note.annotation.legato === 1) {
                        btn.classList.add("legato-active");
                    } else {
                        // It's in the range but legato=0 (start of phrase or chord)
                        btn.classList.add("legato-start");
                    }
                }
            }
        });

        // Render drag preview
        if (this.legatoDragState) {
            const { startNote, currentNote, startNoteIdx, currentNoteIdx } = this.legatoDragState;
            const startKey = startNote.noteKey || this.makeNoteKey(startNote);
            const endKey = currentNote.noteKey || this.makeNoteKey(currentNote);

            if (startKey !== endKey && startNoteIdx >= 0 && currentNoteIdx >= 0) {
                const fromIdx = Math.min(startNoteIdx, currentNoteIdx);
                const toIdx = Math.max(startNoteIdx, currentNoteIdx);
                const previewStart = this.notes[fromIdx].start;
                const previewEnd = this.notes[toIdx].end;
                this.renderSingleLegatoOverlay(grid, previewStart, previewEnd, viewEnd, {
                    isPreview: true,
                });
                
                // Highlight notes within the drag range preview
                // We simulate the logic: first note is start (0), rest are active (1)
                // (ignoring the chord logic for simple preview, or we could replicate it)
                const startOnset = this.notes[fromIdx].start;
                const CHORD_THRESHOLD = 0.05;

                for (let i = fromIdx; i <= toIdx; i++) {
                    const note = this.notes[i];
                    const key = note.noteKey || this.makeNoteKey(note);
                    const btn = grid.querySelector(`[data-note-key="${CSS.escape(key)}"]`);
                    if (btn) {
                        // Start note logic for preview
                        if (i === fromIdx) {
                             btn.classList.add("legato-start");
                        } else {
                             const isChord = Math.abs(note.start - startOnset) < CHORD_THRESHOLD;
                             if (isChord) {
                                 btn.classList.add("legato-start");
                             } else {
                                 btn.classList.add("legato-active");
                             }
                        }
                    }
                }
            }
        }
    }

    renderSingleLegatoOverlay(grid, startTime, endTime, viewEnd, options = {}) {
        if (endTime <= this.viewStart || startTime >= viewEnd) return;

        const clippedStart = Math.max(startTime, this.viewStart);
        const clippedEnd = Math.min(endTime, viewEnd);
        const left = ((clippedStart - this.viewStart) / this.viewSize) * 100;
        const width = ((clippedEnd - clippedStart) / this.viewSize) * 100;

        const overlay = document.createElement("div");
        overlay.className = options.isPreview
            ? "legato-overlay legato-preview"
            : "legato-overlay legato-range";
        overlay.style.left = `${left}%`;
        overlay.style.width = `${width}%`;

        if (!options.isPreview && typeof options.rangeIdx === "number") {
            const range = this.legatoRanges[options.rangeIdx];
            overlay.title = `Legato (${range.startTime.toFixed(2)}s → ${range.endTime.toFixed(2)}s)`;

            // Label
            const label = document.createElement("span");
            label.className = "legato-label";
            label.textContent = "legato";
            overlay.appendChild(label);

            // Delete button
            const deleteBtn = document.createElement("button");
            deleteBtn.className = "legato-delete";
            deleteBtn.textContent = "\u00d7";
            deleteBtn.title = "Remove legato range";
            deleteBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                e.preventDefault();
                this.removeLegatoRange(options.rangeIdx);
            });
            overlay.appendChild(deleteBtn);
        }

        grid.appendChild(overlay);
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

    syncVideo(time, force = false) {
        const video = this.dom.videoPlayer;
        if (!video || !this.config.videoUrl) return;

        // Only sync if difference is significant (> 0.1s) to avoid jitter
        // or if forced (e.g. on seek)
        if (force || Math.abs(video.currentTime - time) > 0.15) {
            video.currentTime = time;
        }
    }

    // centerViewOn(time, options = {}) {
    //     if (!this.duration || !Number.isFinite(time)) {
    //         return;
    //     }
    //     const desiredStart = Math.min(
    //         Math.max(time - this.viewSize * 0.5, 0),
    //         Math.max(this.duration - this.viewSize, 0)
    //     );
    //     this.setViewStart(desiredStart, { silentSlider: options.silentSlider ?? false });
    // }

    viewAtRatio(time, ratio, options = {}) {
        if (!this.duration || !Number.isFinite(time)) {
            return;
        }
        const desiredStart = Math.min(
            Math.max(time - this.viewSize * ratio, 0),
            Math.max(this.duration - this.viewSize, 0)
        );
        this.setViewStart(desiredStart, { silentSlider: options.silentSlider ?? false });
    }

    // // Position cursor at 25% to see the "back" (future) 3/4 of the window
    // viewShowingLaterThreeQuarters(time, options = {}) {
    //     this.viewAtRatio(time, 0.25, options);
    // }

    setupPieControls() {
        this.createPieChart("tonal", this.dom.tonalPie, this.dom.tonalPieLabel, this.tonalOptions);
        this.createPieChart(
            "articulation",
            this.dom.articulationPie,
            this.dom.articulationPieLabel,
            this.articulationOptions
        );
        this.createPieChart("string", this.dom.stringPie, this.dom.stringPieLabel, this.stringOptions);
        this.createPieChart("position", this.dom.positionPie, this.dom.positionPieLabel, this.positionOptions);
        this.createPieChart("finger", this.dom.fingerPie, this.dom.fingerPieLabel, this.fingerOptions);
    }

    createPieChart(type, canvas, labelEl, optionList) {
        if (!canvas || !window.Chart) return;
        const ctx = canvas.getContext("2d");
        const datasetColors = optionList.map((_, idx) => this.pieColors[idx % this.pieColors.length]);

        const chart = new Chart(ctx, {
            type: "doughnut",
            data: {
                labels: optionList.map((opt) => opt.label),
                datasets: [
                    {
                        data: optionList.map(() => 1),
                        backgroundColor: datasetColors,
                        borderColor: (ctx) =>
                            ctx.dataIndex === ctx.chart.$selectedIndex ? "black" : "rgba(255,255,255,0.85)",
                        borderWidth: (ctx) => (ctx.dataIndex === ctx.chart.$selectedIndex ? 2 : 1),
                        hoverBorderColor: "#1f1630",
                        hoverBorderWidth: 1,
                        spacing: 4,
                    },
                ],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                cutout: "30%",
                rotation: -90,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: (context) => optionList[context.dataIndex]?.label || "",
                        },
                    },
                },
                onClick: (event, elements) => {
                    if (!elements.length) return;
                    const index = elements[0].index;
                    const value = optionList[index].value;
                    this.setPieSelection(type, value);
                    if (!this.suspendAutosave) {
                        // Save immediately on click to avoid losing changes when switching notes quickly
                        this.queueAnnotationSave({ immediate: true });
                    }
                },
                layout: {
                    padding: 0,
                },
            },
            plugins: [
                {
                    id: `${type}-labels`,
                    afterDatasetsDraw: (chartInstance) => {
                        const { ctx } = chartInstance;
                        const meta = chartInstance.getDatasetMeta(0);
                        meta.data.forEach((arc, idx) => {
                            const code =
                                optionList[idx]?.abbrev ||
                                optionList[idx]?.label?.slice(0, 3)?.toUpperCase() ||
                                "";
                            const geometry = arc.getProps(["x", "y", "startAngle", "endAngle", "innerRadius", "outerRadius"], true);
                            const angle = (geometry.startAngle + geometry.endAngle) / 2;
                            const radius = geometry.innerRadius + (geometry.outerRadius - geometry.innerRadius) * 0.65;
                            const x = geometry.x + Math.cos(angle) * radius;
                            const y = geometry.y + Math.sin(angle) * radius;
                            ctx.save();
                            ctx.font = "bold 13px 'Space Grotesk', 'Inter', sans-serif";
                            ctx.fillStyle =
                                chartInstance.$selectedIndex === idx
                                    ? "rgba(255,255,255,0.85)"
                                    : "#1f1630";
                            if (chartInstance.$selectedIndex === idx) {
                                ctx.strokeStyle = "#1f1630";
                                ctx.lineWidth = 2;
                                // ctx.strokeText(code, x, y);
                            }
                            ctx.textAlign = "center";
                            ctx.textBaseline = "middle";
                            ctx.fillText(code, x, y);
                            ctx.restore();
                        });
                    },
                },
            ],
        });

        chart.$optionsList = optionList;
        chart.$labelEl = labelEl;
        chart.$selectedIndex = optionList.findIndex((opt) => opt.value === "");
        chart.$selectedValue = optionList[chart.$selectedIndex]?.value || "";
        this.pieCharts[type] = chart;
        this.updatePieLabel(type, chart.$selectedValue);
    }

    updatePieLabel(type, value) {
        const chart = this.pieCharts[type];
        if (!chart) return;
        const option = chart.$optionsList?.find((opt) => opt.value === value);
        if (chart.$labelEl) {
            chart.$labelEl.textContent = option?.label || "none";
        }
    }

    setPieSelection(type, value, options = {}) {
        const chart = this.pieCharts[type];
        if (!chart) return;
        const index = chart.$optionsList.findIndex((opt) => opt.value === value);
        chart.$selectedIndex = index;
        chart.$selectedValue = value || "";
        this.updatePieLabel(type, value || "");
        chart.update("none");

        if (!options.skipNoteUpdate && this.selectedNote) {
            const updated = { ...this.selectedNote.annotation };
            if (type === "tonal") {
                updated.tonalTechnique = value || "";
            } else if (type === "articulation") {
                updated.articulation = value || "";
            } else if (type === "string") {
                updated.stringId = value === "" ? null : value;
            } else if (type === "position") {
                updated.position = value === "" ? null : value;
            } else if (type === "finger") {
                updated.finger = value === "" ? null : value;
            }
            this.selectedNote.annotation = updated;

            // Keep MIDI piano roll colors in sync with articulation edits.
            if (type === "articulation") {
                this.updateMidiNoteArticulationColor(this.selectedNote);
            }
            // Keep MIDI piano roll borders in sync with tonal edits.
            if (type === "tonal") {
                this.updateMidiNoteTonalClass(this.selectedNote);
            }
        }
    }

    getOptionColor(optionList, value) {
        if (!Array.isArray(optionList) || !optionList.length) return null;
        const idx = optionList.findIndex((opt) => opt.value === value);
        const safeIdx = idx === -1 ? 0 : idx;
        return this.pieColors[safeIdx % this.pieColors.length] || null;
    }

    getTextColorForHexBackground(hex) {
        if (typeof hex !== "string") return null;
        const normalized = hex.trim().replace("#", "");
        if (normalized.length !== 6) return null;
        const r = parseInt(normalized.slice(0, 2), 16);
        const g = parseInt(normalized.slice(2, 4), 16);
        const b = parseInt(normalized.slice(4, 6), 16);
        if (![r, g, b].every((v) => Number.isFinite(v))) return null;

        // Relative luminance (sRGB)
        const toLinear = (c) => {
            const s = c / 255;
            return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
        };
        const L = 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);

        // Use dark text on light backgrounds, white on dark backgrounds.
        return L > 0.55 ? "#1f1630" : "#ffffff";
    }

    applyArticulationColorToMidiButton(button, articulationValue) {
        if (!button) return;
        // Keep "none" (empty string) mapped to the first articulation option color
        // so the MIDI roll matches the pie chart color mapping.
        const normalized = articulationValue || "";
        const color = this.getOptionColor(this.articulationOptions, normalized);
        if (!color) {
            button.style.removeProperty("--articulation-color");
            button.style.removeProperty("color");
            return;
        }
        button.style.setProperty("--articulation-color", color);
        const textColor = this.getTextColorForHexBackground(color);
        if (textColor) {
            button.style.color = textColor;
        } else {
            button.style.removeProperty("color");
        }
    }

    updateMidiNoteArticulationColor(note) {
        if (!note || !this.dom.midiGrid) return;
        const key = note.noteKey || this.makeNoteKey(note);
        const button = this.dom.midiGrid.querySelector(`[data-note-key="${CSS.escape(key)}"]`);
        if (!button) return;
        this.applyArticulationColorToMidiButton(button, note.annotation?.articulation || "");
    }

    updateMidiNoteTonalClass(note) {
        if (!note || !this.dom.midiGrid) return;
        const key = note.noteKey || this.makeNoteKey(note);
        const button = this.dom.midiGrid.querySelector(`[data-note-key="${CSS.escape(key)}"]`);
        if (!button) return;
        
        // Remove existing tonal classes safely
        const toRemove = [];
        button.classList.forEach(cls => {
            if (cls.startsWith("tonal-")) {
                toRemove.push(cls);
            }
        });
        toRemove.forEach(cls => button.classList.remove(cls));

        const tonal = note.annotation?.tonalTechnique;
        if (tonal) {
            button.classList.add(`tonal-${tonal.replace(/\s+/g, '-').toLowerCase()}`);
        }
    }

    getPieSelection(type) {
        const chart = this.pieCharts[type];
        if (!chart) return "";
        return chart.$selectedValue || "";
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
        const fingering = this.formatFingering(note.annotation);
        this.dom.noteReadout.textContent = `Pitch ${label} · ${note.start.toFixed(2)}s → ${note.end.toFixed(2)}s · ${fingering}`;
    }

    findNeighborNote(direction) {
        if (!this.notes.length) return null;
        const step = direction === "next" ? 1 : -1;

        // Prefer navigating relative to the currently selected note.
        if (this.selectedNote) {
            const selectedKey = this.selectedNote.noteKey || this.makeNoteKey(this.selectedNote);
            const idx = this.notes.findIndex((n) => (n.noteKey || this.makeNoteKey(n)) === selectedKey);
            if (idx !== -1) {
                const nextIdx = Math.min(Math.max(idx + step, 0), this.notes.length - 1);
                return this.notes[nextIdx];
            }
        }

        // Fallback: navigate relative to the current cursor time.
        const epsilon = 0.0005;
        const time = this.currentTime;

        if (direction === "next") {
            return (
                this.notes.find((note) => note.start > time + epsilon) ??
                this.notes[this.notes.length - 1]
            );
        }

        for (let i = this.notes.length - 1; i >= 0; i -= 1) {
            if (this.notes[i].start < time - epsilon) return this.notes[i];
        }
        return this.notes[0];
    }

    jumpNeighborNote(direction) {
        const target = this.findNeighborNote(direction);
        if (!target) return;

        this.focusNote(target);
        this.viewAtRatio(target.start, 0.25,{ silentSlider: false });

        // Move the cursor/time without auto-playing.
        if (this.waveReady) {
            this.seekTo(target.start);
        } else {
            this.currentTime = target.start;
            this.updateCursor(target.start);
        }
    }

    playNeighborNote(direction, { steps = 1 } = {}) {
        if (!this.notes.length) return;
        const epsilon = 0.0005;
        const safeSteps = Number.isFinite(steps) && steps > 0 ? Math.floor(steps) : 1;
        let target = null;

        // Prefer navigating relative to the currently selected note (stable even if currentTime is offset by slice padding).
        if (this.selectedNote) {
            const selectedKey = this.selectedNote.noteKey || this.makeNoteKey(this.selectedNote);
            const idx = this.notes.findIndex((n) => (n.noteKey || this.makeNoteKey(n)) === selectedKey);
            if (idx !== -1) {
                const delta = direction === "next" ? safeSteps : -safeSteps;
                const nextIdx = Math.min(Math.max(idx + delta, 0), this.notes.length - 1);
                target = this.notes[nextIdx] ?? null;
            }
        }

        const time = this.currentTime;
        if (direction === "next") {
            if (!target) {
                const startIndex = this.notes.findIndex((note) => note.start > time + epsilon);
                if (startIndex !== -1) {
                    const index = Math.min(startIndex + (safeSteps - 1), this.notes.length - 1);
                    target = this.notes[index] ?? null;
                }
            }
        } else {
            if (!target) {
                let remaining = safeSteps;
                for (let i = this.notes.length - 1; i >= 0; i -= 1) {
                    if (this.notes[i].start < time - epsilon) {
                        remaining -= 1;
                        if (remaining <= 0) {
                            target = this.notes[i];
                            break;
                        }
                    }
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

    makeNoteKey(note) {
        const pitch = typeof note.pitch === "number" ? note.pitch : 0;
        const start = typeof note.start === "number" ? note.start : 0;
        return `${pitch}@${start.toFixed(6)}`;
    }

    formatFingering(fields) {
        if (!fields) return "–";
        const { stringId, position, finger } = fields;
        if (
            stringId === null || stringId === undefined ||
            position === null || position === undefined ||
            finger === null || finger === undefined
        ) {
            return "–";
        }
        const stringNames = ["G", "D", "A", "E"];
        const stringLabel = stringNames[stringId] || "?";
        return `${stringLabel}-${position}-f${finger}`;
    }

    focusNote(note) {
        if (!note) return;
        // Ensure pending autosave for the previous note is flushed before switching selection.
        this.flushPendingAnnotationSave();
        this.selectedNote = note;
        const label = `${this.getPitchLabel(note.pitch)} · ${note.start.toFixed(2)}s`;
        if (this.dom.annotationNoteLabel) {
            this.dom.annotationNoteLabel.textContent = `Selected: ${label}`;
        }
        const tonal = note.annotation?.tonalTechnique || "";
        const articulation = note.annotation?.articulation || "";
        const stringId = note.annotation?.stringId ?? "";
        const position = note.annotation?.position ?? "";
        const finger = note.annotation?.finger ?? "";
        this.suspendAutosave = true;
        this.setPieSelection("tonal", tonal, { skipNoteUpdate: true });
        this.setPieSelection("articulation", articulation, { skipNoteUpdate: true });
        this.setPieSelection("string", stringId, { skipNoteUpdate: true });
        this.setPieSelection("position", position, { skipNoteUpdate: true });
        this.setPieSelection("finger", finger, { skipNoteUpdate: true });
        this.suspendAutosave = false;
        this.setAnnotationStatus("Editing note…", false);
    }

    makePayloadKey(payload) {
        const pitch = typeof payload?.pitch === "number" ? payload.pitch : 0;
        const start = typeof payload?.start === "number" ? payload.start : 0;
        return `${pitch}@${start.toFixed(6)}`;
    }

    buildAnnotationPayload(note) {
        if (!note) return null;
        const annotation = note.annotation || {};
        return {
            pitch: note.pitch,
            start: note.start,
            end: note.end,
            tonalTechnique: annotation.tonalTechnique || "",
            articulation: annotation.articulation || "",
            stringId: annotation.stringId ?? null,
            position: annotation.position ?? null,
            finger: annotation.finger ?? null,
            legato: annotation.legato ?? 0,
        };
    }

    enqueueAnnotationSave(payload, { auto = true } = {}) {
        if (!payload) return;
        const key = this.makePayloadKey(payload);

        // De-dupe: keep only the latest payload per note.
        const existingIndex = this.annotationSaveQueue.findIndex((item) => item.key === key);
        const item = { key, payload, auto };
        if (existingIndex !== -1) {
            this.annotationSaveQueue[existingIndex] = item;
        } else {
            this.annotationSaveQueue.push(item);
        }

        this.processAnnotationSaveQueue();
    }

    processAnnotationSaveQueue() {
        if (this.isSavingAnnotation) return;
        if (!this.config.annotationApiUrl) return;
        const next = this.annotationSaveQueue.shift();
        if (!next) return;

        this.isSavingAnnotation = true;
        this.setAnnotationStatus(next.auto ? "Saving…" : "Saving annotation…", false);

        fetch(this.config.annotationApiUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(next.payload),
        })
            .then((response) => {
                if (!response.ok) {
                    throw new Error(`Save failed (${response.status})`);
                }
                // Keep local state consistent: update the matching note object (and selected note if it matches).
                const key = next.key;
                const match = this.notes.find((n) => (n.noteKey || this.makeNoteKey(n)) === key);
                if (match) {
                    match.annotation = {
                        tonalTechnique: next.payload.tonalTechnique || "",
                        articulation: next.payload.articulation || "",
                        stringId: next.payload.stringId ?? null,
                        position: next.payload.position ?? null,
                        finger: next.payload.finger ?? null,
                        legato: next.payload.legato ?? (match.annotation?.legato ?? 0),
                    };
                }
                if (this.selectedNote && (this.selectedNote.noteKey || this.makeNoteKey(this.selectedNote)) === key) {
                    this.selectedNote.annotation = {
                        tonalTechnique: next.payload.tonalTechnique || "",
                        articulation: next.payload.articulation || "",
                        stringId: next.payload.stringId ?? null,
                        position: next.payload.position ?? null,
                        finger: next.payload.finger ?? null,
                        legato: next.payload.legato ?? (this.selectedNote.annotation?.legato ?? 0),
                    };
                }
                this.setAnnotationStatus(next.auto ? "Changes autosaved." : "Annotation saved.", false);
            })
            .catch((error) => {
                console.error("Failed to save annotation", error);
                this.setAnnotationStatus("Save failed. Please try again.", true);
            })
            .finally(() => {
                this.isSavingAnnotation = false;
                // Process any queued saves that came in while we were saving.
                this.processAnnotationSaveQueue();
            });
    }

    queueAnnotationSave({ immediate = false } = {}) {
        if (!this.selectedNote || this.suspendAutosave) return;

        const payload = this.buildAnnotationPayload(this.selectedNote);
        if (!payload) return;

        // Store a snapshot for the currently edited note so switching notes can't change what we save.
        this.pendingAnnotationSave = {
            key: this.makePayloadKey(payload),
            payload,
            auto: true,
        };

        if (this.annotationSaveTimer) {
            clearTimeout(this.annotationSaveTimer);
        }

        const delay = immediate ? 0 : 250;
        this.annotationSaveTimer = window.setTimeout(() => {
            this.annotationSaveTimer = null;
            const pending = this.pendingAnnotationSave;
            this.pendingAnnotationSave = null;
            if (pending?.payload) {
                this.enqueueAnnotationSave(pending.payload, { auto: pending.auto });
            }
        }, delay);
    }

    flushPendingAnnotationSave() {
        if (this.annotationSaveTimer) {
            clearTimeout(this.annotationSaveTimer);
            this.annotationSaveTimer = null;
        }
        const pending = this.pendingAnnotationSave;
        this.pendingAnnotationSave = null;
        if (pending?.payload) {
            this.enqueueAnnotationSave(pending.payload, { auto: pending.auto });
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
        this.syncVideo(seconds, true);
    }

    // Playing a slice of the audio waveform from given midi note start and end times
    // with 10ms padding for mido note playback buffer
    // and centering the view on the start of the slice
    playSlice(start, end) {
        if (!this.waveReady) return;
        const padding = this.slicePadding;
        const adjustedStart = Math.max(start - padding, 0);
        const adjustedEnd = Math.min(end + padding, this.duration);
        this.viewAtRatio(adjustedStart, 0.25, { silentSlider: false });
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

