import {
  auth,
  loginWithGoogle,
  logoutUser,
  testFirestoreConnection,
  saveWarehouseLayout,
  getSavedLayouts,
  deleteWarehouseLayout,
  logFleetMission,
  getRecentFleetMissions,
  SavedLayout,
  FleetMissionRecord,
} from "./firebase";
import {
  sendChatMessage,
  transcribeAudioBlob,
  generateWarehouseImage,
  editWarehouseImage,
  generateVeoVideo,
  generateLyriaMusic,
  LiveVoiceClient,
  ChatMessage,
} from "./gemini-service";
import { marked } from "marked";

declare global {
  interface Window {
    __AMR_SIM__?: {
      fleet: any[];
      dynamicObstacles: Set<number>;
      STATIONS: Record<string, any>;
      CELL_SIZE: number;
      addTelemetry: (tag: string, msg: string) => void;
      toggleObstacleAtWorldPos: (x: number, y: number) => void;
      clearAllObstacles: () => void;
      getObstacleList: () => number[];
      setObstacleList: (list: number[]) => void;
      getTelemetrySnapshot: () => string;
    };
  }
}

// Global state
let isInitialized = false;
let chatHistory: ChatMessage[] = [];
let liveVoiceClient: LiveVoiceClient | null = null;
let isRecordingForTranscription = false;
let mediaRecorder: MediaRecorder | null = null;
let audioChunks: Blob[] = [];

export function initAmrAiAndCloud() {
  if (isInitialized) return;
  isInitialized = true;
  console.log("Initializing AMR AI & Cloud System...");

  // Verify Firestore connection on boot
  testFirestoreConnection().then((connected) => {
    console.log("Firestore connection test status:", connected ? "READY" : "CONNECTING");
    updateDbStatusBadge(connected);
  });

  // Inject UI controls into DOM
  injectHeaderAuthButton();
  injectSidebarTabs();
  injectTabPanes();
  setupAuthListeners();
  setupCopilotListeners();
  setupStudioListeners();
  setupCloudListeners();
}

function updateDbStatusBadge(connected: boolean) {
  const badge = document.getElementById("db-status-badge");
  if (badge) {
    if (connected) {
      badge.innerHTML = `<span class="pulse-dot" style="background:#10b981;"></span> FIRESTORE CONNECTED`;
      badge.style.color = "#10b981";
      badge.style.borderColor = "rgba(16, 185, 129, 0.4)";
    } else {
      badge.innerHTML = `<span class="pulse-dot" style="background:#f59e0b;"></span> FIRESTORE INITIALIZING`;
      badge.style.color = "#f59e0b";
      badge.style.borderColor = "rgba(245, 158, 11, 0.4)";
    }
  }
}

function injectHeaderAuthButton() {
  const headerActions = document.querySelector(".header-actions");
  if (!headerActions) return;

  const authWrapper = document.createElement("div");
  authWrapper.id = "hdr-auth-wrapper";
  authWrapper.style.display = "flex";
  authWrapper.style.alignItems = "center";
  authWrapper.style.gap = "8px";

  authWrapper.innerHTML = `
    <div id="hdr-user-chip" style="display:flex; align-items:center; gap:6px;">
      <button id="btn-hdr-login" class="mini-btn btn-primary">
        <svg style="width:13px; height:13px; fill:currentColor;" viewBox="0 0 24 24">
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z"/>
        </svg>
        <span>Google Sign-In</span>
      </button>
    </div>
  `;

  headerActions.appendChild(authWrapper);

  document.getElementById("btn-hdr-login")?.addEventListener("click", () => {
    switchTab("cloud");
    loginWithGoogle().catch((err) => {
      alert("Sign-in error: " + (err.message || err));
    });
  });
}

function injectSidebarTabs() {
  const tabHeader = document.querySelector(".tab-header");
  if (!tabHeader) return;

  // Add the 3 new tabs
  const tabAi = document.createElement("button");
  tabAi.className = "tab-btn";
  tabAi.id = "tab-btn-ai";
  tabAi.dataset.tab = "ai";
  tabAi.textContent = "AI Copilot";

  const tabStudio = document.createElement("button");
  tabStudio.className = "tab-btn";
  tabStudio.id = "tab-btn-studio";
  tabStudio.dataset.tab = "studio";
  tabStudio.textContent = "Media Studio";

  const tabCloud = document.createElement("button");
  tabCloud.className = "tab-btn";
  tabCloud.id = "tab-btn-cloud";
  tabCloud.dataset.tab = "cloud";
  tabCloud.textContent = "Cloud Ops";

  tabHeader.appendChild(tabAi);
  tabHeader.appendChild(tabStudio);
  tabHeader.appendChild(tabCloud);

  // Hook tab switching for new tabs
  [tabAi, tabStudio, tabCloud].forEach((btn) => {
    btn.addEventListener("click", () => {
      switchTab(btn.dataset.tab as string);
    });
  });
}

function switchTab(tabId: string) {
  const tabBtns = document.querySelectorAll(".tab-btn");
  const tabPanes = document.querySelectorAll(".tab-pane");

  tabBtns.forEach((b) => b.classList.remove("active"));
  tabPanes.forEach((p) => ((p as HTMLElement).style.display = "none"));

  const targetBtn = document.getElementById(`tab-btn-${tabId}`);
  const targetPane = document.getElementById(`pane-${tabId}`);

  if (targetBtn) targetBtn.classList.add("active");
  if (targetPane) (targetPane as HTMLElement).style.display = "flex";

  if (tabId === "cloud") {
    refreshCloudData();
  }
}

function injectTabPanes() {
  const sidebar = document.getElementById("hud-sidebar");
  if (!sidebar) return;

  // 1. Pane AI Copilot
  const paneAi = document.createElement("div");
  paneAi.className = "tab-pane";
  paneAi.id = "pane-ai";
  paneAi.style.display = "none";
  paneAi.style.flexDirection = "column";
  paneAi.style.gap = "10px";
  paneAi.innerHTML = `
    <!-- Top Copilot Config Bar -->
    <div style="background: rgba(15,23,42,0.9); border: 1px solid var(--border-subtle); border-radius: 8px; padding: 10px; display: flex; flex-direction: column; gap: 8px;">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <span style="font-size:11px; font-weight:700; color:var(--accent-cyan); display:flex; align-items:center; gap:6px;">
          <svg style="width:14px; height:14px; fill:currentColor;" viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>
          AMR FLEET COPILOT
        </span>
        <select id="ai-model-select" class="log-filter-select" style="padding:2px 6px;">
          <option value="gemini-3.5-flash">Gemini 3.5 Flash (Default / Balanced)</option>
          <option value="gemini-3.1-pro-preview">Gemini 3.1 Pro (Complex Reasoning)</option>
          <option value="gemini-3.1-flash-lite">Gemini 3.1 Flash Lite (High Speed)</option>
        </select>
      </div>

      <div style="display:flex; gap:6px; flex-wrap:wrap; align-items:center;">
        <span style="font-size:10px; color:var(--text-muted); font-family:var(--font-mono);">GROUNDING:</span>
        <button id="btn-ground-search" class="toggle-btn" title="Enable Google Search Grounding with gemini-3.5-flash">Search Grounding</button>
        <button id="btn-ground-maps" class="toggle-btn" title="Enable Google Maps Grounding with gemini-3.5-flash">Maps Grounding</button>
        <button id="btn-toggle-telemetry-context" class="toggle-btn active" title="Inject live robot coordinates and battery into model prompt">Fleet Telemetry</button>
      </div>
    </div>

    <!-- Live Voice Radio Box -->
    <div id="live-voice-box" style="background: rgba(6,182,212,0.06); border: 1px solid rgba(6,182,212,0.25); border-radius: 8px; padding: 8px 12px; display: flex; align-items: center; justify-content: space-between;">
      <div style="display:flex; align-items:center; gap:8px;">
        <div id="live-indicator" style="width:10px; height:10px; border-radius:50%; background:#64748b;"></div>
        <div>
          <div style="font-size:11px; font-weight:700; color:var(--text-primary);">Live Voice Radio (gemini-3.8-live)</div>
          <div id="live-status-text" style="font-size:9.5px; color:var(--text-muted); font-family:var(--font-mono);">Push-to-talk bidirectional audio stream</div>
        </div>
      </div>
      <button id="btn-live-toggle" class="mini-btn btn-primary">Start Radio</button>
    </div>

    <!-- Scrollable Chat Message Container -->
    <div id="ai-chat-thread" style="flex: 1; min-height: 260px; max-height: 380px; overflow-y: auto; background: #060911; border: 1px solid var(--border-subtle); border-radius: 8px; padding: 12px; display: flex; flex-direction: column; gap: 10px;">
      <!-- Welcome Message -->
      <div style="background: rgba(15,23,42,0.7); border: 1px solid rgba(255,255,255,0.05); border-radius: 6px; padding: 8px 10px; font-size: 11.5px; line-height: 1.5; color: var(--text-secondary);">
        <strong style="color:var(--accent-cyan); display:block; margin-bottom:4px;">Autonomous Fleet Operations Copilot</strong>
        I am connected to the warehouse P2P mesh network. You can ask me to evaluate intersection conflicts, identify low-battery bottlenecks, or propose route detours. You can speak via the microphone or type below.
      </div>
    </div>

    <!-- Quick Action Chips -->
    <div style="display:flex; gap:4px; overflow-x:auto; padding-bottom:2px;">
      <button class="mini-btn quick-prompt" data-prompt="Analyze current fleet bottlenecks and tell me which AMR needs intervention.">Audit Bottlenecks</button>
      <button class="mini-btn quick-prompt" data-prompt="Where are the nearest EV charging docks or battery exchange stations for AMR-02?">Nearest Docks (Maps)</button>
      <button class="mini-btn quick-prompt" data-prompt="Explain the space-time horizon deconfliction math between AMR-01 and AMR-04.">Conflict Math</button>
      <button class="mini-btn quick-prompt" data-prompt="What are the latest 2026 OSHA safety standards for autonomous mobile robot aisle clearance?">OSHA Safety (Search)</button>
    </div>

    <!-- Message Input Bar with Microphone Transcription -->
    <div style="display: flex; gap: 6px; align-items: center; position: relative;">
      <button id="btn-mic-transcribe" class="mini-btn" title="Speak into microphone (gemini-3.5-transcribe)">
        <svg style="width:14px; height:14px; fill:currentColor;" viewBox="0 0 24 24"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/><path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg>
        <span id="txt-mic-status">Mic</span>
      </button>
      <input id="ai-chat-input" type="text" placeholder="Ask Copilot or dictate AMR command..." style="flex:1; background:var(--bg-card); border:1px solid var(--border-subtle); border-radius:6px; padding:7px 10px; font-size:12px; color:var(--text-primary); font-family:var(--font-sans); outline:none;" />
      <button id="btn-ai-send" class="btn-primary" style="padding:6px 12px;">Send</button>
    </div>
  `;

  // 2. Pane Studio & Media
  const paneStudio = document.createElement("div");
  paneStudio.className = "tab-pane";
  paneStudio.id = "pane-studio";
  paneStudio.style.display = "none";
  paneStudio.style.flexDirection = "column";
  paneStudio.style.gap = "12px";
  paneStudio.innerHTML = `
    <!-- Studio Sub-Tab Switcher -->
    <div style="display:flex; border-bottom:1px solid var(--border-subtle); gap:4px;">
      <button class="studio-subtab active mini-btn" data-sub="image">Image Studio</button>
      <button class="studio-subtab mini-btn" data-sub="video">Veo 3 Video</button>
      <button class="studio-subtab mini-btn" data-sub="music">Lyria Music</button>
    </div>

    <!-- Section A: Image Studio (gemini-3.1-flash-image) -->
    <div id="sub-image" class="studio-section" style="display:flex; flex-direction:column; gap:10px;">
      <div class="info-box">
        <h4>Warehouse Visuals & Schematics (gemini-3.1-flash-image)</h4>
        <p>Generate safety warning signage, warehouse floorplans, or edit diagrams with prompt modifications.</p>
      </div>

      <div style="display:flex; flex-direction:column; gap:6px;">
        <label style="font-size:10.5px; font-family:var(--font-mono); color:var(--text-muted);">PROMPT</label>
        <textarea id="img-prompt-input" rows="2" style="background:var(--bg-card); border:1px solid var(--border-subtle); border-radius:6px; padding:6px 8px; font-size:11.5px; color:var(--text-primary); resize:vertical;" placeholder="Industrial ISO warning sign for high-speed autonomous mobile robot zone..."></textarea>
      </div>

      <div style="display:flex; gap:8px; align-items:center;">
        <span style="font-size:10px; font-family:var(--font-mono); color:var(--text-muted);">ASPECT RATIO:</span>
        <select id="img-aspect-ratio" class="log-filter-select">
          <option value="1:1">1:1 Square</option>
          <option value="16:9">16:9 Landscape</option>
          <option value="9:16">9:16 Portrait</option>
          <option value="4:3">4:3 Standard</option>
        </select>
        <button id="btn-generate-img" class="btn-primary" style="margin-left:auto;">Generate Image</button>
      </div>

      <!-- Image Editor Upload -->
      <div style="background:rgba(15,23,42,0.6); border:1px dashed var(--border-subtle); border-radius:6px; padding:8px; text-align:center;">
        <span style="font-size:10.5px; color:var(--text-secondary); display:block; margin-bottom:4px;">Or edit an existing image:</span>
        <input type="file" id="img-upload-file" accept="image/*" style="font-size:10px; color:var(--text-muted);" />
        <button id="btn-edit-img" class="mini-btn" style="margin-top:6px; display:none;">Apply Edit Prompt to Uploaded Photo</button>
      </div>

      <div id="img-result-container" style="display:none; flex-direction:column; gap:6px; background:#060911; border:1px solid var(--border-subtle); border-radius:6px; padding:8px; text-align:center;">
        <img id="img-result-display" style="max-width:100%; max-height:260px; object-fit:contain; border-radius:4px; margin:0 auto;" />
        <div id="img-caption" style="font-size:10.5px; color:var(--text-secondary); text-align:left;"></div>
        <a id="img-download-link" class="mini-btn" download="warehouse_asset.png" style="align-self:center;">Download Image</a>
      </div>
    </div>

    <!-- Section B: Veo 3 Video (veo-3.1-fast-generate-preview) -->
    <div id="sub-video" class="studio-section" style="display:none; flex-direction:column; gap:10px;">
      <div class="info-box">
        <h4>Veo 3 Autonomous Video Generation (veo-3.1-fast-generate-preview)</h4>
        <p>Synthesize high-definition videos from text prompts or animate uploaded robot and warehouse photos.</p>
      </div>

      <div style="display:flex; flex-direction:column; gap:6px;">
        <label style="font-size:10.5px; font-family:var(--font-mono); color:var(--text-muted);">VIDEO PROMPT</label>
        <textarea id="video-prompt-input" rows="2" style="background:var(--bg-card); border:1px solid var(--border-subtle); border-radius:6px; padding:6px 8px; font-size:11.5px; color:var(--text-primary); resize:vertical;" placeholder="An autonomous mobile robot carrying a pallet smoothly turns around warehouse racking with blue LiDAR scanning lights..."></textarea>
      </div>

      <div style="display:flex; gap:8px; align-items:center;">
        <span style="font-size:10px; font-family:var(--font-mono); color:var(--text-muted);">ASPECT RATIO:</span>
        <select id="video-aspect-ratio" class="log-filter-select">
          <option value="16:9">16:9 (Landscape)</option>
          <option value="9:16">9:16 (Portrait)</option>
        </select>
      </div>

      <div style="background:rgba(15,23,42,0.6); border:1px dashed var(--border-subtle); border-radius:6px; padding:8px;">
        <span style="font-size:10.5px; color:var(--text-secondary); display:block; margin-bottom:4px;">Optional: Starting Photo to Animate</span>
        <input type="file" id="video-image-file" accept="image/*" style="font-size:10px; color:var(--text-muted);" />
      </div>

      <button id="btn-generate-video" class="btn-primary" style="justify-content:center;">Generate Veo Video</button>

      <div id="video-progress-box" style="display:none; background:rgba(6,182,212,0.08); border:1px solid rgba(6,182,212,0.3); border-radius:6px; padding:10px; font-size:11px; color:var(--accent-cyan);">
        <div style="display:flex; align-items:center; gap:8px;">
          <span class="pulse-dot" style="background:var(--accent-cyan);"></span>
          <span id="video-progress-text">Veo Video Synthesizing...</span>
        </div>
      </div>

      <div id="video-result-container" style="display:none; flex-direction:column; gap:6px; background:#060911; border:1px solid var(--border-subtle); border-radius:6px; padding:8px;">
        <video id="video-result-player" controls autoplay loop style="width:100%; max-height:260px; border-radius:4px; background:#000;"></video>
        <a id="video-download-btn" class="mini-btn" download="veo_amr_video.mp4" style="align-self:center;">Download Video</a>
      </div>
    </div>

    <!-- Section C: Lyria Music (lyria-3-clip-preview & lyria-3-pro-preview) -->
    <div id="sub-music" class="studio-section" style="display:none; flex-direction:column; gap:10px;">
      <div class="info-box">
        <h4>Lyria Warehouse Soundscapes (lyria-3-clip-preview & lyria-3-pro-preview)</h4>
        <p>Synthesize atmospheric ambient electronic audio, telemetry notification chimes, or full soundtrack tracks.</p>
      </div>

      <div style="display:flex; flex-direction:column; gap:6px;">
        <label style="font-size:10.5px; font-family:var(--font-mono); color:var(--text-muted);">MUSIC STYLE & PROMPT</label>
        <textarea id="music-prompt-input" rows="2" style="background:var(--bg-card); border:1px solid var(--border-subtle); border-radius:6px; padding:6px 8px; font-size:11.5px; color:var(--text-primary); resize:vertical;" placeholder="Futuristic smart warehouse ambient soundscape with rhythmic mechanical pulses and calming synth pads..."></textarea>
      </div>

      <div style="display:flex; gap:8px; align-items:center; justify-content:space-between;">
        <select id="music-model-select" class="log-filter-select">
          <option value="lyria-3-clip-preview">Lyria Clip (Short 30s Audio)</option>
          <option value="lyria-3-pro-preview">Lyria Pro (Full Track)</option>
        </select>
        <button id="btn-generate-music" class="btn-primary">Generate Music</button>
      </div>

      <div id="music-progress-box" style="display:none; background:rgba(168,85,247,0.1); border:1px solid rgba(168,85,247,0.3); border-radius:6px; padding:10px; font-size:11px; color:var(--accent-purple);">
        <div style="display:flex; align-items:center; gap:8px;">
          <span class="pulse-dot" style="background:var(--accent-purple);"></span>
          <span>Synthesizing acoustic waveform with Lyria...</span>
        </div>
      </div>

      <div id="music-result-container" style="display:none; flex-direction:column; gap:8px; background:#060911; border:1px solid var(--border-subtle); border-radius:6px; padding:10px;">
        <audio id="music-result-player" controls style="width:100%;"></audio>
        <div id="music-lyrics-display" style="font-size:10px; color:var(--text-muted); font-family:var(--font-mono); max-height:80px; overflow-y:auto; white-space:pre-wrap;"></div>
      </div>
    </div>
  `;

  // 3. Pane Cloud Ops & Firebase
  const paneCloud = document.createElement("div");
  paneCloud.className = "tab-pane";
  paneCloud.id = "pane-cloud";
  paneCloud.style.display = "none";
  paneCloud.style.flexDirection = "column";
  paneCloud.style.gap = "12px";
  paneCloud.innerHTML = `
    <!-- User Profile & Auth Card -->
    <div class="info-box" style="background:var(--bg-card); border-color:var(--border-bright);">
      <div style="display:flex; justify-content:space-between; align-items:flex-start;">
        <div>
          <h4 style="margin-bottom:2px;">OPERATOR ACCESS CONTROL</h4>
          <p id="cloud-auth-desc">Google Sign-in with Firebase Auth</p>
        </div>
        <div id="db-status-badge" class="badge-live" style="font-size:9px;">
          <span class="pulse-dot"></span> FIRESTORE READY
        </div>
      </div>

      <div id="cloud-auth-profile" style="margin-top:10px;">
        <!-- Injected dynamically by auth listener -->
        <button id="btn-cloud-signin" class="btn-primary" style="width:100%; justify-content:center;">
          <svg style="width:14px; height:14px; fill:currentColor;" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z"/></svg>
          Sign In with Google Account
        </button>
      </div>
    </div>

    <!-- Layout Persistence Section -->
    <div style="background:var(--bg-card); border:1px solid var(--border-subtle); border-radius:8px; padding:12px; display:flex; flex-direction:column; gap:8px;">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <span style="font-size:12px; font-weight:700; color:var(--accent-cyan);">Saved Warehouse Layouts</span>
        <span id="obstacle-count-tag" style="font-size:10px; font-family:var(--font-mono); color:var(--text-muted);">0 Dynamic Obstacles</span>
      </div>
      <p style="font-size:10.5px; color:var(--text-secondary);">Save custom floorplans and obstacle distributions to Firestore to reload them across sessions.</p>

      <div style="display:flex; gap:6px;">
        <input id="save-layout-name" type="text" placeholder="Layout Name (e.g. Peak Shift Obstacles)" style="flex:1; background:#060911; border:1px solid var(--border-subtle); border-radius:4px; padding:5px 8px; font-size:11px; color:#fff;" />
        <button id="btn-save-current-layout" class="btn-primary mini-btn">Save Active</button>
      </div>

      <!-- Saved Layouts List Container -->
      <div id="saved-layouts-list" style="display:flex; flex-direction:column; gap:6px; max-height:160px; overflow-y:auto; margin-top:4px;">
        <div style="font-size:10.5px; color:var(--text-muted); text-align:center; padding:8px;">Sign in to load saved warehouse layouts.</div>
      </div>
    </div>

    <!-- Mission Logs Section -->
    <div style="background:var(--bg-card); border:1px solid var(--border-subtle); border-radius:8px; padding:12px; display:flex; flex-direction:column; gap:8px;">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <span style="font-size:12px; font-weight:700; color:var(--accent-emerald);">Cloud Fleet Mission Logs</span>
        <button id="btn-log-snapshot" class="mini-btn">Log Current Snapshot</button>
      </div>
      <div id="cloud-missions-list" style="display:flex; flex-direction:column; gap:4px; max-height:160px; overflow-y:auto; font-family:var(--font-mono); font-size:10px;">
        <div style="color:var(--text-muted); text-align:center; padding:6px;">Sign in to view recorded cloud mission dispatches.</div>
      </div>
    </div>
  `;

  sidebar.appendChild(paneAi);
  sidebar.appendChild(paneStudio);
  sidebar.appendChild(paneCloud);
}

function setupAuthListeners() {
  auth.onAuthStateChanged((user) => {
    const chip = document.getElementById("hdr-user-chip");
    const cloudAuthProfile = document.getElementById("cloud-auth-profile");
    const cloudAuthDesc = document.getElementById("cloud-auth-desc");

    if (user) {
      if (chip) {
        chip.innerHTML = `
          <div style="display:flex; align-items:center; gap:6px; background:rgba(6,182,212,0.1); border:1px solid rgba(6,182,212,0.3); border-radius:999px; padding:2px 8px;">
            <div style="width:16px; height:16px; border-radius:50%; background:#06b6d4; color:#000; font-weight:700; font-size:9px; display:flex; align-items:center; justify-content:center;">
              ${(user.displayName || user.email || "U").substring(0, 1).toUpperCase()}
            </div>
            <span style="font-size:11px; font-weight:600; color:var(--accent-cyan); max-width:110px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
              ${user.displayName || user.email?.split("@")[0] || "Operator"}
            </span>
          </div>
        `;
      }

      if (cloudAuthDesc) {
        cloudAuthDesc.textContent = `Active Session: ${user.email}`;
      }

      if (cloudAuthProfile) {
        cloudAuthProfile.innerHTML = `
          <div style="display:flex; align-items:center; justify-content:space-between; background:rgba(10,15,29,0.7); border-radius:6px; padding:8px 10px;">
            <div style="display:flex; align-items:center; gap:8px;">
              <div style="width:28px; height:28px; border-radius:50%; background:linear-gradient(135deg, #0ea5e9, #10b981); display:flex; align-items:center; justify-content:center; font-weight:700; font-size:12px; color:#fff;">
                ${(user.displayName || "O").substring(0, 1).toUpperCase()}
              </div>
              <div>
                <div style="font-size:12px; font-weight:700; color:#fff;">${user.displayName || "Operator"}</div>
                <div style="font-size:10px; font-family:var(--font-mono); color:var(--text-muted);">${user.email}</div>
              </div>
            </div>
            <button id="btn-cloud-signout" class="mini-btn btn-danger">Sign Out</button>
          </div>
        `;

        document.getElementById("btn-cloud-signout")?.addEventListener("click", () => {
          logoutUser().catch(console.error);
        });
      }

      refreshCloudData();
    } else {
      if (chip) {
        chip.innerHTML = `
          <button id="btn-hdr-login" class="mini-btn btn-primary">
            <svg style="width:13px; height:13px; fill:currentColor;" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z"/></svg>
            <span>Google Sign-In</span>
          </button>
        `;
        document.getElementById("btn-hdr-login")?.addEventListener("click", () => {
          switchTab("cloud");
          loginWithGoogle().catch((err) => alert(err.message || err));
        });
      }

      if (cloudAuthDesc) {
        cloudAuthDesc.textContent = "Google Sign-in with Firebase Auth";
      }

      if (cloudAuthProfile) {
        cloudAuthProfile.innerHTML = `
          <button id="btn-cloud-signin" class="btn-primary" style="width:100%; justify-content:center;">
            <svg style="width:14px; height:14px; fill:currentColor;" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z"/></svg>
            Sign In with Google Account
          </button>
        `;
        document.getElementById("btn-cloud-signin")?.addEventListener("click", () => {
          loginWithGoogle().catch((err) => alert(err.message || err));
        });
      }

      const layoutsList = document.getElementById("saved-layouts-list");
      if (layoutsList) {
        layoutsList.innerHTML = `<div style="font-size:10.5px; color:var(--text-muted); text-align:center; padding:8px;">Sign in to load saved warehouse layouts.</div>`;
      }
      const missionsList = document.getElementById("cloud-missions-list");
      if (missionsList) {
        missionsList.innerHTML = `<div style="color:var(--text-muted); text-align:center; padding:6px;">Sign in to view recorded cloud mission dispatches.</div>`;
      }
    }
  });
}

function setupCopilotListeners() {
  const btnSend = document.getElementById("btn-ai-send");
  const inputEl = document.getElementById("ai-chat-input") as HTMLInputElement;
  const btnSearch = document.getElementById("btn-ground-search");
  const btnMaps = document.getElementById("btn-ground-maps");
  const btnTelemetry = document.getElementById("btn-toggle-telemetry-context");
  const modelSelect = document.getElementById("ai-model-select") as HTMLSelectElement;
  const btnLiveToggle = document.getElementById("btn-live-toggle");
  const btnMicTranscribe = document.getElementById("btn-mic-transcribe");

  // Grounding toggles (Search and Maps are mutually exclusive or selectable)
  btnSearch?.addEventListener("click", () => {
    btnSearch.classList.toggle("active");
    if (btnSearch.classList.contains("active")) {
      btnMaps?.classList.remove("active");
    }
  });

  btnMaps?.addEventListener("click", () => {
    btnMaps.classList.toggle("active");
    if (btnMaps.classList.contains("active")) {
      btnSearch?.classList.remove("active");
    }
  });

  btnTelemetry?.addEventListener("click", () => {
    btnTelemetry.classList.toggle("active");
  });

  // Quick Prompt Chips
  document.querySelectorAll(".quick-prompt").forEach((chip) => {
    chip.addEventListener("click", () => {
      const p = (chip as HTMLElement).dataset.prompt;
      if (p && inputEl) {
        inputEl.value = p;
        btnSend?.click();
      }
    });
  });

  // Sending Chat Message
  const handleSend = async () => {
    const text = inputEl.value.trim();
    if (!text) return;
    inputEl.value = "";

    // Append user message to UI
    appendChatMessage("user", text);

    const useSearch = btnSearch?.classList.contains("active") || false;
    const useMaps = btnMaps?.classList.contains("active") || false;
    const includeTelemetry = btnTelemetry?.classList.contains("active") || false;

    let telemetryContext = "";
    if (includeTelemetry && window.__AMR_SIM__) {
      telemetryContext = window.__AMR_SIM__.getTelemetrySnapshot();
    }

    // Geolocation for maps grounding
    let userLocation: { latitude: number; longitude: number } | null = null;
    if (useMaps && navigator.geolocation) {
      try {
        const pos: any = await new Promise((res, rej) => {
          navigator.geolocation.getCurrentPosition(res, rej, { timeout: 3000 });
        });
        userLocation = {
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
        };
      } catch (_) {
        // Fallback default warehouse coordinates
        userLocation = { latitude: 37.7749, longitude: -122.4194 };
      }
    }

    const placeholderId = appendLoadingMessage();

    try {
      const response = await sendChatMessage({
        message: text,
        history: chatHistory,
        model: modelSelect.value as any,
        useSearch,
        useMaps,
        userLocation,
        telemetryContext,
      });

      removeLoadingMessage(placeholderId);
      appendChatMessage("model", response.text, response.groundingChunks, response.model);

      // Save to chatHistory
      chatHistory.push({ role: "user", text });
      chatHistory.push({ role: "model", text: response.text, groundingChunks: response.groundingChunks });
    } catch (err: any) {
      removeLoadingMessage(placeholderId);
      appendChatMessage("model", `**Error:** ${err.message || "Failed to reach Copilot engine."}`);
    }
  };

  btnSend?.addEventListener("click", handleSend);
  inputEl?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleSend();
  });

  // Audio Transcription with Microphone (gemini-3.5-transcribe)
  btnMicTranscribe?.addEventListener("click", async () => {
    const statusText = document.getElementById("txt-mic-status");
    if (!isRecordingForTranscription) {
      // Start recording
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaRecorder = new MediaRecorder(stream);
        audioChunks = [];

        mediaRecorder.ondataavailable = (e) => {
          if (e.data.size > 0) audioChunks.push(e.data);
        };

        mediaRecorder.onstop = async () => {
          if (statusText) statusText.textContent = "Transcribing...";
          const audioBlob = new Blob(audioChunks, { type: mediaRecorder?.mimeType || "audio/webm" });
          try {
            const transcription = await transcribeAudioBlob(audioBlob);
            if (inputEl) {
              inputEl.value = transcription;
              inputEl.focus();
            }
          } catch (err: any) {
            alert("Transcription failed: " + (err.message || err));
          } finally {
            if (statusText) statusText.textContent = "Mic";
            btnMicTranscribe.classList.remove("active");
            stream.getTracks().forEach((t) => t.stop());
          }
        };

        mediaRecorder.start();
        isRecordingForTranscription = true;
        btnMicTranscribe.classList.add("active");
        if (statusText) statusText.textContent = "Recording...";
      } catch (err: any) {
        alert("Could not access microphone: " + (err.message || err));
      }
    } else {
      // Stop recording and process
      if (mediaRecorder && mediaRecorder.state !== "inactive") {
        mediaRecorder.stop();
      }
      isRecordingForTranscription = false;
    }
  });

  // Live Voice Radio (gemini-3.8-live)
  btnLiveToggle?.addEventListener("click", toggleLiveVoice);
}

function toggleLiveVoice() {
  const btnLiveToggle = document.getElementById("btn-live-toggle");
  const quickVoiceBtn = document.getElementById("btn-quick-voice");
  const quickVoiceTxt = document.getElementById("txt-quick-voice");
  const liveIndicator = document.getElementById("live-indicator");
  const statusText = document.getElementById("live-status-text");

  if (!liveVoiceClient) {
    liveVoiceClient = new LiveVoiceClient((state) => {
      if (state.active) {
        if (btnLiveToggle) {
          btnLiveToggle.textContent = "End Call";
          btnLiveToggle.classList.add("btn-danger");
        }
        if (quickVoiceBtn) quickVoiceBtn.classList.add("active");
        if (quickVoiceTxt) quickVoiceTxt.textContent = "Radio Active";
        if (liveIndicator) {
          liveIndicator.style.background = "#10b981";
          liveIndicator.style.boxShadow = "0 0 8px #10b981";
        }
        if (statusText) statusText.textContent = "LIVE: Connected to Dispatcher Zephyr";
      } else {
        if (btnLiveToggle) {
          btnLiveToggle.textContent = "Start Radio";
          btnLiveToggle.classList.remove("btn-danger");
        }
        if (quickVoiceBtn) quickVoiceBtn.classList.remove("active");
        if (quickVoiceTxt) quickVoiceTxt.textContent = "Voice Radio";
        if (liveIndicator) {
          liveIndicator.style.background = "#64748b";
          liveIndicator.style.boxShadow = "none";
        }
        if (statusText) statusText.textContent = state.error || "Push-to-talk bidirectional audio stream";
      }
    });

    liveVoiceClient.start().catch((err) => {
      console.error("Live Voice start failed:", err);
      liveVoiceClient = null;
    });
  } else {
    liveVoiceClient.stop();
    liveVoiceClient = null;
  }
}

function appendChatMessage(role: "user" | "model", text: string, groundingChunks?: any[], modelName?: string) {
  const thread = document.getElementById("ai-chat-thread");
  if (!thread) return;

  const msgDiv = document.createElement("div");
  msgDiv.style.display = "flex";
  msgDiv.style.flexDirection = "column";
  msgDiv.style.gap = "4px";
  msgDiv.style.borderRadius = "6px";
  msgDiv.style.padding = "8px 10px";
  msgDiv.style.fontSize = "11.5px";
  msgDiv.style.lineHeight = "1.5";

  if (role === "user") {
    msgDiv.style.alignSelf = "flex-end";
    msgDiv.style.background = "rgba(6, 182, 212, 0.15)";
    msgDiv.style.border = "1px solid rgba(6, 182, 212, 0.35)";
    msgDiv.style.maxWidth = "88%";
    msgDiv.innerHTML = `
      <div style="display:flex; justify-content:space-between; gap:8px; font-size:9.5px; font-family:var(--font-mono); color:var(--accent-cyan);">
        <span>OPERATOR</span>
        <span>${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
      </div>
      <div style="color:#fff;">${escapeHtml(text)}</div>
    `;
  } else {
    msgDiv.style.alignSelf = "flex-start";
    msgDiv.style.background = "rgba(15, 23, 42, 0.9)";
    msgDiv.style.border = "1px solid var(--border-bright)";
    msgDiv.style.maxWidth = "96%";

    let renderedMarkdown = "";
    try {
      renderedMarkdown = marked.parse(text) as string;
    } catch (_) {
      renderedMarkdown = escapeHtml(text);
    }

    let citationsHtml = "";
    if (Array.isArray(groundingChunks) && groundingChunks.length > 0) {
      const links: string[] = [];
      groundingChunks.forEach((chunk: any) => {
        if (chunk.web?.uri) {
          links.push(`<a href="${chunk.web.uri}" target="_blank" rel="noopener noreferrer" style="color:var(--accent-cyan); text-decoration:underline;">${chunk.web.title || chunk.web.uri}</a>`);
        }
        if (chunk.maps?.uri) {
          links.push(`<a href="${chunk.maps.uri}" target="_blank" rel="noopener noreferrer" style="color:var(--accent-emerald); text-decoration:underline;">📍 ${chunk.maps.title || "Maps Location"}</a>`);
        }
      });

      if (links.length > 0) {
        citationsHtml = `
          <div style="margin-top:8px; padding-top:6px; border-top:1px dashed var(--border-subtle); font-size:10px; font-family:var(--font-mono);">
            <span style="color:var(--text-muted); display:block; margin-bottom:2px;">GROUNDING SOURCES:</span>
            <div style="display:flex; flex-direction:column; gap:2px;">${links.join("")}</div>
          </div>
        `;
      }
    }

    msgDiv.innerHTML = `
      <div style="display:flex; justify-content:space-between; gap:8px; font-size:9.5px; font-family:var(--font-mono); color:var(--text-muted);">
        <span style="color:var(--accent-cyan); font-weight:700;">AMR COPILOT (${modelName || "gemini-3.5-flash"})</span>
        <span>${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
      </div>
      <div class="chat-content" style="color:var(--text-primary);">${renderedMarkdown}</div>
      ${citationsHtml}
    `;
  }

  thread.appendChild(msgDiv);
  thread.scrollTop = thread.scrollHeight;
}

function appendLoadingMessage(): string {
  const thread = document.getElementById("ai-chat-thread");
  if (!thread) return "";
  const id = "load_" + Date.now();
  const loader = document.createElement("div");
  loader.id = id;
  loader.style.alignSelf = "flex-start";
  loader.style.background = "rgba(15, 23, 42, 0.7)";
  loader.style.border = "1px solid var(--border-subtle)";
  loader.style.borderRadius = "6px";
  loader.style.padding = "6px 10px";
  loader.style.fontSize = "11px";
  loader.style.color = "var(--accent-cyan)";
  loader.style.display = "flex";
  loader.style.alignItems = "center";
  loader.style.gap = "6px";
  loader.innerHTML = `<span class="pulse-dot"></span> Copilot analyzing warehouse telemetry & grounding...`;
  thread.appendChild(loader);
  thread.scrollTop = thread.scrollHeight;
  return id;
}

function removeLoadingMessage(id: string) {
  if (!id) return;
  const el = document.getElementById(id);
  if (el) el.remove();
}

function setupStudioListeners() {
  // Sub-tabs in Media Studio
  const subtabs = document.querySelectorAll(".studio-subtab");
  subtabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      subtabs.forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      const targetSub = (tab as HTMLElement).dataset.sub;
      document.querySelectorAll(".studio-section").forEach((sec) => {
        (sec as HTMLElement).style.display = "none";
      });
      const targetSec = document.getElementById(`sub-${targetSub}`);
      if (targetSec) targetSec.style.display = "flex";
    });
  });

  // 1. Image Generation (gemini-3.1-flash-image)
  const btnGenImg = document.getElementById("btn-generate-img");
  const imgPromptInput = document.getElementById("img-prompt-input") as HTMLTextAreaElement;
  const imgAspectSelect = document.getElementById("img-aspect-ratio") as HTMLSelectElement;
  const imgUploadFile = document.getElementById("img-upload-file") as HTMLInputElement;
  const btnEditImg = document.getElementById("btn-edit-img");

  let uploadedBase64: string | null = null;
  let uploadedMime: string = "image/png";

  imgUploadFile?.addEventListener("change", () => {
    const file = imgUploadFile.files?.[0];
    if (file) {
      uploadedMime = file.type || "image/png";
      const reader = new FileReader();
      reader.onload = (e) => {
        uploadedBase64 = e.target?.result as string;
        if (btnEditImg) btnEditImg.style.display = "inline-flex";
      };
      reader.readAsDataURL(file);
    }
  });

  btnGenImg?.addEventListener("click", async () => {
    const prompt = imgPromptInput.value.trim();
    if (!prompt) {
      alert("Please enter an image prompt.");
      return;
    }

    btnGenImg.textContent = "Generating...";
    (btnGenImg as HTMLButtonElement).disabled = true;

    try {
      const result = await generateWarehouseImage(prompt, imgAspectSelect.value);
      showImageResult(result.imageUrl, result.caption);
    } catch (err: any) {
      alert("Image generation failed: " + (err.message || err));
    } finally {
      btnGenImg.textContent = "Generate Image";
      (btnGenImg as HTMLButtonElement).disabled = false;
    }
  });

  btnEditImg?.addEventListener("click", async () => {
    const prompt = imgPromptInput.value.trim();
    if (!prompt || !uploadedBase64) {
      alert("Please provide an edit instruction prompt and select an image.");
      return;
    }

    btnEditImg.textContent = "Editing Image...";
    (btnEditImg as HTMLButtonElement).disabled = true;

    try {
      const result = await editWarehouseImage(prompt, uploadedBase64, uploadedMime);
      showImageResult(result.imageUrl, result.caption);
    } catch (err: any) {
      alert("Image edit failed: " + (err.message || err));
    } finally {
      btnEditImg.textContent = "Apply Edit Prompt to Uploaded Photo";
      (btnEditImg as HTMLButtonElement).disabled = false;
    }
  });

  function showImageResult(url: string, caption?: string) {
    const container = document.getElementById("img-result-container");
    const imgEl = document.getElementById("img-result-display") as HTMLImageElement;
    const captionEl = document.getElementById("img-caption");
    const downloadLink = document.getElementById("img-download-link") as HTMLAnchorElement;

    if (container && imgEl) {
      container.style.display = "flex";
      imgEl.src = url;
      if (captionEl) captionEl.textContent = caption || "";
      if (downloadLink) downloadLink.href = url;
    }
  }

  // 2. Veo 3 Video Generation (veo-3.1-fast-generate-preview)
  const btnGenVideo = document.getElementById("btn-generate-video");
  const videoPromptInput = document.getElementById("video-prompt-input") as HTMLTextAreaElement;
  const videoAspectSelect = document.getElementById("video-aspect-ratio") as HTMLSelectElement;
  const videoImageFile = document.getElementById("video-image-file") as HTMLInputElement;
  const videoProgressBox = document.getElementById("video-progress-box");
  const videoProgressText = document.getElementById("video-progress-text");
  const videoResultContainer = document.getElementById("video-result-container");
  const videoResultPlayer = document.getElementById("video-result-player") as HTMLVideoElement;
  const videoDownloadBtn = document.getElementById("video-download-btn") as HTMLAnchorElement;

  btnGenVideo?.addEventListener("click", async () => {
    const prompt = videoPromptInput.value.trim();
    let startingImageBase64: string | null = null;
    let mimeType = "image/png";

    const file = videoImageFile.files?.[0];
    if (file) {
      mimeType = file.type || "image/png";
      startingImageBase64 = await new Promise((res) => {
        const reader = new FileReader();
        reader.onload = () => res(reader.result as string);
        reader.readAsDataURL(file);
      });
    }

    if (!prompt && !startingImageBase64) {
      alert("Please enter a video prompt or choose an image to animate.");
      return;
    }

    (btnGenVideo as HTMLButtonElement).disabled = true;
    if (videoProgressBox) videoProgressBox.style.display = "block";
    if (videoResultContainer) videoResultContainer.style.display = "none";

    try {
      const videoUrl = await generateVeoVideo({
        prompt,
        startingImageBase64,
        mimeType,
        aspectRatio: videoAspectSelect.value as any,
        onProgress: (status) => {
          if (videoProgressText) videoProgressText.textContent = status;
        },
      });

      if (videoResultContainer && videoResultPlayer) {
        videoResultContainer.style.display = "flex";
        videoResultPlayer.src = videoUrl;
        if (videoDownloadBtn) videoDownloadBtn.href = videoUrl;
      }
    } catch (err: any) {
      alert("Veo Video generation failed: " + (err.message || err));
    } finally {
      (btnGenVideo as HTMLButtonElement).disabled = false;
      if (videoProgressBox) videoProgressBox.style.display = "none";
    }
  });

  // 3. Lyria Music (lyria-3-clip-preview & lyria-3-pro-preview)
  const btnGenMusic = document.getElementById("btn-generate-music");
  const musicPromptInput = document.getElementById("music-prompt-input") as HTMLTextAreaElement;
  const musicModelSelect = document.getElementById("music-model-select") as HTMLSelectElement;
  const musicProgressBox = document.getElementById("music-progress-box");
  const musicResultContainer = document.getElementById("music-result-container");
  const musicResultPlayer = document.getElementById("music-result-player") as HTMLAudioElement;
  const musicLyricsDisplay = document.getElementById("music-lyrics-display");

  btnGenMusic?.addEventListener("click", async () => {
    const prompt = musicPromptInput.value.trim();
    if (!prompt) {
      alert("Please enter a music style prompt.");
      return;
    }

    (btnGenMusic as HTMLButtonElement).disabled = true;
    if (musicProgressBox) musicProgressBox.style.display = "block";
    if (musicResultContainer) musicResultContainer.style.display = "none";

    try {
      const result = await generateLyriaMusic(prompt, musicModelSelect.value as any);
      if (musicResultContainer && musicResultPlayer) {
        musicResultContainer.style.display = "flex";
        musicResultPlayer.src = result.audioUrl;
        if (musicLyricsDisplay) {
          musicLyricsDisplay.textContent = result.lyrics ? `Generated Lyrics / Structure:\n${result.lyrics}` : "Acoustic audio track generated.";
        }
      }
    } catch (err: any) {
      alert("Lyria Music generation failed: " + (err.message || err));
    } finally {
      (btnGenMusic as HTMLButtonElement).disabled = false;
      if (musicProgressBox) musicProgressBox.style.display = "none";
    }
  });
}

function setupCloudListeners() {
  const btnSaveLayout = document.getElementById("btn-save-current-layout");
  const inputLayoutName = document.getElementById("save-layout-name") as HTMLInputElement;
  const btnLogSnapshot = document.getElementById("btn-log-snapshot");

  btnSaveLayout?.addEventListener("click", async () => {
    if (!auth.currentUser) {
      alert("Please sign in with Google to save layouts to Firestore.");
      return;
    }

    const name = inputLayoutName.value.trim() || "Warehouse Layout " + new Date().toLocaleTimeString();
    const obstacles = window.__AMR_SIM__ ? window.__AMR_SIM__.getObstacleList() : [];

    btnSaveLayout.textContent = "Saving...";
    (btnSaveLayout as HTMLButtonElement).disabled = true;

    try {
      await saveWarehouseLayout(name, obstacles, `Captured with ${obstacles.length} active obstacles`);
      inputLayoutName.value = "";
      alert(`Layout "${name}" saved to Firestore!`);
      refreshCloudData();
    } catch (err: any) {
      alert("Save failed: " + (err.message || err));
    } finally {
      btnSaveLayout.textContent = "Save Active";
      (btnSaveLayout as HTMLButtonElement).disabled = false;
    }
  });

  btnLogSnapshot?.addEventListener("click", async () => {
    if (!auth.currentUser) {
      alert("Please sign in with Google to log telemetry to Firestore.");
      return;
    }

    if (!window.__AMR_SIM__) return;

    btnLogSnapshot.textContent = "Logging...";
    (btnLogSnapshot as HTMLButtonElement).disabled = true;

    try {
      const fleet = window.__AMR_SIM__.fleet || [];
      for (const amr of fleet) {
        await logFleetMission(
          amr.id,
          amr.carryingPayload ? "payload_delivery" : "route_transit",
          "Warehouse Bay",
          amr.currentTargetStation?.name || "Dock",
          amr.state === "NAVIGATING" ? "in_transit" : "dispatched"
        );
      }
      alert("Fleet telemetry snapshot logged to Firestore!");
      refreshCloudData();
    } catch (err: any) {
      alert("Snapshot log failed: " + (err.message || err));
    } finally {
      btnLogSnapshot.textContent = "Log Current Snapshot";
      (btnLogSnapshot as HTMLButtonElement).disabled = false;
    }
  });
}

async function refreshCloudData() {
  const user = auth.currentUser;
  if (!user) return;

  // 1. Refresh obstacle count
  const obstacleCountTag = document.getElementById("obstacle-count-tag");
  if (obstacleCountTag && window.__AMR_SIM__) {
    const list = window.__AMR_SIM__.getObstacleList();
    obstacleCountTag.textContent = `${list.length} Dynamic Obstacles`;
  }

  // 2. Fetch Saved Layouts from Firestore
  const layoutsList = document.getElementById("saved-layouts-list");
  if (layoutsList) {
    layoutsList.innerHTML = `<div style="font-size:10px; color:var(--accent-cyan); text-align:center; padding:6px;"><span class="pulse-dot"></span> Loading layouts from Firestore...</div>`;
    try {
      const layouts = await getSavedLayouts();
      if (layouts.length === 0) {
        layoutsList.innerHTML = `<div style="font-size:10.5px; color:var(--text-muted); text-align:center; padding:6px;">No saved layouts yet. Place obstacles and click 'Save Active'!</div>`;
      } else {
        layoutsList.innerHTML = "";
        layouts.forEach((layout) => {
          const item = document.createElement("div");
          item.style.display = "flex";
          item.style.alignItems = "center";
          item.style.justifyContent = "space-between";
          item.style.background = "#060911";
          item.style.border = "1px solid var(--border-subtle)";
          item.style.borderRadius = "4px";
          item.style.padding = "6px 8px";

          item.innerHTML = `
            <div>
              <div style="font-size:11px; font-weight:600; color:var(--text-primary);">${escapeHtml(layout.name)}</div>
              <div style="font-size:9px; font-family:var(--font-mono); color:var(--text-muted);">
                ${layout.obstacles?.length || 0} obstacles • ${new Date(layout.createdAt).toLocaleDateString()}
              </div>
            </div>
            <div style="display:flex; gap:4px;">
              <button class="mini-btn btn-primary btn-restore-layout" data-id="${layout.id}">Load</button>
              <button class="mini-btn btn-danger btn-delete-layout" data-id="${layout.id}">✕</button>
            </div>
          `;

          item.querySelector(".btn-restore-layout")?.addEventListener("click", () => {
            if (window.__AMR_SIM__) {
              window.__AMR_SIM__.setObstacleList(layout.obstacles || []);
              window.__AMR_SIM__.addTelemetry("OBSTACLE", `Loaded saved layout: "${layout.name}" (${layout.obstacles?.length || 0} obstacles)`);
              alert(`Layout "${layout.name}" applied to warehouse floor!`);
            }
          });

          item.querySelector(".btn-delete-layout")?.addEventListener("click", async () => {
            if (confirm(`Delete saved layout "${layout.name}"?`)) {
              await deleteWarehouseLayout(layout.id);
              refreshCloudData();
            }
          });

          layoutsList.appendChild(item);
        });
      }
    } catch (err: any) {
      layoutsList.innerHTML = `<div style="font-size:10px; color:var(--accent-red); padding:4px;">Error loading layouts: ${err.message}</div>`;
    }
  }

  // 3. Fetch Recent Missions from Firestore
  const missionsList = document.getElementById("cloud-missions-list");
  if (missionsList) {
    try {
      const missions = await getRecentFleetMissions();
      if (missions.length === 0) {
        missionsList.innerHTML = `<div style="color:var(--text-muted); text-align:center; padding:6px;">No recorded missions yet in cloud.</div>`;
      } else {
        missionsList.innerHTML = "";
        missions.forEach((m) => {
          const row = document.createElement("div");
          row.style.display = "flex";
          row.style.justifyContent = "space-between";
          row.style.borderBottom = "1px solid rgba(255,255,255,0.04)";
          row.style.padding = "3px 0";

          row.innerHTML = `
            <span style="color:var(--accent-cyan);">${escapeHtml(m.amrId)}</span>
            <span style="color:var(--text-secondary);">${escapeHtml(m.taskType)} &rarr; ${escapeHtml(m.destNode || "Dock")}</span>
            <span style="color:var(--accent-emerald); text-transform:uppercase;">${escapeHtml(m.status)}</span>
          `;
          missionsList.appendChild(row);
        });
      }
    } catch (err: any) {
      missionsList.innerHTML = `<div style="color:var(--accent-red);">Error: ${err.message}</div>`;
    }
  }
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}
