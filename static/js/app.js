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
        };
        this.waveformData = null;
        this.hands = null;
        this.handsReady = false;
        this.handsError = false;
        this.slicePadding =
            typeof config.slicePaddingSeconds === "number"
                ? config.slicePaddingSeconds
                : 0.005;
        this.buttonFlashTimers = new Map();
        this.pieColors = ["#ffe1e0", "#eeece1", "#9b7ebd", "#f49bab", "#7f55b1", "#e16981"];
        this.selectedNote = null;
        this.isSavingAnnotation = false;
        this.statusTimer = null;
        this.annotationSaveTimer = null;
        this.suspendAutosave = false;
        this.pieCharts = {};
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
            { value: "staccato", label: "staccato", abbrev: "STC" },
            { value: "accent", label: "accent", abbrev: "ACC" },
            // { value: "legato", label: "legato", abbrev: "LEG" },
            // { value: "tenuto", label: "tenuto", abbrev: "TEN" },
            // { value: "marcato", label: "marcato", abbrev: "MAR" },
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
        await this.loadMidi();
        await this.loadWaveform();
        this.updateSliderBounds();
        this.setupVideo();
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
            if (this.dom.videoPlayer) this.dom.videoPlayer.play();
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

        this.setupPieControls();

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

        this.setupScrubbing();
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

    syncVideo(time, force = false) {
        const video = this.dom.videoPlayer;
        if (!video || !this.config.videoUrl) return;

        // Only sync if difference is significant (> 0.1s) to avoid jitter
        // or if forced (e.g. on seek)
        if (force || Math.abs(video.currentTime - time) > 0.15) {
            video.currentTime = time;
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

    setupPieControls() {
        this.createPieChart("tonal", this.dom.tonalPie, this.dom.tonalPieLabel, this.tonalOptions);
        this.createPieChart(
            "articulation",
            this.dom.articulationPie,
            this.dom.articulationPieLabel,
            this.articulationOptions
        );
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
                        this.queueAnnotationSave();
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
            } else {
                updated.articulation = value || "";
            }
            this.selectedNote.annotation = updated;
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
        this.setPieSelection("tonal", tonal, { skipNoteUpdate: true });
        this.setPieSelection("articulation", articulation, { skipNoteUpdate: true });
        this.suspendAutosave = false;
        this.setAnnotationStatus("Editing note…", false);
    }

    queueAnnotationSave() {
        if (!this.selectedNote || this.isSavingAnnotation || this.suspendAutosave) {
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

        const tonal = this.getPieSelection("tonal") || "";
        const articulation = this.getPieSelection("articulation") || "";

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

