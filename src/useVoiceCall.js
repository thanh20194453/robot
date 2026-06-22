import { useEffect, useRef, useState } from "react";

// ========== CONFIGURATION ==========
const WS_URL =
  "wss://api-agent.svisor.vn/ws/voice-call/c50b9a6d-0aa7-470f-86ae-d2577a4e7026?api_key=vk_e4d0ceefc936ed26f24ce1d02fcc6ce50c80580b0755c86ba36d445a5ca1e1d3";
const SEND_RATE = 16000;   // 16kHz — AudioContext sẽ resample về đây
const RECV_RATE = 24000;   // 24kHz (AI_RATE_RECV)
const FRAME_SAMPLES = 1600; // 100ms @ 16kHz — khớp với test9_asr.py, ít message hơn qua proxy
const HANDSHAKE_TIMEOUT_MS = 20000;

// iOS Safari không hỗ trợ <audio>.srcObject từ Web Audio MediaStream đúng cách
// → "rararara" loop. Trên iOS dùng ctx.destination trực tiếp — hardware AEC đủ tốt.
const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
               (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

// AudioWorklet processor — chạy trong audio thread.
// AudioContext đã được set về 16kHz nên không cần resample trong worklet.
// AGC được thêm để normalize volume về mức ASR mong đợi (~-9dBFS),
// tương đương AGC(target_dbfs=-9.0) trong outbound.py.
// Không áp dụng gain cho frame gần-silence để ASR VAD nhận đúng silence → is_final nhanh.
const WORKLET_CODE = `
class PCMSenderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = new Float32Array(0);
    this._frameSize = ${FRAME_SAMPLES};
    this._gain = 1.0; // AGC gain state
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch || !ch.length) return true;

    const merged = new Float32Array(this._buf.length + ch.length);
    merged.set(this._buf);
    merged.set(ch, this._buf.length);
    this._buf = merged;

    while (this._buf.length >= this._frameSize) {
      const frame = this._buf.slice(0, this._frameSize);
      this._buf = this._buf.slice(this._frameSize);

      // Tính RMS
      let sum = 0;
      for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
      const rms = Math.sqrt(sum / frame.length);

      // AGC: normalize speech về ~-9dBFS (tương đương outbound.py AGC target_dbfs=-9.0).
      // Chỉ áp dụng khi rms > 0.005 (noise floor) — không amplify silence
      // để ASR VAD phân biệt được speech vs silence → is_final trigger nhanh.
      const TARGET_RMS = 0.35;  // -9dBFS ≈ 0.354
      const MAX_GAIN   = 20.0;  // tối đa +26dB, tránh amplify noise quá mức
      const NOISE_FLOOR = 0.005;

      if (rms > NOISE_FLOOR) {
        const desired = Math.min(TARGET_RMS / rms, MAX_GAIN);
        // Smooth: attack nhanh (0.3), release chậm (0.05) — giống AGC outbound
        if (desired < this._gain) {
          this._gain = this._gain * 0.7 + desired * 0.3;  // attack
        } else {
          this._gain = this._gain * 0.95 + desired * 0.05; // release
        }
      }

      const int16 = new Int16Array(this._frameSize);
      for (let i = 0; i < this._frameSize; i++) {
        let s = frame[i];
        if (rms > NOISE_FLOOR) {
          s = Math.max(-1, Math.min(1, s * this._gain));
        }
        int16[i] = s < 0 ? s * 32768 : s * 32767;
      }
      this.port.postMessage(int16.buffer, [int16.buffer]);
    }
    return true;
  }
}
registerProcessor('pcm-sender', PCMSenderProcessor);
`;

export function useVoiceCall() {
  const [connected, setConnected] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [token, setToken] = useState("");
  const [isWaitingForRobot, setIsWaitingForRobot] = useState(false);
  const [robotMessage, setRobotMessage] = useState("");
  const [isPlaying, setIsPlaying] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const isSpeakingTimeoutRef = useRef(null);
  const wsRef = useRef(null);
  const audioContextRef = useRef(null);
  const recvAudioContextRef = useRef(null);
  const isPlayingRef = useRef(false);
  const isRobotRespondingRef = useRef(false);
  const nextPlayTimeRef = useRef(0);
  const activeSourcesRef = useRef(0);
  const scheduledSourcesRef = useRef([]);
  const audioGenRef = useRef(0);
  const discardAudioRef = useRef(false);
  const mediaStreamDestRef = useRef(null); // MediaStreamDestination — TTS → <audio> element để AEC có reference
  const audioElRef = useRef(null);          // <audio> element nhận MediaStream
  const masterGainRef = useRef(null);       // Master gain — set 0 on barge-in để iOS không phát stale chunks
  const micStreamRef = useRef(null);
  const workletNodeRef = useRef(null);        // AudioWorklet node
  const handshakeDoneRef = useRef(false);
  const handshakeTimerRef = useRef(null);

  // Stop all scheduled audio immediately (barge-in)
  const stopAudio = (reason = "") => {
    audioGenRef.current++;
    discardAudioRef.current = true;
    // Mute master gain trước — iOS Safari có thể không honor source.stop() cho
    // các BufferSource đã schedule trong tương lai, khiến chúng vẫn phát ra âm
    // thanh tại currentTime → "bạ bạ bạ bạ" loop. Gain=0 chặn mọi output.
    if (masterGainRef.current && recvAudioContextRef.current) {
      const ctx = recvAudioContextRef.current;
      masterGainRef.current.gain.cancelScheduledValues(ctx.currentTime);
      masterGainRef.current.gain.setValueAtTime(0, ctx.currentTime);
    }
    scheduledSourcesRef.current.forEach((src) => {
      try { src.stop(); } catch { /* already ended */ }
      try { src.disconnect(); } catch { /* already disconnected */ }
    });
    scheduledSourcesRef.current = [];
    nextPlayTimeRef.current = 0;
    activeSourcesRef.current = 0;
    isPlayingRef.current = false;
    setIsPlaying(false);
    if (reason) console.log(`[BARGE-IN] stopAudio: ${reason}`);
  };

  const start = async () => {
    if (wsRef.current) return;

    // Init recv audio trong user gesture — mobile yêu cầu AudioContext.resume()
    // và audioEl.play() được gọi từ user interaction, không phải từ callback async.
    if (!recvAudioContextRef.current) {
      recvAudioContextRef.current = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: RECV_RATE,
      });
      // Master gain node — điểm trung gian duy nhất cho tất cả TTS audio.
      // Khi barge-in: set gain=0 ngay lập tức để mute, dù iOS không stop được source.
      masterGainRef.current = recvAudioContextRef.current.createGain();
      if (!IS_IOS) {
        // Non-iOS: route qua <audio> element để AEC có reference signal
        mediaStreamDestRef.current = recvAudioContextRef.current.createMediaStreamDestination();
        audioElRef.current = new Audio();
        audioElRef.current.srcObject = mediaStreamDestRef.current.stream;
        audioElRef.current.play().catch(() => {});
        masterGainRef.current.connect(mediaStreamDestRef.current);
      } else {
        // iOS: dùng ctx.destination trực tiếp — hardware AEC đủ tốt,
        // và <audio>.srcObject từ Web Audio MediaStream gây lỗi trên iOS Safari
        masterGainRef.current.connect(recvAudioContextRef.current.destination);
      }

      // Khi context resume sau khi bị suspend (màn hình tắt, app background):
      // reset nextPlayTimeRef để tránh nhiều chunk schedule đồng thời → "rararara"
      recvAudioContextRef.current.onstatechange = () => {
        if (recvAudioContextRef.current?.state === "running") {
          const ctx = recvAudioContextRef.current;
          if (nextPlayTimeRef.current > ctx.currentTime + 5) {
            // nextPlayTimeRef quá xa trong tương lai → context bị reset → resync
            nextPlayTimeRef.current = 0;
          }
        }
      };
    }
    await recvAudioContextRef.current.resume().catch(() => {});

    wsRef.current = new WebSocket(WS_URL);
    wsRef.current.binaryType = "arraybuffer";

    wsRef.current.onopen = () => {
      console.log("[WS] Connected — waiting for server 'ready' handshake...");
      handshakeTimerRef.current = setTimeout(() => {
        if (!handshakeDoneRef.current) {
          console.warn("[WS] Handshake timeout — server did not send 'ready'");
          cleanup();
        }
      }, HANDSHAKE_TIMEOUT_MS);
    };
    wsRef.current.onclose = cleanup;
    wsRef.current.onerror = cleanup;
    wsRef.current.onmessage = handleMessage;
  };

  const cleanup = () => {
    setConnected(false);
    handshakeDoneRef.current = false;
    clearTimeout(handshakeTimerRef.current);
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    if (workletNodeRef.current) {
      workletNodeRef.current.port.onmessage = null;
      workletNodeRef.current.disconnect();
      workletNodeRef.current = null;
    }
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    if (audioElRef.current) {
      audioElRef.current.srcObject = null;
      audioElRef.current = null;
    }
    mediaStreamDestRef.current = null;
    masterGainRef.current = null;
    if (recvAudioContextRef.current) {
      recvAudioContextRef.current.close();
      recvAudioContextRef.current = null;
    }
    scheduledSourcesRef.current = [];
    nextPlayTimeRef.current = 0;
    activeSourcesRef.current = 0;
    audioGenRef.current = 0;
    discardAudioRef.current = false;
    setIsSpeaking(false);
    clearTimeout(isSpeakingTimeoutRef.current);
  };

  const handleMessage = (event) => {
    if (typeof event.data === "string") {
      try {
        const data = JSON.parse(event.data);

        // ── Handshake: chờ "ready" từ server trước khi bật mic ──
        if (!handshakeDoneRef.current) {
          clearTimeout(handshakeTimerRef.current);
          if (data.type === "ready") {
            handshakeDoneRef.current = true;
            setConnected(true);
            console.log("[WS] Handshake OK — server ready, starting mic");
            startMic();
          } else {
            console.warn(`[WS] Handshake failed: expected 'ready', got '${data.type}'`);
            cleanup();
          }
          return;
        }

        // ── Xử lý message sau handshake ──
        if (data.type === "interrupt") {
          stopAudio("server interrupt");
          console.log("[INTERRUPT] Audio buffer cleared by server");
        } else if (data.type === "transcript") {
          setTranscript(data.text || "");
          setRobotMessage(data.text || "");
          stopAudio("server transcript received");
          console.log("[ROBOT TRANSCRIPT]", data.text);
        } else if (data.type === "token") {
          setToken(data.token || "");
          setRobotMessage(data.token || "");
          console.log("[ROBOT TOKEN]", data.token);
        } else if (data.type === "agent_start") {
          setIsWaitingForRobot(true);
          isRobotRespondingRef.current = true;
          discardAudioRef.current = false;
          setRobotMessage("Robot bắt đầu trả lời...");
          console.log("[ROBOT AGENT START]", data);
        } else if (data.type === "agent_done") {
          setIsWaitingForRobot(false);
          isRobotRespondingRef.current = false;
          nextPlayTimeRef.current = 0;
          setRobotMessage("Robot đã trả lời xong.");
          console.log("[ROBOT AGENT DONE]", data);
        } else if (data.type === "error") {
          setRobotMessage(data.message || "Lỗi từ robot");
          console.log("[ROBOT ERROR]", data.message);
        } else {
          setRobotMessage(JSON.stringify(data));
          console.log("[ROBOT UNKNOWN]", data);
        }
      } catch {
        // ignore
      }
    } else if (event.data instanceof ArrayBuffer) {
      scheduleAudio(event.data);
    }
  };

  const startMic = async () => {
    if (!audioContextRef.current) {
      // Force 16kHz — browser tự resample từ hardware rate (48kHz) xuống đây
      // bằng resampler chất lượng cao nội bộ, tốt hơn linear interpolation tự viết.
      audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: SEND_RATE,
        latencyHint: "interactive",
      });
    }
    const ctx = audioContextRef.current;
    if (ctx.state === "suspended") await ctx.resume();

    try {
      micStreamRef.current = await navigator.mediaDevices.getUserMedia({
        audio: {
          noiseSuppression: true,
          echoCancellation: true,
          autoGainControl: true,
          // Không ép sampleRate — để hardware capture native rate
        },
      });

      // Load AudioWorklet từ inline Blob — chạy trong audio thread, không jitter
      const blob = new Blob([WORKLET_CODE], { type: "application/javascript" });
      const workletUrl = URL.createObjectURL(blob);
      await ctx.audioWorklet.addModule(workletUrl);
      URL.revokeObjectURL(workletUrl);

      const source = ctx.createMediaStreamSource(micStreamRef.current);
      workletNodeRef.current = new AudioWorkletNode(ctx, "pcm-sender");

      // Kết nối vào destination với gain=0 để giữ audio graph hoạt động
      const silentGain = ctx.createGain();
      silentGain.gain.value = 0;
      workletNodeRef.current.connect(silentGain);
      silentGain.connect(ctx.destination);
      source.connect(workletNodeRef.current);

      let frameCount = 0;

      workletNodeRef.current.port.onmessage = (e) => {
        const int16 = new Int16Array(e.data);

        // RMS cho isSpeaking UI indicator
        let sum = 0;
        for (let i = 0; i < int16.length; i++) {
          const s = int16[i] / 32768;
          sum += s * s;
        }
        const rms = Math.sqrt(sum / int16.length);

        frameCount++;
        if (frameCount % 100 === 0) {
          console.log(`[MIC] frame=${frameCount} rms=${rms.toFixed(4)}`);
        }

        if (rms > 0.01) {
          setIsSpeaking(true);
          clearTimeout(isSpeakingTimeoutRef.current);
          isSpeakingTimeoutRef.current = setTimeout(() => setIsSpeaking(false), 400);
        }

        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

        // Không cần software echo gate — TTS phát qua <audio> element nên
        // browser AEC có reference signal và tự cancel echo trước khi vào worklet.
        const bytes = new Uint8Array(e.data);
        let binary = "";
        for (let i = 0; i < bytes.length; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        wsRef.current.send(
          JSON.stringify({ audio_event: { audio_base_64: btoa(binary) } }),
        );
      };

      console.log(`[MIC] AudioWorklet started — frameSize=${FRAME_SAMPLES} (${FRAME_SAMPLES / (ctx.sampleRate / 1000)}ms/frame @ ${ctx.sampleRate}Hz)`);
    } catch (err) {
      console.error("[MIC] AudioWorklet failed:", err);
      setRobotMessage("Không thể truy cập microphone: " + err.message);
    }
  };

  // Play received audio (PCM 16bit mono, 24kHz)
  // Dùng MediaStreamDestination → <audio> element thay vì ctx.destination trực tiếp.
  // <audio> element đi qua system audio path → AEC của browser có reference signal → tự cancel echo mic.
  const scheduleAudio = (arrayBuffer) => {
    if (discardAudioRef.current) return;
    if (!recvAudioContextRef.current) return; // chưa init (start() chưa được gọi)

    const ctx = recvAudioContextRef.current;
    if (ctx.state === "suspended") {
      ctx.resume().catch(() => {});
      // Khi context đang suspended, currentTime dừng lại. Các chunk mới không nên
      // nối theo nextPlayTimeRef cũ → reset để chúng play ngay khi context resume.
      nextPlayTimeRef.current = 0;
    }

    const int16Array = new Int16Array(arrayBuffer);
    const float32Array = new Float32Array(int16Array.length);
    for (let i = 0; i < int16Array.length; i++) {
      float32Array[i] = int16Array[i] / 32768;
    }
    const buffer = ctx.createBuffer(1, float32Array.length, RECV_RATE);
    buffer.getChannelData(0).set(float32Array);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    // Restore master gain — re-arm sau barge-in (nếu gain đang bị set 0)
    masterGainRef.current.gain.setValueAtTime(1, ctx.currentTime);
    source.connect(masterGainRef.current);

    const startTime = Math.max(ctx.currentTime + 0.005, nextPlayTimeRef.current);
    source.start(startTime);
    nextPlayTimeRef.current = startTime + buffer.duration;

    scheduledSourcesRef.current.push(source);
    activeSourcesRef.current++;
    isPlayingRef.current = true;
    setIsPlaying(true);

    const myGen = audioGenRef.current;
    source.onended = () => {
      if (audioGenRef.current !== myGen) return;
      scheduledSourcesRef.current = scheduledSourcesRef.current.filter((s) => s !== source);
      activeSourcesRef.current--;
      if (activeSourcesRef.current <= 0) {
        activeSourcesRef.current = 0;
        isPlayingRef.current = false;
        setIsPlaying(false);
      }
    };
  };

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      // Màn hình bật lại / app foreground → resume AudioContext và audioEl
      recvAudioContextRef.current?.resume().catch(() => {});
      if (audioElRef.current?.paused) {
        audioElRef.current.play().catch(() => {});
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      cleanup();
    };
  }, []);

  return {
    connected,
    transcript,
    token,
    isWaitingForRobot,
    robotMessage,
    isPlaying,
    isSpeaking,
    start,
    cleanup,
  };
}
