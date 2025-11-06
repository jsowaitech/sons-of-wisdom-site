// app/call.js
import { supabase, ensureLoggedIn } from "./supabase.js";
import { CONFIG } from "./config.js";

/* -------------------------
   Grabs
-------------------------- */
const ui = {
  ring: document.getElementById("ring"),
  status: document.getElementById("status"),
  clock: document.getElementById("clock"),
  listenBar: document.getElementById("listenBar"),

  btnBack: document.getElementById("btnBack"),
  btnMic: document.getElementById("btnMic"),
  btnEnd: document.getElementById("btnEnd"),
  btnSpk: document.getElementById("btnSpk"),
  btnMore: document.getElementById("btnMore"),

  tts: document.getElementById("tts-audio"), // hidden <audio> for AI output
};

const state = {
  active: false,
  speaking: false,
  muted: false,
  speakerOn: true,

  callId: null,
  clockStart: 0,
  clockTick: 0,

  // mic
  micStream: null,
  ac: null,
  micSource: null,
  micAnalyser: null,
  micRecorder: null,
  micChunks: [],

  // VAD thresholds
  vadThresholdDb: -45,      // start level (dBFS) ~ -45
  minSpeechMs: 160,         // must exceed threshold for this long to start
  minSilenceMs: 600,        // consider ended after this much silence
  lastAbove: 0,
  lastBelow: 0,

  // ring sync
  outAC: null,
  outAnalyser: null,

  // speech recognition (for transcript → n8n)
  recog: null,
  recogEnabled: true,

  // uploads
  bucket: CONFIG.AUDIO_BUCKET || "audio",
};

/* -------------------------
   Utilities
-------------------------- */
function setStatus(text) {
  if (ui.status) ui.status.textContent = text || "";
}
function setListening(text) {
  if (ui.listenBar) ui.listenBar.textContent = text || "";
}
function setClock(ms) {
  if (!ui.clock) return;
  const s = Math.floor(ms / 1000);
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  ui.clock.textContent = `${mm}:${ss}`;
}
function startClock() {
  state.clockStart = performance.now();
  stopClock();
  state.clockTick = setInterval(() => {
    setClock(performance.now() - state.clockStart);
  }, 250);
}
function stopClock() {
  if (state.clockTick) clearInterval(state.clockTick);
  state.clockTick = 0;
}

/* RMS helpers */
function rmsFromAnalyser(analyser) {
  const buf = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  const rms = Math.sqrt(sum / buf.length) || 0;
  const db = 20 * Math.log10(rms || 1e-8);
  return { rms, db };
}

/* -------------------------
   Boot + Flow
-------------------------- */
async function boot() {
  await ensureLoggedIn({ redirectTo: "./auth.html" });

  /* Call id: keep stable while on this page */
  const param = new URL(location.href).searchParams;
  const prompt = param.get("prompt") || "";
  state.callId =
    param.get("call_id") ||
    crypto.randomUUID().toString();
  localStorage.setItem("last_call_id", state.callId);

  /* UI */
  wireUI();

  /* Allow user to hang up *before* we start anything */
  ui.btnEnd?.classList.add("armed");

  /* Begin */
  await startCall(prompt).catch((err) => {
    console.error("[CALL] failed to start", err);
    setStatus("Call failed to start");
  });
}

function wireUI() {
  ui.btnBack?.addEventListener("click", () => {
    navigateHome();
  });

  ui.btnEnd?.addEventListener("click", () => {
    endCall("User ended");
  });

  ui.btnSpk?.addEventListener("click", () => {
    state.speakerOn = !state.speakerOn;
    if (ui.btnSpk) ui.btnSpk.dataset.on = String(state.speakerOn);
    ui.tts.muted = !state.speakerOn;
  });

  ui.btnMic?.addEventListener("click", () => {
    state.muted = !state.muted;
    if (ui.btnMic) ui.btnMic.dataset.muted = String(state.muted);
    setStatus(state.muted ? "Mic muted" : "Listening…");
  });
}

async function startCall(promptText) {
  setStatus("Connecting…");
  setClock(0);
  startClock();
  state.active = true;

  // Play ring twice, but remain cancellable
  await playAsset("./ring.mp3", 2, 1600);
  if (!state.active) return;

  // Greeting
  setStatus("AI is greeting you…");
  await playAsset("./blake.mp3", 1);
  if (!state.active) return;

  // Start mic VAD + recognition + ring sync
  await startMic();
  await startRecognition();       // transcripts → n8n
  await startRingSync();          // ring reacts to output audio amplitude

  if (promptText) {
    // seed message to n8n if you came from a chip
    sendTranscriptToN8n(promptText).catch(console.warn);
  }

  setStatus("Listening…");
  setListening("Listening bar…");
}

/* -------------------------
   Media helpers
-------------------------- */
async function playAsset(url, loops = 1, gapMs = 0) {
  // Make sure the end button can stop this
  for (let i = 0; i < loops; i++) {
    if (!state.active) break;
    await playOnce(url);
    if (gapMs && i < loops - 1) await wait(gapMs);
  }
}

function wait(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

function playOnce(url) {
  return new Promise((resolve) => {
    const a = new Audio(url);
    a.preload = "auto";
    a.onended = () => resolve();
    a.onerror = () => resolve();
    a.play().catch(() => resolve());
  });
}

/* -------------------------
   VAD + Recording (mic)
-------------------------- */
async function startMic() {
  // mic stream
  state.micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  // recorder
  state.micRecorder = new MediaRecorder(state.micStream, { mimeType: "audio/webm;codecs=opus" });
  state.micChunks = [];
  state.micRecorder.ondataavailable = (e) => e.data && state.micChunks.push(e.data);
  state.micRecorder.onstop = onSegmentStop;

  // WebAudio for VAD
  state.ac = new (window.AudioContext || window.webkitAudioContext)();
  state.micSource = state.ac.createMediaStreamSource(state.micStream);
  state.micAnalyser = state.ac.createAnalyser();
  state.micAnalyser.fftSize = 1024;
  state.micSource.connect(state.micAnalyser);

  // loop
  state.lastAbove = 0;
  state.lastBelow = performance.now();
  vadLoop();
}

function vadLoop() {
  if (!state.active || !state.micAnalyser) return;

  const { db } = rmsFromAnalyser(state.micAnalyser);
  const now = performance.now();

  // update visual ring for *input* too (very subtle)
  const scale = Math.max(1, 1 + Math.max(0, (db + 50) / 35) * 0.25);
  ui.ring?.style.setProperty("--ring-scale", String(scale));

  if (state.muted) {
    requestAnimationFrame(vadLoop);
    return;
  }

  if (db > state.vadThresholdDb) {
    state.lastAbove = now;
    // started speaking?
    if (!state.speaking && now - state.lastBelow >= state.minSpeechMs) {
      startSegment();
    }
  } else {
    state.lastBelow = now;
    // ended speaking?
    if (state.speaking && now - state.lastAbove >= state.minSilenceMs) {
      stopSegment();
    }
  }

  requestAnimationFrame(vadLoop);
}

function startSegment() {
  state.speaking = true;
  setListening("You’re speaking…");
  state.micChunks = [];
  try { state.micRecorder?.start(); } catch {}
}

function stopSegment() {
  state.speaking = false;
  setListening("Listening bar…");
  try { state.micRecorder?.stop(); } catch {}
}

async function onSegmentStop() {
  // Upload the recorded segment to Supabase (archive only)
  if (!state.micChunks.length) return;
  const blob = new Blob(state.micChunks, { type: "audio/webm" });
  state.micChunks = [];

  const fileName = `user-${Date.now()}.webm`;
  try {
    const { data, error } = await supabase.storage
      .from(state.bucket)
      .upload(`audio/${state.callId}/${fileName}`, blob, { upsert: true, contentType: "audio/webm" });

    if (error) {
      console.warn("[upload] storage error:", error.message);
      return;
    }

    // (Optional) write a row referencing the audio segment
    await supabase.from("call_sessions").insert({
      call_id: state.callId,
      role: "user",
      input_transcript: null,   // the text will arrive via recognition
      audio_url: data?.path || null,
      created_at: new Date().toISOString(),
    });
  } catch (e) {
    console.warn("[upload] failed:", e);
  }
}

/* -------------------------
   Speech Recognition → n8n
-------------------------- */
async function startRecognition() {
  if (!state.recogEnabled) return;

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    console.info("[recog] Web Speech not supported — transcripts will not be sent automatically.");
    return;
  }

  const r = new SR();
  r.lang = "en-US";
  r.continuous = true;
  r.interimResults = false;

  r.onstart = () => setStatus("Listening…");
  r.onerror = (e) => console.warn("[recog] error:", e);
  r.onend = () => {
    if (state.active) {
      // Auto-restart for continuous listening
      try { r.start(); } catch {}
    }
  };
  r.onresult = (e) => {
    for (const res of e.results) {
      if (res.isFinal) {
        const transcript = res[0].transcript?.trim();
        if (transcript) {
          // Save “user” row with text
          supabase.from("call_sessions").insert({
            call_id: state.callId,
            role: "user",
            input_transcript: transcript,
            created_at: new Date().toISOString(),
          }).catch(() => {});

          sendTranscriptToN8n(transcript).catch(console.warn);
        }
      }
    }
  };

  state.recog = r;
  try { r.start(); } catch {}
}

async function sendTranscriptToN8n(text) {
  if (!CONFIG.N8N_WEBHOOK_URL) {
    console.log("[CALL] transcript sent to n8n: (user spoke = STT not configured)", text);
    return;
  }

  const payload = {
    call_id: state.callId,
    user_text: text,
    // any other context you want
  };

  const res = await fetch(CONFIG.N8N_WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  // Response may be audio binary or JSON w/ url
  const ctype = (res.headers.get("content-type") || "").toLowerCase();
  if (ctype.includes("application/json")) {
    const j = await res.json();
    const url = j.audio_url || j.url || "";
    const aiText = j.ai_text || j.text || "";
    if (aiText) {
      supabase.from("call_sessions").insert({
        call_id: state.callId,
        role: "assistant",
        ai_text: aiText,
        audio_url: url || null,
        created_at: new Date().toISOString(),
      }).catch(() => {});
    }
    if (url) {
      await playTTS(url);
    }
  } else {
    // assume audio
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    await playTTS(url);
    // (Optional) store assistant row
    supabase.from("call_sessions").insert({
      call_id: state.callId,
      role: "assistant",
      ai_text: null,
      audio_url: null,
      created_at: new Date().toISOString(),
    }).catch(() => {});
  }
}

function playTTS(src) {
  return new Promise((resolve) => {
    ui.tts.src = src;
    ui.tts.onended = () => resolve();
    ui.tts.onerror = () => resolve();
    ui.tts.muted = !state.speakerOn;
    ui.tts.play().catch(() => resolve());
  });
}

/* -------------------------
   Output ring sync (AI audio amplitude)
-------------------------- */
async function startRingSync() {
  try {
    state.outAC = new (window.AudioContext || window.webkitAudioContext)();
    const node = state.outAC.createMediaElementSource(ui.tts);
    state.outAnalyser = state.outAC.createAnalyser();
    state.outAnalyser.fftSize = 1024;
    node.connect(state.outAnalyser);
    state.outAnalyser.connect(state.outAC.destination);
    ringLoop();
  } catch (e) {
    console.warn("[ringSync] cannot start:", e);
  }
}

function ringLoop() {
  if (!state.active || !state.outAnalyser) return;
  const { db } = rmsFromAnalyser(state.outAnalyser);
  const scale = Math.max(1, 1 + Math.max(0, (db + 50) / 35) * 0.35);
  ui.ring?.style.setProperty("--ring-scale", String(scale));
  requestAnimationFrame(ringLoop);
}

/* -------------------------
   Teardown
-------------------------- */
function hardStopMedia() {
  try { ui.tts.pause(); ui.tts.src = ""; } catch {}
  if (state.recog) { try { state.recog.onend = null; state.recog.stop(); } catch {} }
  if (state.micRecorder && state.micRecorder.state !== "inactive") {
    try { state.micRecorder.stop(); } catch {}
  }
  if (state.micStream) {
    for (const t of state.micStream.getTracks()) try { t.stop(); } catch {}
  }
  try { state.ac?.close(); } catch {}
  try { state.outAC?.close(); } catch {}
}

async function endCall(reason = "") {
  if (!state.active) return;
  state.active = false;
  ui.btnEnd?.classList.remove("armed");
  setStatus("Call ended");
  setListening("—");
  stopClock();
  hardStopMedia();

  // Small delay to let UI show “Call ended”
  setTimeout(navigateHome, 350);
}

function navigateHome() {
  location.href = "./home.html";
}

/* -------------------------
   Start
-------------------------- */
boot().catch(console.error);
