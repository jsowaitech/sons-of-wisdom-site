// app/call.js
import { CONFIG } from "./config.js";
import { supabase, ensureLoggedIn } from "./supabase.js"; // named imports

const app = document.getElementById("app");

// ----- UI -----
app.innerHTML = `
  <button id="backBtn" class="btn btn-ghost back-btn">← Back</button>

  <section class="call-stage" id="stage">
    <div class="avatar-wrap">
      <div class="ring" id="ring"></div>
      <img class="avatar" src="${CONFIG.AVATAR_URL || './Sonofwisdom.png'}" alt="Avatar"/>
    </div>

    <div class="status-row">
      <span class="pill" id="statusPill">
        <span class="dot" id="statusDot"></span>
        <span id="statusText">Tap the blue call button to begin.</span>
      </span>
    </div>

    <div class="timer" id="timer">00:00</div>

    <div class="listen-bar" id="listenBar" aria-live="polite">Listening bar…</div>

    <div class="controls">
      <button id="micBtn" class="btn btn-icon" title="Mic on/off">
        <span class="i i-mic"></span>
      </button>
      <button id="hangBtn" class="btn btn-danger" title="End Voice Chat">
        <span class="i i-phone"></span>
        <span class="label">End Voice Chat</span>
      </button>
      <button id="spkBtn" class="btn btn-icon" title="Speaker on/off">
        <span class="i i-spk"></span>
      </button>
      <button id="moreBtn" class="btn btn-icon" title="More">
        <span class="i i-more"></span>
      </button>
    </div>
  </section>

  <audio id="ringAudio" preload="auto" src="./ring.mp3"></audio>
  <audio id="greetAudio" preload="auto" src="./blake.mp3"></audio>
  <audio id="ttsAudio" preload="auto" style="display:none"></audio>
`;

// ----- Elements -----
const backBtn   = document.getElementById("backBtn");
const ringEl    = document.getElementById("ring");
const pillEl    = document.getElementById("statusPill");
const dotEl     = document.getElementById("statusDot");
const textEl    = document.getElementById("statusText");
const timerEl   = document.getElementById("timer");
const barEl     = document.getElementById("listenBar");

const micBtn    = document.getElementById("micBtn");
const hangBtn   = document.getElementById("hangBtn");
const spkBtn    = document.getElementById("spkBtn");
const moreBtn   = document.getElementById("moreBtn");

const ringAudio   = document.getElementById("ringAudio");
const greetAudio  = document.getElementById("greetAudio");
const ttsAudio    = document.getElementById("ttsAudio");

// ----- State -----
let callId = null;
let user = null;

let ac;                // AudioContext
let inputStream;       // MediaStream (mic)
let mediaRec;          // MediaRecorder (for archival upload)
let recChunks = [];

let stt;               // Web Speech API recognizer
let sttActive = false;

let vadNode;           // ScriptProcessorNode (simple VAD)
let vadOn = false;
let speaking = false;
let ttsPlaying = false;

let timerInt;
let seconds = 0;

let abortSequence = false; // to stop ring/greeting immediately
let uploadingAllowed = true; // if bucket not found, we stop trying

// ----- Helpers -----
const sleep = (ms)=> new Promise(r=>setTimeout(r,ms));
const mmss = (s)=> `${String(Math.floor(s/60)).padStart(2,"0")}:${String(s%60).padStart(2,"0")}`;

function setStatus(kind, text) {
  // kind: 'idle' | 'connecting' | 'greeting' | 'listening' | 'speaking' | 'ended' | 'error'
  textEl.textContent = text;
  pillEl.dataset.kind = kind;
  if (kind === 'speaking') ringEl.dataset.state = 'speaking';
  else if (kind === 'listening') ringEl.dataset.state = 'listening';
  else ringEl.dataset.state = 'idle';
}

function startTimer() {
  clearInterval(timerInt);
  seconds = 0;
  timerEl.textContent = "00:00";
  timerInt = setInterval(()=> {
    seconds += 1;
    timerEl.textContent = mmss(seconds);
  }, 1000);
}

function stopTimer() {
  clearInterval(timerInt);
}

function safeStopAudio(a) {
  try { a.pause(); a.currentTime = 0; } catch {}
}

function nowTs() {
  return new Date().toISOString();
}

// ----- Auth -----
await ensureLoggedIn();
const { data: { user: u }} = await supabase.auth.getUser();
user = u;

// Create a call row (best-effort)
async function ensureCallRow() {
  if (callId) return callId;
  const ins = await supabase.from("calls")
    .insert([{ started_at: nowTs(), user_id: user?.id || null }])
    .select("id").single();
  if (!ins.error) callId = ins.data.id;
  return callId;
}

// Save audio blob to storage (best-effort)
async function uploadAudioBlob(blob) {
  if (!uploadingAllowed || !blob || blob.size === 0) return;
  try {
    const cid = await ensureCallRow();
    const path = `audio/${cid || "unknown"}/${Date.now()}.webm`;
    const up = await supabase.storage.from("audio").upload(path, blob, {
      contentType: "audio/webm",
      upsert: false
    });
    if (up.error && /Bucket not found/i.test(up.error.message)) {
      console.warn("[CALL] storage bucket 'audio' not found—skipping future uploads");
      uploadingAllowed = false;
    }
  } catch (e) {
    console.warn("[CALL] Upload error:", e);
  }
}

// ----- Audio / VAD / STT -----
async function initAudio() {
  if (ac) return;
  ac = new (window.AudioContext || window.webkitAudioContext)();
  inputStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });

  // recorder for archival
  mediaRec = new MediaRecorder(inputStream, { mimeType: "audio/webm" });
  mediaRec.ondataavailable = (e)=> { if (e.data?.size) recChunks.push(e.data); };
  mediaRec.onstop = ()=> {
    const blob = new Blob(recChunks, { type: "audio/webm" });
    recChunks = [];
    uploadAudioBlob(blob);
  };

  // VAD node
  const src = ac.createMediaStreamSource(inputStream);
  vadNode = ac.createScriptProcessor(1024, 1, 1);

  let frameCount = 0;
  let energyAvg = 0;
  let hang = 0;
  const THRESH = 0.015;     // base threshold
  const HANG_MAX = 12;      // frames after speech to keep "speaking"

  vadNode.onaudioprocess = (ev) => {
    const ch = ev.inputBuffer.getChannelData(0);
    let sum = 0;
    for (let i=0; i<ch.length; i++) {
      const s = ch[i];
      sum += s*s;
    }
    const rms = Math.sqrt(sum / ch.length);
    // running avg
    energyAvg = (energyAvg*0.95) + (rms*0.05);
    const thresh = Math.max(THRESH, energyAvg*1.2);

    const isSpeech = rms > thresh;
    if (isSpeech) {
      hang = HANG_MAX;
      if (!speaking) {
        speaking = true;
        onSpeechStart();
      }
    } else {
      if (hang > 0) hang--;
      if (speaking && hang === 0) {
        speaking = false;
        onSpeechEnd();
      }
    }

    // animate bar (0..1)
    const norm = Math.min(1, rms / 0.08);
    barEl.style.setProperty("--level", norm.toFixed(3));
  };

  src.connect(vadNode);
  vadNode.connect(ac.destination);

  vadOn = true;

  // STT (Web Speech API if available)
  if ("webkitSpeechRecognition" in window || "SpeechRecognition" in window) {
    const R = window.SpeechRecognition || window.webkitSpeechRecognition;
    stt = new R();
    stt.continuous = true;
    stt.interimResults = true;
    stt.lang = "en-US";
    stt.onstart = ()=> { sttActive = true; };
    stt.onerror = (e)=> console.warn("[STT] error:", e);
    stt.onend = ()=> { sttActive = false; if (vadOn) try { stt.start(); } catch {} };
    stt.onresult = (e)=> {
      // When we get a final result, send to n8n
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) {
          const txt = res[0].transcript.trim();
          if (txt) onFinalTranscript(txt);
        }
      }
    };
    try { stt.start(); } catch {}
  } else {
    console.warn("[STT] Web Speech API not available. Transcripts won't be generated.");
  }
}

function onSpeechStart() {
  // barge-in: stop TTS immediately
  if (ttsPlaying) {
    safeStopAudio(ttsAudio);
    ttsPlaying = false;
  }
  setStatus("listening", "Listening…");
}

function onSpeechEnd() {
  // If STT is present it will call onFinalTranscript via isFinal=true
  // If not present, we do nothing (no transcript is available).
}

// Called by STT with final text
async function onFinalTranscript(text) {
  setStatus("connecting", "Sending transcript to n8n…");
  console.log("[CALL] transcript sent to n8n:", text);

  // Optional: store session turn in DB (best-effort)
  try {
    const cid = await ensureCallRow();
    await supabase.from("call_sessions").insert([{
      call_id: cid,
      role: "user",
      ai_text: null,
      input_transcript: text,
      created_at: nowTs()
    }]);
  } catch {}

  // Send to n8n webhook (expects either JSON with {audio_url, transcript} or binary audio)
  try {
    const res = await fetch(CONFIG.N8N_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        call_id: callId,
        user_id: user?.id || null,
        text
      })
    });

    let srcUrl = null;

    // If JSON with a URL
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      const data = await res.json();
      if (data?.audio_url) {
        srcUrl = data.audio_url;
      } else if (data?.audio_base64) {
        const blob = b64ToBlob(data.audio_base64, "audio/mpeg");
        srcUrl = URL.createObjectURL(blob);
      }
    } else {
      // treat as audio binary
      const blob = await res.blob();
      srcUrl = URL.createObjectURL(blob);
    }

    if (!srcUrl) {
      setStatus("listening", "Listening…");
      return;
    }

    await playTTS(srcUrl);

    // store assistant turn
    try {
      const cid = await ensureCallRow();
      await supabase.from("call_sessions").insert([{
        call_id: cid,
        role: "assistant",
        ai_text: null,
        input_transcript: null,
        created_at: nowTs()
      }]);
    } catch {}

    setStatus("listening", "Listening…");
  } catch (e) {
    console.warn("[CALL] n8n error:", e);
    setStatus("error", "Network error. Still listening…");
  }
}

function b64ToBlob(b64, mime) {
  const bin = atob(b64);
  const len = bin.length;
  const u8 = new Uint8Array(len);
  for (let i=0; i<len; i++) u8[i] = bin.charCodeAt(i);
  return new Blob([u8], { type: mime });
}

async function playTTS(src) {
  ttsPlaying = true;
  setStatus("speaking", "AI is speaking…");
  ttsAudio.src = src;
  try { await ttsAudio.play(); } catch { ttsPlaying = false; return; }
  await new Promise((resolve)=> ttsAudio.onended = resolve);
  ttsPlaying = false;
}

// ----- Ring → Greeting → Listen -----
async function startSequence() {
  abortSequence = false;
  setStatus("connecting", "Connecting…");
  startTimer();

  // play ring twice
  for (let i=0; i<2; i++) {
    if (abortSequence) return; // stopped early
    safeStopAudio(ttsAudio);
    safeStopAudio(greetAudio);
    await ringAudio.play().catch(()=>{});
    await new Promise(r => ringAudio.onended = r);
    await sleep(80);
  }
  if (abortSequence) return;

  // greeting
  setStatus("greeting", "AI is greeting you…");
  await greetAudio.play().catch(()=>{});
  await new Promise(r => greetAudio.onended = r);

  if (abortSequence) return;
  setStatus("listening", "Listening…");
}

// ----- Start/Stop -----
async function startCall() {
  if (micBtn.dataset.state === "off") micBtn.click(); // ensure mic on

  await initAudio();
  if (mediaRec && mediaRec.state !== "recording") {
    try { mediaRec.start(); } catch {}
  }

  await startSequence(); // returns immediately if aborted
}

async function endCall() {
  // allow ending anytime
  abortSequence = true;

  setStatus("ended", "Call ended");
  stopTimer();

  // stop audios
  [ringAudio, greetAudio, ttsAudio].forEach(safeStopAudio);

  // stop STT
  if (sttActive && stt) { try { stt.stop(); } catch {} }
  sttActive = false;

  // stop VAD + input
  if (vadNode) try { vadNode.disconnect(); } catch {}
  vadOn = false;

  if (ac) {
    try { ac.close(); } catch {}
    ac = null;
  }
  if (inputStream) {
    try { inputStream.getTracks().forEach(t=>t.stop()); } catch {}
    inputStream = null;
  }

  // finalize recorder
  if (mediaRec && mediaRec.state !== "inactive") {
    try { mediaRec.stop(); } catch {}
  }

  // end in DB
  try {
    const cid = await ensureCallRow();
    await supabase.from("calls").update({ ended_at: nowTs() }).eq("id", cid);
  } catch {}

  // short delay for UI, then home
  await sleep(250);
  location.href = "./home.html";
}

// ----- Buttons -----
backBtn.onclick = () => location.href = "./home.html";

micBtn.onclick = () => {
  const off = micBtn.dataset.state === "off";
  micBtn.dataset.state = off ? "on" : "off";
  micBtn.title = off ? "Mic on" : "Mic off";
  // we keep the stream open for VAD; if you'd like real mute, stop tracks instead:
  // inputStream?.getAudioTracks().forEach(t => t.enabled = off);
};

spkBtn.onclick = () => {
  const off = spkBtn.dataset.state === "off";
  spkBtn.dataset.state = off ? "on" : "off";
  const enabled = off;
  [ringAudio, greetAudio, ttsAudio].forEach(a => a.muted = !enabled);
};

hangBtn.onclick = () => {
  // Always works—even during ring/greeting
  endCall();
};

moreBtn.onclick = () => {
  alert("Coming soon: CC view • Save audio • Device picker");
};

// start immediately
startCall();
