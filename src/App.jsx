import { useState } from "react";
import "./App.css";
import { useVoiceCall } from "./useVoiceCall";

function App() {
  const { connected, token, robotMessage, isPlaying, isSpeaking, start, cleanup } =
    useVoiceCall();
  const [status, setStatus] = useState("Standby");

  const handleCallClick = () => {
    if (!connected) {
      setStatus("Connecting...");
      start();
    } else {
      cleanup();
      setStatus("Standby");
    }
  };

  return (
    <div className="minimal-bg">
      <div className="center-content">
        <div className="orb-mic">
          <button
            className="call-btn"
            aria-label={connected ? "Stop Voice Call" : "Start Voice Call"}
            onClick={handleCallClick}
            style={
              connected ? { boxShadow: "0 0 0 8px rgba(255,80,80,0.18)" } : {}
            }
          >
            {/* Power icon */}
            <svg
              width="44"
              height="44"
              viewBox="0 0 44 44"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <circle cx="22" cy="22" r="22" fill="rgba(0,0,0,0.12)" />
              <path
                d="M22 12v10"
                stroke="#fff"
                strokeWidth="2.5"
                strokeLinecap="round"
              />
              <path
                d="M29.5 18.5a9 9 0 1 1-15 0"
                stroke="#fff"
                strokeWidth="2.5"
                fill="none"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
        <h1 className="main-title">Sphinx Voice Agent</h1>
        <div className="desc">
          {connected
            ? "Đang kết nối voice call..."
            : status === "Standby"
              ? "Nhấn Connect để bắt đầu voice chat"
              : status}
        </div>
        <div style={{ margin: "16px 0", color: "#fff", minHeight: 24 }}>
          {/* Hiển thị câu trả lời thực sự của robot, không hiển thị trạng thái */}
          {robotMessage &&
            robotMessage !== "Robot bắt đầu trả lời..." &&
            robotMessage !== "Robot đã trả lời xong." &&
            robotMessage !== "" && (
              <div>
                <b>Robot:</b> {robotMessage}
              </div>
            )}
          {/* {transcript && (
            <div>
              <b>Transcript:</b> {transcript}
            </div>
          )} */}
          {token && (
            <div>
              <b>Token:</b> {token}
            </div>
          )}
        </div>
        <div className={`wave-static${(isPlaying || isSpeaking) ? " wave-active" : ""}`}>
          <span />
          <span />
          <span />
          <span />
          <span />
        </div>
      </div>
      <div className="corner-status">
        <span className={`dot ${connected ? "red" : "gray"}`} />{" "}
        {connected ? "Đang kết nối" : status}
      </div>
      {/* <div className="corner-toolbar">
        <button className="tb">WebRTC</button>
        <button className="tb active">WebSocket</button>
        <button className="tb">Nam - Miền Bắc</button>
      </div> */}
    </div>
  );
}

export default App;
