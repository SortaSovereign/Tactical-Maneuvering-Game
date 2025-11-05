import Phaser from "phaser";
import { io, Socket } from "socket.io-client";

type Role = "guide" | "player" | "npc";
type PlayerWire = {
  id: string; callsign: string; role: Role;
  x: number; y: number; courseDeg: number; speedKts: number; headingDeg: number;
  lastUpdateMs: number;
};
type SessionWire = {
  id: string; name: string; rangeYds: number; createdAt: number;
  ownerId: string; paused: boolean; started: boolean;
};
type SnapshotMsg = { serverTimeMs: number; session: SessionWire; players: PlayerWire[] };
type ScenarioUpdate = { queue: Array<any>; active: PlayerWire[] };

const toDeg = (r: number) => (r * 180 / Math.PI + 360) % 360;
function bearingTrue(a:{x:number,y:number}, b:{x:number,y:number}) { return toDeg(Math.atan2(b.x-a.x, b.y-a.y)); }
function rangeY(a:{x:number,y:number}, b:{x:number,y:number}) { return Math.hypot(b.x-a.x, b.y-a.y); }
function bearingRelative(bt:number, myC:number){ return (bt - myC + 360) % 360; }
function angDiff(a:number,b:number){ let d=(a-b+540)%360-180; return d; }
function setText(el: HTMLElement, val: unknown) { el.textContent = String(val ?? ""); }
function normalizeCallsign(v: string) { return (v || "").toUpperCase().replace(/[^A-Z0-9\-]/g, "").slice(0, 12); }
function show(el: HTMLElement | null, on: boolean, display: string = "block") { if (el) el.style.display = on ? display : "none"; }
function byId<T extends HTMLElement = HTMLElement>(id: string) { return document.getElementById(id) as T | null; }
function pad3(n:number){ return String(Math.round(n)%360).padStart(3,"0"); }
function cryptoRand(){ return Math.random().toString(36).slice(2,9); }

let socket: Socket | null = null;
let lastSnapshot: SnapshotMsg | null = null;

/** Non-null snapshot accessor for nested callbacks. Throws if accessed too early. */
function SNAP(): SnapshotMsg {
  if (!lastSnapshot) throw new Error("Snapshot not available yet");
  return lastSnapshot;
}

let myId: string | undefined = undefined;
let pendingJoin = false;

const labelById = new Map<string, Phaser.GameObjects.Text>();

// --- Persistent staging buffers (players & NPCs) ---
type StagedPlayer = { bearingDeg: number; distanceYds: number; courseDeg: number; speedKts: number };
const stagedPlayers = new Map<string, StagedPlayer>(); // key = player.id (excluding owner)
type StNpcRow = { id: string; callsign: string; bearingDeg: number; distanceYds: number; courseDeg: number; speedKts: number };
const uiNpcRows: StNpcRow[] = [];

// Track last known player IDs for minimal churn
let lastPlayerIdsKey = "";

// Render guard: only re-render staging when needed
let needsStagingRender = true;
function isEditingStaging(scene: RadarScene) {
  const a = document.activeElement as HTMLElement | null;
  if (!a) return false;
  const inPlayers = !!scene.stagingPlayers && scene.stagingPlayers.contains(a);
  const inNpcs    = !!scene.stagingNpcs    && scene.stagingNpcs.contains(a);
  return (a.tagName === "INPUT") && (inPlayers || inNpcs);
}

// --- Prevent guide “jump”: queue My Nav during staging and flush on Start
let prevStarted: boolean | null = null;
let pendingNav: { courseDeg?: number; speedKts?: number } | null = null;

class RadarScene extends Phaser.Scene {
  cx = 0; cy = 0; r = 0;

  scopeG!: Phaser.GameObjects.Graphics;
  contactsG!: Phaser.GameObjects.Graphics;
  sweepG!: Phaser.GameObjects.Graphics;

  // Tabs
  tabNavBtn!: HTMLElement; tabContactsBtn!: HTMLElement;
  tabNavPanel!: HTMLElement; tabContactsPanel!: HTMLElement;

  // Cards
  mainCard!: HTMLElement;
  stagingCard!: HTMLElement;

  // UI
  contactsDiv!: HTMLElement;
  uiRoot!: HTMLElement;
  rightDock!: HTMLElement;
  waitingOverlay!: HTMLElement;
  sessionBadge!: HTMLElement; badgeSessionId!: HTMLElement;

  // Guide
  guidePanel!: HTMLElement;
  guideRange!: HTMLInputElement; guideRangeBtn!: HTMLButtonElement; guidePauseBtn!: HTMLButtonElement; guideStatus!: HTMLElement;

  // Staging
  stagingPlayers!: HTMLElement;
  stagingNpcs!: HTMLElement;
  addNpcRow!: HTMLElement;
  applyStagingBtn!: HTMLButtonElement; applyStatus!: HTMLElement;
  startBtn!: HTMLButtonElement;

  // Live NPC controls
  npcLiveBlock!: HTMLElement;
  npcLiveList!: HTMLElement;

  // Pre-join & nav
  serverUrl!: HTMLInputElement; sessName!: HTMLInputElement; sessRange!: HTMLInputElement;
  createBtn!: HTMLButtonElement; createStatus!: HTMLElement;
  sessionIdInput!: HTMLInputElement; callsignInput!: HTMLInputElement;
  joinBtn!: HTMLButtonElement; joinStatus!: HTMLElement;
  course!: HTMLInputElement; speed!: HTMLInputElement; setNavBtn!: HTMLButtonElement;

  // Sweep
  sweepDeg = 0; cadenceAvgMs = 2500; lastServerTickMs = 0;

  create() {
    this.cameras.main.setBackgroundColor(0x0a2a16);
    this.cacheUi();

    // default server URL
    if (!this.serverUrl.value) {
      const envDefault = (import.meta as any).env?.VITE_DEFAULT_SERVER_URL as string | undefined;
      this.serverUrl.value = envDefault || "http://localhost:3001";
    }

    const connectIfNeeded = () => {
      if (socket) return;
      (() => {
    const raw = this.serverUrl.value.trim();
    const PROD = typeof import.meta !== "undefined" && (import.meta as any).env?.PROD;
    const envURL = (typeof import.meta !== "undefined" && (import.meta as any).env?.VITE_SERVER_URL) as string | undefined;
    const url = PROD ? (envURL || raw) : (envURL || raw);

  // This must match your server's Socket.IO config
    const path = (typeof import.meta !== "undefined" && (import.meta as any).env?.VITE_SOCKET_PATH) || "/socket.io";

    console.log("[socket] target", url, "path", path, "prod?", PROD);

    socket = io(url, {
      path,                     // << important: must be "/socket.io"
       transports: ["websocket"], // << avoid polling on itch
       withCredentials: false,
       forceNew: true,
       timeout: 15000
      });

  socket.on("connect", () => {
    console.log("[socket] connected", socket!.id);
    setText(this.joinStatus, `Connected: ${socket!.id}`);
    this.tryClaimOwner();
  });

  socket.on("connect_error", (err: any) => {
    console.error("[socket] connect_error", err?.message || err);
    setText(this.joinStatus, `Connect error: ${String(err?.message || err)}`);
  });
})();

      socket.on("connect", () => {
        setText(this.joinStatus, `Connected: ${socket!.id}`);
        this.tryClaimOwner();
      });
      socket.on("disconnect", (reason) => setText(this.joinStatus, `Disconnected: ${String(reason)}`));
      socket.on("connect_error", (err) => setText(this.joinStatus, `connect_error: ${("message" in (err as any)) ? (err as any).message : String(err)}`));

      socket.on("state:snapshot", (snap: SnapshotMsg) => {
        if (this.lastServerTickMs) {
          const dt = snap.serverTimeMs - this.lastServerTickMs;
          if (dt > 300 && dt < 20000) this.cadenceAvgMs = this.cadenceAvgMs*0.7 + dt*0.3;
        }
        this.lastServerTickMs = snap.serverTimeMs;
        lastSnapshot = snap;

        // Flush queued nav once scenario starts
        const startedNow = snap.session.started === true;
        if (prevStarted === false && startedNow && pendingNav && socket) {
          socket.emit("player:setNav", pendingNav);
          pendingNav = null;
        }
        prevStarted = startedNow;

        // show main card after join
        show(this.mainCard, true, "block");

        this.updateGuideUi();
        this.updateSessionBadge();
        this.updateWaitingOverlay();

        // Only seed when membership changed
        const changed = this.seedStagedPlayersFromSnapshot();
        if (changed) needsStagingRender = true;

        // Render staging only if flagged and not typing
        if (needsStagingRender && !isEditingStaging(this)) {
          this.renderStagingPlayers();
          this.renderStagingNpcs();
          needsStagingRender = false;
        }

        // Live NPC list can always refresh
        this.renderNpcLiveControls();

        this.drawContacts();
        this.renderContactsPanel();
      });

      socket.on("player:left", () => {
        if (lastSnapshot) {
          const changed = this.seedStagedPlayersFromSnapshot();
          if (changed) needsStagingRender = true;
          if (needsStagingRender && !isEditingStaging(this)) {
            this.renderStagingPlayers();
            needsStagingRender = false;
          }
          this.drawContacts();
          this.renderContactsPanel();
        }
      });

      socket.on("scenario:update", (_data: ScenarioUpdate) => {
        this.renderNpcLiveControls();
      });
    };

    // Tabs
    this.tabNavBtn.addEventListener("click", () => this.setTab(true));
    this.tabContactsBtn.addEventListener("click", () => this.setTab(false));

    // Create
    this.createBtn.addEventListener("click", () => {
      connectIfNeeded();
      socket!.emit("session:create",
        { name: this.sessName.value || "Session", rangeYds: Number(this.sessRange.value) || 40000 },
        (resp: any) => {
          if (resp?.ok) {
            const sid = String(resp.sessionId ?? "");
            const tok = String(resp.ownerToken ?? "");
            sessionStorage.setItem("rr_ownerToken", tok);
            this.sessionIdInput.value = sid;
            setText(this.createStatus, `Created session: ${sid}`);

            localStorage.removeItem("rr_sessionId");
            localStorage.removeItem("rr_callsign");

            const csInput = (this.callsignInput.value || "GUIDE").trim() || "GUIDE";
            const cs = normalizeCallsign(csInput);
            this.joinBtn.disabled = true;
            this.joinSession(sid, cs);
            setTimeout(() => { this.joinBtn.disabled = false; }, 1500);

            localStorage.setItem("rr_sessionId", sid);
            localStorage.setItem("rr_callsign", cs);
          } else {
            setText(this.createStatus, "Create failed");
          }
        });
    });

    // Join
    this.joinBtn.addEventListener("click", () => {
      connectIfNeeded();
      const sessionId = this.sessionIdInput.value.trim();
      let cs = (this.callsignInput.value || "").trim();
      if (!sessionId) { setText(this.joinStatus, "Enter session code."); return; }
      if (!cs) cs = `SHIP-${Math.random().toString(36).slice(2,6).toUpperCase()}`;
      this.joinSession(sessionId, cs);
    });

    // My Nav — queue during staging; live-apply after start
    this.setNavBtn.addEventListener("click", () => {
      const c = Number(this.course.value);
      const s = Number(this.speed.value);
      if (!lastSnapshot) return;

      if (!SNAP().session.started) {
        pendingNav = {
          courseDeg: isFinite(c) ? c : undefined,
          speedKts:  isFinite(s) ? s : undefined
        };
        setText(this.guideStatus, "Nav queued — will apply on Start.");
        return;
      }

      if (socket) {
        socket.emit("player:setNav", {
          courseDeg: isFinite(c) ? c : undefined,
          speedKts:  isFinite(s) ? s : undefined
        });
      }
    });

    // Guide: range/pause
    this.guideRangeBtn.addEventListener("click", () => {
      if (!socket || !lastSnapshot) return;
      const sid = SNAP().session.id;
      const nextRange = Number(this.guideRange.value) || SNAP().session.rangeYds;
      socket.emit("session:setRange", { sessionId: sid, rangeYds: nextRange }, (resp: any) => {
        if (!resp?.ok) setText(this.guideStatus, `Range set failed: ${String(resp?.error ?? "")}`);
      });
    });
    this.guidePauseBtn.addEventListener("click", () => {
      if (!socket || !lastSnapshot) return;
      const sid = SNAP().session.id;
      const next = !SNAP().session.paused;
      socket.emit("session:pause", { sessionId: sid, paused: next }, (resp: any) => {
        if (!resp?.ok) setText(this.guideStatus, `Pause failed: ${String(resp?.error ?? "")}`);
      });
    });

    // Staging: add row, apply, start
    this.addNpcRow.addEventListener("click", () => {
      uiNpcRows.push({ id: cryptoRand(), callsign: "SKUNK", bearingDeg: 0, distanceYds: 0, courseDeg: 90, speedKts: 15 });
      needsStagingRender = true;
      if (!isEditingStaging(this)) { this.renderStagingNpcs(); needsStagingRender = false; }
    });

    this.applyStagingBtn.addEventListener("click", () => {
      this.clearDirtyFlags(this.stagingPlayers);
      this.clearDirtyFlags(this.stagingNpcs);
      needsStagingRender = true;
      if (!isEditingStaging(this)) { this.renderStagingPlayers(); this.renderStagingNpcs(); needsStagingRender = false; }
      setText(this.applyStatus, "Staging saved.");
      setTimeout(() => setText(this.applyStatus, ""), 1200);
    });

    this.startBtn.addEventListener("click", () => {
      if (!socket || !lastSnapshot) return;
      const sid = SNAP().session.id;

      // Build placements from buffered stagedPlayers (exclude owner)
      const placements: Array<{playerId:string; bearingDeg:number; distanceYds:number; courseDeg?:number; speedKts?:number}> = [];
      const ownerId = SNAP().session.ownerId;
      for (const p of SNAP().players) {
        if (p.id === ownerId || p.role === "npc") continue;
        const st = stagedPlayers.get(p.id);
        if (!st) continue;
        placements.push({
          playerId: p.id,
          bearingDeg: st.bearingDeg,
          distanceYds: st.distanceYds,
          courseDeg: st.courseDeg,
          speedKts: st.speedKts
        });
      }

      // NPCs from buffer
      const npcs = uiNpcRows.map(n => ({
        callsign: n.callsign,
        bearingDeg: n.bearingDeg,
        distanceYds: n.distanceYds,
        courseDeg: n.courseDeg,
        speedKts: n.speedKts
      }));

      socket.emit("session:start", { sessionId: sid, placements, npcs }, (resp: any) => {
        if (!resp?.ok) setText(this.guideStatus, `Start failed: ${String(resp?.error ?? "")}`);
      });
    });

    // layers
    this.scopeG = this.add.graphics().setDepth(0);
    this.contactsG = this.add.graphics().setDepth(2);
    this.sweepG = this.add.graphics().setDepth(3).setBlendMode(Phaser.BlendModes.ADD);

    this.scale.on("resize", () => this.resize());
    this.resize();
  }

  cacheUi() {
    this.uiRoot = byId("ui")!;
    this.rightDock = byId("rightDock")!;
    this.mainCard = byId("mainCard")!;
    this.stagingCard = byId("stagingCard")!;

    this.contactsDiv = byId("contacts")!;
    this.waitingOverlay = byId("waitingOverlay")!;
    this.sessionBadge = byId("sessionBadge")!;
    this.badgeSessionId = byId("badgeSessionId")!;

    // Tabs
    this.tabNavBtn = byId("tabNav")!;
    this.tabContactsBtn = byId("tabContacts")!;
    this.tabNavPanel = byId("tabNavPanel")!;
    this.tabContactsPanel = byId("tabContactsPanel")!;

    // Connect/Create/Join
    this.serverUrl = byId<HTMLInputElement>("serverUrl")!;
    this.sessName  = byId<HTMLInputElement>("sessName")!;
    this.sessRange = byId<HTMLInputElement>("sessRange")!;
    this.createBtn = byId<HTMLButtonElement>("createBtn")!;
    this.createStatus = byId("createStatus")!;
    this.sessionIdInput = byId<HTMLInputElement>("sessionId")!;
    this.callsignInput  = byId<HTMLInputElement>("callsign")!;
    this.joinBtn = byId<HTMLButtonElement>("joinBtn")!;
    this.joinStatus = byId("joinStatus")!;

    // My Nav
    this.course = byId<HTMLInputElement>("course")!;
    this.speed  = byId<HTMLInputElement>("speed")!;
    this.setNavBtn = byId<HTMLButtonElement>("setNavBtn")!;

    // Guide
    this.guidePanel = byId("guideControls")!;
    this.guideRange = byId<HTMLInputElement>("guideRange")!;
    this.guideRangeBtn = byId<HTMLButtonElement>("guideRangeBtn")!;
    this.guidePauseBtn = byId<HTMLButtonElement>("guidePauseBtn")!;
    this.guideStatus = byId("guideStatus")!;

    // Staging
    this.stagingPlayers = byId("stagingPlayers")!;
    this.stagingNpcs = byId("stagingNpcs")!;
    this.addNpcRow = byId("addNpcRow")!;
    this.applyStagingBtn = byId<HTMLButtonElement>("applyStagingBtn")!;
    this.applyStatus = byId("applyStatus")!;
    this.startBtn = byId<HTMLButtonElement>("startBtn")!;

    // Live NPC control
    this.npcLiveBlock = byId("npcLiveBlock")!;
    this.npcLiveList = byId("npcLiveList")!;
  }

  tryClaimOwner() {
    const token = sessionStorage.getItem("rr_ownerToken");
    const sid = (lastSnapshot?.session.id ?? this.sessionIdInput.value.trim());
    if (!socket || !token || !sid) return;
    socket.emit("session:claimOwner", { sessionId: sid, ownerToken: token }, () => {});
  }

  // Tabs
  setTab(navActive: boolean) {
    if (navActive) {
      this.tabNavBtn.classList.add("active");
      this.tabContactsBtn.classList.remove("active");
      show(this.tabNavPanel, true);
      show(this.tabContactsPanel, false);
    } else {
      this.tabContactsBtn.classList.add("active");
      this.tabNavBtn.classList.remove("active");
      show(this.tabContactsPanel, true);
      show(this.tabNavPanel, false);
    }
  }

  // Join
  joinSession(sessionId: string, callsign: string) {
    if (!socket || pendingJoin) return;
    const cs = normalizeCallsign(callsign);
    const safeCs = cs || `SHIP-${Math.random().toString(36).slice(2,6).toUpperCase()}`;

    pendingJoin = true;
    socket.emit("session:join", { sessionId, callsign: safeCs }, (resp: any) => {
      pendingJoin = false;

      if (resp?.ok) {
        lastSnapshot = resp.snapshot as SnapshotMsg;
        myId = String(resp.myPlayerId || "")
        // bring up the dock/cards
        show(this.mainCard, true, "block");

        // hide pre-join
        if (this.uiRoot) this.uiRoot.style.display = "none";

        this.sessRange.value = String(SNAP().session.rangeYds);
        this.updateGuideUi();
        this.updateSessionBadge();
        this.updateWaitingOverlay();

        // seed buffers for staging
        this.seedStagedPlayersFromSnapshot();
        needsStagingRender = true; // first render
        if (!isEditingStaging(this)) { this.renderStagingPlayers(); this.renderStagingNpcs(); needsStagingRender = false; }
        this.renderNpcLiveControls();

        // initialize started state tracking
        prevStarted = SNAP().session.started;

        this.drawContacts();
        this.renderContactsPanel();

        setText(this.joinStatus, `Joined ${sessionId} as ${safeCs}`);
        localStorage.setItem("rr_sessionId", sessionId);
        localStorage.setItem("rr_callsign", safeCs);

        this.tryClaimOwner();
      } else if (resp?.error === "CALLSIGN_TAKEN") {
        const alt = `${safeCs}-${Math.random().toString(36).slice(2,4).toUpperCase()}`;
        setText(this.joinStatus, `Callsign taken. Trying ${alt}…`);
        this.joinSession(sessionId, alt);
      } else {
        setText(this.joinStatus, `Join failed: ${String(resp?.error ?? "")}`);
      }
    });
  }

  // === UI gating ===
  updateSessionBadge() {
    if (!lastSnapshot || !myId) { this.sessionBadge.style.display = "none"; return; }
    const isOwner = SNAP().session.ownerId === myId;
    this.sessionBadge.style.display = isOwner ? "block" : "none";
    if (isOwner) this.badgeSessionId.textContent = SNAP().session.id;
  }

  updateGuideUi() {
    if (!lastSnapshot || !myId) return;

    const isOwner = SNAP().session.ownerId === myId;
    // show main card always after join
    show(this.mainCard, true, "block");

    // Guide panel only for owner
    show(this.guidePanel, isOwner);

    if (document.activeElement !== this.guideRange) {
      this.guideRange.value = String(SNAP().session.rangeYds);
    }
    setText(this.guideStatus, `${SNAP().session.started ? "Armed" : "Staging"} • ${SNAP().session.paused ? "Paused" : "Running"}`);
    this.guidePauseBtn.textContent = SNAP().session.paused ? "Resume" : "Pause";

    // Staging card: owner before start; hide after start
    show(this.stagingCard, isOwner && !SNAP().session.started, "block");
    // Live NPC block visible only after start (and owner)
    show(this.npcLiveBlock, isOwner && SNAP().session.started);
  }

  updateWaitingOverlay() {
    if (!lastSnapshot || !myId) { this.waitingOverlay.style.display = "none"; return; }
    const isOwner = SNAP().session.ownerId === myId;
    const showIt = !SNAP().session.started && !isOwner;
    this.waitingOverlay.style.display = showIt ? "flex" : "none";
  }

  // === Staging buffers & rendering ===
  seedStagedPlayersFromSnapshot(): boolean {
    if (!lastSnapshot) return false;

    const ids = SNAP().players
      .filter(p => p.role !== "npc" && p.id !== SNAP().session.ownerId)
      .map(p => p.id)
      .sort();
    const key = ids.join(",");

    if (key === lastPlayerIdsKey) return false; // no change
    lastPlayerIdsKey = key;

    // Add new players
    for (const p of SNAP().players) {
      if (p.role === "npc" || p.id === SNAP().session.ownerId) continue;
      if (!stagedPlayers.has(p.id)) {
        stagedPlayers.set(p.id, {
          bearingDeg: 0,
          distanceYds: 0,
          courseDeg: Math.round(p.courseDeg) || 0,
          speedKts: Math.round(p.speedKts) || 0
        });
      }
    }

    // Remove players who left
    for (const existingId of Array.from(stagedPlayers.keys())) {
      if (!ids.includes(existingId)) stagedPlayers.delete(existingId);
    }

    return true; // membership changed
  }

  renderStagingPlayers() {
    if (!lastSnapshot) { this.stagingPlayers.innerHTML = ""; return; }

    const ownerId = SNAP().session.ownerId;
    const players = SNAP().players.filter(p => p.role !== "npc" && p.id !== ownerId);

    const rows = players.map(p => {
      const st = stagedPlayers.get(p.id)!;
      return `
        <tr data-id="${p.id}">
          <td style="text-align:left">${p.callsign}</td>
          <td><input class="st_b tiny" value="${pad3(st.bearingDeg)}"/></td>
          <td><input class="st_d mini" value="${st.distanceYds}"/></td>
          <td><input class="st_c tiny" value="${st.courseDeg}"/></td>
          <td><input class="st_s tiny" value="${st.speedKts}"/></td>
        </tr>
      `;
    }).join("");

    this.stagingPlayers.innerHTML = `
      <table class="tbl">
        <thead><tr><th style="text-align:left">Player</th><th>Bearing °T</th><th>Dist (yd)</th><th>Course °T</th><th>Speed kt</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="5" class="muted">No other players yet…</td></tr>'}</tbody>
      </table>
    `;

    // Wire inputs to update buffers immediately (persist even if you click elsewhere)
    for (const tr of Array.from(this.stagingPlayers.querySelectorAll("tr[data-id]"))) {
      const pid = (tr as HTMLElement).getAttribute("data-id")!;
      const st = stagedPlayers.get(pid)!;

      const ib = tr.querySelector<HTMLInputElement>(".st_b")!;
      const id = tr.querySelector<HTMLInputElement>(".st_d")!;
      const ic = tr.querySelector<HTMLInputElement>(".st_c")!;
      const is = tr.querySelector<HTMLInputElement>(".st_s")!;

      ib.addEventListener("input", () => { st.bearingDeg = (Number(ib.value) || 0) % 360; });
      id.addEventListener("input", () => { st.distanceYds = Number(id.value) || 0; });
      ic.addEventListener("input", () => { st.courseDeg   = Number(ic.value) || 0; });
      is.addEventListener("input", () => { st.speedKts    = Number(is.value) || 0; });
    }
  }

  renderStagingNpcs() {
    const rows = uiNpcRows.map(r => `
      <tr data-id="${r.id}">
        <td><input class="npc_cs" value="${r.callsign}"/></td>
        <td><input class="npc_b tiny"  value="${pad3(r.bearingDeg)}"/></td>
        <td><input class="npc_d mini"  value="${r.distanceYds}"/></td>
        <td><input class="npc_c tiny"  value="${r.courseDeg}"/></td>
        <td><input class="npc_s tiny"  value="${r.speedKts}"/></td>
        <td><span class="linkish npc_del" data-id="${r.id}">remove</span></td>
      </tr>
    `).join("");

    this.stagingNpcs.innerHTML = `
      <table class="tbl">
        <thead><tr><th style="text-align:left">Callsign</th><th>Bearing</th><th>Dist (yd)</th><th>Course</th><th>Speed</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan="6" class="muted">No NPC rows yet…</td></tr>'}</tbody>
      </table>
    `;

    // Wire inputs to buffer
    for (const tr of Array.from(this.stagingNpcs.querySelectorAll("tr[data-id]"))) {
      const idAttr = (tr as HTMLElement).getAttribute("data-id")!;
      const row = uiNpcRows.find(r => r.id === idAttr)!;

      const ics = tr.querySelector<HTMLInputElement>(".npc_cs")!;
      const ib  = tr.querySelector<HTMLInputElement>(".npc_b")!;
      const id  = tr.querySelector<HTMLInputElement>(".npc_d")!;
      const ic  = tr.querySelector<HTMLInputElement>(".npc_c")!;
      const is  = tr.querySelector<HTMLInputElement>(".npc_s")!;

      ics.addEventListener("input", () => { row.callsign    = ics.value.toUpperCase(); });
      ib.addEventListener("input",  () => { row.bearingDeg  = (Number(ib.value) || 0) % 360; });
      id.addEventListener("input",  () => { row.distanceYds = Number(id.value) || 0; });
      ic.addEventListener("input",  () => { row.courseDeg   = Number(ic.value) || 0; });
      is.addEventListener("input",  () => { row.speedKts    = Number(is.value) || 0; });

      const del = tr.querySelector(".npc_del") as HTMLElement;
      del.addEventListener("click", () => {
        const idx = uiNpcRows.findIndex(r => r.id === idAttr);
        if (idx >= 0) {
          uiNpcRows.splice(idx, 1);
          needsStagingRender = true;
          if (!isEditingStaging(this)) { this.renderStagingNpcs(); needsStagingRender = false; }
        }
      });
    }
  }

  clearDirtyFlags(container: HTMLElement) {
    for (const input of Array.from(container.querySelectorAll("input"))) {
      delete (input as HTMLInputElement).dataset.dirty;
    }
  }

  // Live NPC Controls (owner only, after start)
  renderNpcLiveControls() {
    if (!lastSnapshot || !myId) {
      if (this.npcLiveList) this.npcLiveList.innerHTML = "";
      return;
    }
    const isOwner = SNAP().session.ownerId === myId;

    if (!isOwner) { this.npcLiveList.innerHTML = "No access"; return; }
    if (!SNAP().session.started) { this.npcLiveList.innerHTML = '<span class="muted">Staging… (no NPCs yet)</span>'; return; }

    const npcs = SNAP().players.filter(p => p.role === "npc");
    if (npcs.length === 0) { this.npcLiveList.innerHTML = '<span class="muted">No NPCs</span>'; return; }

    const rows = npcs.map(p => `
      <tr data-id="${p.id}">
        <td style="text-align:left">${p.callsign}</td>
        <td><input class="ln_c tiny" value="${p.courseDeg.toFixed(0)}"/></td>
        <td><input class="ln_s tiny" value="${p.speedKts.toFixed(0)}"/></td>
        <td><button class="ln_set">Set</button></td>
      </tr>
    `).join("");

    this.npcLiveList.innerHTML = `
      <table class="tbl">
        <thead><tr><th style="text-align:left">NPC</th><th>Course</th><th>Speed</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;

    for (const tr of Array.from(this.npcLiveList.querySelectorAll("tr[data-id]"))) {
      const host = tr as HTMLElement;
      const npcId = host.getAttribute("data-id")!;
      const btn = host.querySelector(".ln_set") as HTMLButtonElement;
      const ic = host.querySelector<HTMLInputElement>(".ln_c")!;
      const is = host.querySelector<HTMLInputElement>(".ln_s")!;
      btn.addEventListener("click", () => {
        if (!socket || !lastSnapshot) return;
        const sid = SNAP().session.id;
        const c = Number(ic.value);
        const s = Number(is.value);
        socket.emit("npc:setNav", { sessionId: sid, npcId, courseDeg: c, speedKts: s }, (resp: any) => {
          if (!resp?.ok) alert(`NPC set failed: ${String(resp?.error ?? "")}`);
        });
      });
    }
  }

  // === Radar ===
  resize() {
    const { width, height } = this.scale;
    this.cx = width / 2; this.cy = height / 2; this.r = Math.min(width, height) * 0.45;
    this.drawScope(); this.drawContacts();
  }

  drawScope() {
    const g = this.scopeG; g.clear();
    const { cx, cy, r } = this;
    const rings = [r, r*0.8, r*0.6, r*0.4, r*0.2];
    for (let i=0;i<rings.length;i++){
      const rr = rings[i];
      g.lineStyle(2, 0x1f3d1f, 1 - i*0.12); g.strokeCircle(cx, cy, rr);
      if (i===0){ g.lineStyle(8, 0x114011, 0.12); g.strokeCircle(cx, cy, rr); }
    }
    g.lineStyle(2, 0x1f3d1f, 1); g.lineBetween(cx - r, cy, cx + r, cy); g.lineBetween(cx, cy - r, cx, cy + r);
    for (let deg = 0; deg < 360; deg += 30) {
      const rad = Phaser.Math.DegToRad(deg);
      const x1 = cx + Math.sin(rad) * (r - 10), y1 = cy - Math.cos(rad) * (r - 10);
      const x2 = cx + Math.sin(rad) * r, y2 = cy - Math.cos(rad) * r;
      g.lineBetween(x1, y1, x2, y2);
    }
  }

  drawContacts() {
    this.contactsG.clear();
    if (!lastSnapshot) return;

    const me = SNAP().players.find(p => p.id === myId);
    if (!me) return;

    const rangeYds = SNAP().session.rangeYds;
    const { cx, cy, r } = this;
    const g = this.contactsG;

    // ownship marker + label
    g.lineStyle(2, 0x9df5a7, 1); g.strokeCircle(cx, cy, 6);
    this.upsertLabel("OWN", cx + 8, cy - 8, `${me.callsign} (OWN)`, false);

    SNAP().players.forEach(p => {
      if (p.id === myId && p.role !== "npc") return;
      const rx = p.x - me.x, ry = p.y - me.y;
      let sx = cx + (rx / rangeYds) * r, sy = cy - (ry / rangeYds) * r;
      const dx = sx - cx, dy = sy - cy, distPix = Math.hypot(dx, dy), k = distPix > r ? r / distPix : 1;
      const px = cx + dx * k, py = cy + dy * k;

      const bTrueFromMe = bearingTrue(me, p);
      const diff = Math.abs(angDiff(this.sweepDeg, bTrueFromMe));
      const hot = diff < 3;

      g.lineStyle(hot ? 3 : 2, 0x9df5a7, hot ? 1 : 0.9);
      g.strokeCircle(px, py, hot ? 6 : 4);

      const tag = p.role === "npc" ? `${p.callsign}*` : p.callsign;
      this.upsertLabel(p.id, px + 6, py - 6, tag, hot);
    });
  }

  upsertLabel(key: string, x: number, y: number, text: string, bright: boolean) {
    const color = bright ? "#eaffea" : "#9df5a7";
    let t = labelById.get(key);
    if (!t) { t = this.add.text(x, y, text, { color }).setFontSize(12).setDepth(2); labelById.set(key, t); }
    else { t.setPosition(x, y).setText(text).setColor(color).setFontSize(12).setDepth(2); }
  }

  update(_time: number, deltaMs: number) {
    const degPerSec = 360 / (this.cadenceAvgMs / 1000);
    this.sweepDeg = (this.sweepDeg + degPerSec * (deltaMs/1000)) % 360;

    const { cx, cy, r } = this; const g = this.sweepG; g.clear();
    const aCenter = Phaser.Math.DegToRad(this.sweepDeg);
    const xC = cx + Math.sin(aCenter) * r, yC = cy - Math.cos(aCenter) * r;
    g.lineStyle(2, 0x66ff99, 0.28); g.lineBetween(cx, cy, xC, yC);

    const sweepWidth = 6;
    for (let i=-2;i<=2;i++){
      if (i === 0) continue;
      const t = i / 2, alpha = 0.10 * (1 - Math.abs(t));
      const ai = Phaser.Math.DegToRad(this.sweepDeg + t * sweepWidth);
      const x = cx + Math.sin(ai) * r, y = cy - Math.cos(ai) * r;
      g.lineStyle(2, 0x66ff99, alpha); g.lineBetween(cx, cy, x, y);
    }

    this.drawContacts();
  }

  renderContactsPanel() {
    if (!lastSnapshot) return;
    const me = SNAP().players.find(p => p.id === myId);
    if (!me) { this.contactsDiv.innerHTML = `<div class="muted">Join a session to see contacts.</div>`; return; }

    const rows = SNAP().players
      .filter(p => !(p.id === myId && p.role !== "npc"))
      .map(p => {
        const dYds = rangeY(me, p);
        const bT = bearingTrue(me, p);
        const bR = bearingRelative(bT, me.courseDeg);
        const tag = p.role === "npc" ? `${p.callsign}*` : p.callsign;
        return `<tr>
          <td style="text-align:left">${tag}</td>
          <td style="text-align:right">${dYds.toFixed(0)}</td>
          <td style="text-align:right">${bT.toFixed(0)}°T</td>
          <td style="text-align:right">${bR.toFixed(0)}°R</td>
        </tr>`;
      }).join("");

    this.contactsDiv.innerHTML = `
      <table>
        <thead><tr><th style="text-align:left">CS</th><th>Range (yd)</th><th>True</th><th>Rel</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="4" class="muted">No other contacts</td></tr>'}</tbody>
      </table>`;
  }
}

new Phaser.Game({
  type: Phaser.AUTO,
  parent: "app",
  backgroundColor: "#0a2a16",
  scale: { mode: Phaser.Scale.RESIZE, autoCenter: Phaser.Scale.CENTER_BOTH, width: 960, height: 640 },
  scene: [RadarScene],
});
