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
function show(el: HTMLElement | null, on: boolean, display: string = "block") {
  if (!el) return;
  el.style.display = on ? display : "none";
}
function byId<T extends HTMLElement = HTMLElement>(id: string) {
  return document.getElementById(id) as T | null;
}
function normalizeCallsign(v: string) { return (v || "").toUpperCase().replace(/[^A-Z0-9\-]/g, "").slice(0, 12); }

let socket: Socket | null = null;
let lastSnapshot: SnapshotMsg | null = null;
let myId: string | undefined = undefined;
let pendingJoin = false;

const labelById = new Map<string, Phaser.GameObjects.Text>();

type StNpcRow = { id: string; callsign: string; bearingDeg: number; distanceYds: number; courseDeg: number; speedKts: number };
const uiNpcRows: StNpcRow[] = [];

class RadarScene extends Phaser.Scene {
  cx = 0; cy = 0; r = 0;

  scopeG!: Phaser.GameObjects.Graphics;
  contactsG!: Phaser.GameObjects.Graphics;
  sweepG!: Phaser.GameObjects.Graphics;

  // UI
  contactsDiv!: HTMLElement;
  uiRoot!: HTMLElement;
  rightPanel!: HTMLElement;
  waitingOverlay!: HTMLElement;
  sessionBadge!: HTMLElement; badgeSessionId!: HTMLElement;

  // Guide
  guidePanel!: HTMLElement;
  guideRange!: HTMLInputElement; guideRangeBtn!: HTMLButtonElement; guidePauseBtn!: HTMLButtonElement; guideStatus!: HTMLElement;

  // Staging
  stagingPlayers!: HTMLElement;
  stagingNpcs!: HTMLElement;
  addNpcRow!: HTMLElement;
  startBtn!: HTMLButtonElement;
  stagingBlock!: HTMLElement;
  npcLiveBlock!: HTMLElement;

  // Live NPC controls
  npcLiveList!: HTMLElement;

  // Recorder
  recToggleBtn!: HTMLButtonElement; recDownload!: HTMLAnchorElement;
  recordingOn = false;

  // Pre-join & nav
  serverUrl!: HTMLInputElement; sessName!: HTMLInputElement; sessRange!: HTMLInputElement;
  createBtn!: HTMLButtonElement; createStatus!: HTMLElement;
  sessionIdInput!: HTMLInputElement; callsignInput!: HTMLInputElement;
  joinBtn!: HTMLButtonElement; joinStatus!: HTMLElement;
  course!: HTMLInputElement; speed!: HTMLInputElement; setNavBtn!: HTMLButtonElement;

  // Sweep
  sweepDeg = 0; cadenceAvgMs = 2500; lastServerTickMs = 0;

  create() {
    this.cameras.main.setBackgroundColor(0x020702);
    this.cacheUi();

    // default server URL
    if (!this.serverUrl.value) {
      const auto =
        (location.hostname.includes("githubpreview.dev") || location.hostname.includes("codespaces"))
          ? location.origin.replace(/5173/, "3001")
          : "http://localhost:3001";
      this.serverUrl.value = auto;
    }

    const connectIfNeeded = () => {
      if (socket) return;
      socket = io(this.serverUrl.value.trim());

      socket.on("connect", () => {
        setText(this.joinStatus, `Connected: ${socket!.id}`);
        myId = socket!.id;
        this.tryClaimOwner();
        // no auto-join here to avoid stale sessions
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

        this.updateGuideUi();
        this.updateSessionBadge();
        this.updateWaitingOverlay();
        this.renderStagingPlayers();
        this.renderStagingNpcs();
        this.renderNpcLiveControls();
        this.drawContacts();
        this.renderContactsPanel();
      });

      socket.on("player:left", () => {
        if (lastSnapshot) { this.renderStagingPlayers(); this.drawContacts(); this.renderContactsPanel(); }
      });

      socket.on("scenario:update", (_data: ScenarioUpdate) => {
        this.renderNpcLiveControls();
      });
    };

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

            // Clear old saved session
            localStorage.removeItem("rr_sessionId");
            localStorage.removeItem("rr_callsign");

            // Auto-join
            const csInput = (this.callsignInput.value || "GUIDE").trim() || "GUIDE";
            const cs = normalizeCallsign(csInput);
            this.joinBtn.disabled = true;
            this.joinSession(sid, cs);
            setTimeout(() => { this.joinBtn.disabled = false; }, 1500);

            // Save fresh values
            localStorage.setItem("rr_sessionId", sid);
            localStorage.setItem("rr_callsign", cs);
          } else {
            setText(this.createStatus, "Create failed");
          }
        });
    });

    // Join (manual)
    this.joinBtn.addEventListener("click", () => {
      connectIfNeeded();
      const sessionId = this.sessionIdInput.value.trim();
      let cs = (this.callsignInput.value || "").trim();
      if (!sessionId) { setText(this.joinStatus, "Enter session code."); return; }
      if (!cs) cs = `SHIP-${Math.random().toString(36).slice(2,6).toUpperCase()}`;
      this.joinSession(sessionId, cs);
    });

    // My Nav
    this.setNavBtn.addEventListener("click", () => {
      if (!socket) return;
      const c = Number(this.course.value), s = Number(this.speed.value);
      socket.emit("player:setNav", { courseDeg: isFinite(c) ? c : undefined, speedKts: isFinite(s) ? s : undefined });
    });

    // Guide: range/pause
    this.guideRangeBtn.addEventListener("click", () => {
      if (!socket || !lastSnapshot) return;
      const sid = lastSnapshot.session.id;
      const nextRange = Number(this.guideRange.value) || lastSnapshot.session.rangeYds;

      socket.emit("session:setRange", { sessionId: sid, rangeYds: nextRange }, (resp: any) => {
        if (!resp?.ok) setText(this.guideStatus, `Range set failed: ${String(resp?.error ?? "")}`);
      });
    });
    this.guidePauseBtn.addEventListener("click", () => {
      if (!socket || !lastSnapshot) return;
      const sid = lastSnapshot.session.id;
      const next = !lastSnapshot.session.paused;

      socket.emit("session:pause", { sessionId: sid, paused: next }, (resp: any) => {
        if (!resp?.ok) setText(this.guideStatus, `Pause failed: ${String(resp?.error ?? "")}`);
      });
    });

    // Staging: add/remove NPC rows and START
    this.addNpcRow.addEventListener("click", () => {
      uiNpcRows.push({ id: cryptoRand(), callsign: "SKUNK", bearingDeg: 0, distanceYds: 0, courseDeg: 90, speedKts: 15 });
      this.renderStagingNpcs();
    });

    this.startBtn.addEventListener("click", () => {
      if (!socket || !lastSnapshot) return;
      const sid = lastSnapshot.session.id;

      // players (exclude owner)
      const tbody = this.stagingPlayers.querySelector("tbody");
      const placements: Array<{playerId:string; bearingDeg:number; distanceYds:number; courseDeg?:number; speedKts?:number}> = [];
      if (tbody) {
        for (const tr of Array.from(tbody.querySelectorAll("tr"))) {
          const pid = (tr.getAttribute("data-id") || "").trim(); if (!pid) continue;
          const b = Number((tr.querySelector<HTMLInputElement>(".st_b"))?.value ?? 0);
          const d = Number((tr.querySelector<HTMLInputElement>(".st_d"))?.value ?? 0);
          const c = Number((tr.querySelector<HTMLInputElement>(".st_c"))?.value ?? 0);
          const s = Number((tr.querySelector<HTMLInputElement>(".st_s"))?.value ?? 0);
          placements.push({ playerId: pid, bearingDeg: b, distanceYds: d, courseDeg: c, speedKts: s });
        }
      }

      // npcs (from UI rows)
      const npcs: Array<{callsign:string; bearingDeg:number; distanceYds:number; courseDeg:number; speedKts:number}> = [];
      for (const row of uiNpcRows) {
        const host = this.stagingNpcs.querySelector(`tr[data-id="${row.id}"]`);
        if (!host) continue;
        const cs = String((host.querySelector<HTMLInputElement>(".npc_cs"))?.value ?? "SKUNK");
        const b  = Number((host.querySelector<HTMLInputElement>(".npc_b"))?.value ?? 0);
        const d  = Number((host.querySelector<HTMLInputElement>(".npc_d"))?.value ?? 0);
        const c  = Number((host.querySelector<HTMLInputElement>(".npc_c"))?.value ?? 0);
        const s  = Number((host.querySelector<HTMLInputElement>(".npc_s"))?.value ?? 0);
        npcs.push({ callsign: cs, bearingDeg: b, distanceYds: d, courseDeg: c, speedKts: s });
      }

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
    this.uiRoot = document.getElementById("ui")!;
    this.rightPanel = document.getElementById("rightPanel")!;
    this.contactsDiv = document.getElementById("contacts")!;
    this.waitingOverlay = document.getElementById("waitingOverlay")!;
    this.sessionBadge = document.getElementById("sessionBadge")!;
    this.badgeSessionId = document.getElementById("badgeSessionId")!;

    this.serverUrl = document.getElementById("serverUrl") as HTMLInputElement;
    this.sessName  = document.getElementById("sessName") as HTMLInputElement;
    this.sessRange = document.getElementById("sessRange") as HTMLInputElement;
    this.createBtn = document.getElementById("createBtn") as HTMLButtonElement;
    this.createStatus = document.getElementById("createStatus")!;
    this.sessionIdInput = document.getElementById("sessionId") as HTMLInputElement;
    this.callsignInput  = document.getElementById("callsign") as HTMLInputElement;
    this.joinBtn = document.getElementById("joinBtn") as HTMLButtonElement;
    this.joinStatus = document.getElementById("joinStatus")!;

    this.course = document.getElementById("course") as HTMLInputElement;
    this.speed  = document.getElementById("speed") as HTMLInputElement;
    this.setNavBtn = document.getElementById("setNavBtn") as HTMLButtonElement;

    this.guidePanel = document.getElementById("guideControls")!;
    this.guideRange = document.getElementById("guideRange") as HTMLInputElement;
    this.guideRangeBtn = document.getElementById("guideRangeBtn") as HTMLButtonElement;
    this.guidePauseBtn = document.getElementById("guidePauseBtn") as HTMLButtonElement;
    this.guideStatus = document.getElementById("guideStatus")!;

    this.stagingPlayers = document.getElementById("stagingPlayers")!;
    this.stagingNpcs = document.getElementById("stagingNpcs")!;
    this.addNpcRow = document.getElementById("addNpcRow")!;
    this.startBtn = document.getElementById("startBtn") as HTMLButtonElement;
    this.stagingBlock = byId("stagingBlock")!;
    this.npcLiveBlock = byId("npcLiveBlock")!;
    this.npcLiveList = document.getElementById("npcLiveList")!;

    this.recToggleBtn = document.getElementById("recToggleBtn") as HTMLButtonElement;
    this.recDownload = document.getElementById("recDownload") as HTMLAnchorElement;
  }

  tryClaimOwner() {
    const token = sessionStorage.getItem("rr_ownerToken");
    const sid = (lastSnapshot?.session.id ?? this.sessionIdInput.value.trim());
    if (!socket || !token || !sid) return;
    socket.emit("session:claimOwner", { sessionId: sid, ownerToken: token }, () => {});
  }

  // Join (robust + UI flip)
  joinSession(sessionId: string, callsign: string) {
    if (!socket || pendingJoin) return;
    const cs = normalizeCallsign(callsign);
    const safeCs = cs || `SHIP-${Math.random().toString(36).slice(2,6).toUpperCase()}`;

    pendingJoin = true;
    socket.emit("session:join", { sessionId, callsign: safeCs }, (resp: any) => {
      pendingJoin = false;

      if (resp?.ok) {
        // Apply snapshot right away
        lastSnapshot = resp.snapshot as SnapshotMsg;

        // Force panel swap (inline style to avoid CSS specificity issues)
        if (this.uiRoot) this.uiRoot.style.display = "none";
        if (this.rightPanel) this.rightPanel.style.display = "block";

        // Sync UI
        this.sessRange.value = String(lastSnapshot.session.rangeYds);
        this.updateGuideUi();
        this.updateSessionBadge();
        this.updateWaitingOverlay();
        this.renderStagingPlayers();
        this.renderStagingNpcs();
        this.renderNpcLiveControls();
        this.drawContacts();
        this.renderContactsPanel();

        // Status + persistence
        setText(this.joinStatus, `Joined ${sessionId} as ${safeCs}`);
        localStorage.setItem("rr_sessionId", sessionId);
        localStorage.setItem("rr_callsign", safeCs);

        // Try to claim owner (if this tab holds the token)
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

  // === UI updates ===
  updateSessionBadge() {
    if (!lastSnapshot || !myId) { this.sessionBadge.style.display = "none"; return; }
    const isOwner = lastSnapshot.session.ownerId === myId;
    this.sessionBadge.style.display = isOwner ? "block" : "none";
    if (isOwner) this.badgeSessionId.textContent = lastSnapshot.session.id;
  }

  updateGuideUi() {
  if (!lastSnapshot || !myId) return;

  const isOwner = lastSnapshot.session.ownerId === myId;
  // Guide controls visible only to owner
  show(this.guidePanel, isOwner);

  // Keep range input synced unless focused
  if (document.activeElement !== this.guideRange) {
    this.guideRange.value = String(lastSnapshot.session.rangeYds);
  }

  // Status line + pause button
  setText(this.guideStatus, `${lastSnapshot.session.started ? "Armed" : "Staging"} • ${lastSnapshot.session.paused ? "Paused" : "Running"}`);
  this.guidePauseBtn.textContent = lastSnapshot.session.paused ? "Resume" : "Pause";

  // ★ Explicitly toggle staging vs live blocks
  const showStaging = isOwner && !lastSnapshot.session.started;
  const showLive    = isOwner && lastSnapshot.session.started;

  show(this.stagingBlock, showStaging);
  show(this.npcLiveBlock, showLive);

  // Non-owner waiting overlay handled elsewhere; ensure owner never sees it
  if (isOwner && this.waitingOverlay) this.waitingOverlay.style.display = "none";
}


  updateWaitingOverlay() {
    if (!lastSnapshot || !myId) { this.waitingOverlay.style.display = "none"; return; }
    const isOwner = lastSnapshot.session.ownerId === myId;
    const show = !lastSnapshot.session.started && !isOwner;
    this.waitingOverlay.style.display = show ? "flex" : "none";
  }

  // Staging players (exclude owner)
  renderStagingPlayers() {
    if (!lastSnapshot || !myId) { this.stagingPlayers.innerHTML = ""; return; }
    const isOwner = lastSnapshot.session.ownerId === myId;
    if (!isOwner || lastSnapshot.session.started) { this.stagingPlayers.innerHTML = ""; return; }

    const rows = lastSnapshot.players
      .filter(p => p.role !== "npc" && p.id !== lastSnapshot.session.ownerId)
      .map(p => `
        <tr data-id="${p.id}">
          <td>${p.callsign}</td>
          <td><input class="st_b tiny" value="000"/></td>
          <td><input class="st_d mini" value="0"/></td>
          <td><input class="st_c tiny" value="${p.courseDeg.toFixed(0)}"/></td>
          <td><input class="st_s tiny" value="${p.speedKts.toFixed(0)}"/></td>
        </tr>
      `).join("");

    this.stagingPlayers.innerHTML = `
      <table class="tbl">
        <thead><tr><th style="text-align:left">Player</th><th>Bearing °T</th><th>Dist (yd)</th><th>Course °T</th><th>Speed kt</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="5" class="muted">No other players yet…</td></tr>'}</tbody>
      </table>
    `;
  }

  // Staging NPCs dynamic rows
  renderStagingNpcs() {
    if (!lastSnapshot || !myId) { this.stagingNpcs.innerHTML = ""; return; }
    const isOwner = lastSnapshot.session.ownerId === myId;
    if (!isOwner || lastSnapshot.session.started) { this.stagingNpcs.innerHTML = ""; return; }

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

    for (const el of Array.from(this.stagingNpcs.querySelectorAll(".npc_del"))) {
      el.addEventListener("click", () => {
        const id = (el as HTMLElement).getAttribute("data-id")!;
        const idx = uiNpcRows.findIndex(rr => rr.id === id);
        if (idx >= 0) { uiNpcRows.splice(idx,1); this.renderStagingNpcs(); }
      });
    }
  }

  // Live NPC Controls
  renderNpcLiveControls() {
    if (!lastSnapshot || !myId) { this.npcLiveList.innerHTML = "No NPCs"; return; }
    const isOwner = lastSnapshot.session.ownerId === myId;
    if (!isOwner) { this.npcLiveList.innerHTML = "No access"; return; }

    const npcs = lastSnapshot.players.filter(p => p.role === "npc");
    if (!lastSnapshot.session.started) { this.npcLiveList.innerHTML = '<span class="muted">Staging… (no NPCs yet)</span>'; return; }
    if (npcs.length === 0) { this.npcLiveList.innerHTML = '<span class="muted">No NPCs</span>'; return; }

    const rows = npcs.map(p => `
      <tr data-id="${p.id}">
        <td>${p.callsign}</td>
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
      const npcId = (tr as HTMLElement).getAttribute("data-id")!;
      const btn = tr.querySelector(".ln_set") as HTMLButtonElement;
      btn.addEventListener("click", () => {
        if (!socket || !lastSnapshot) return;
        const sid = lastSnapshot.session.id;
        const c = Number((tr.querySelector<HTMLInputElement>(".ln_c"))?.value ?? 0);
        const s = Number((tr.querySelector<HTMLInputElement>(".ln_s"))?.value ?? 0);
        socket.emit("npc:setNav", { sessionId: sid, npcId, courseDeg: c, speedKts: s }, (resp: any) => {
          if (!resp?.ok) alert(`NPC set failed: ${String(resp?.error ?? "")}`);
        });
      });
    }
  }

  // === Radar draw ===
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

    const me = lastSnapshot.players.find(p => p.id === myId);
    if (!me) return;

    const rangeYds = lastSnapshot.session.rangeYds;
    const { cx, cy, r } = this;
    const g = this.contactsG;

    // ownship marker + label
    g.lineStyle(2, 0x9df5a7, 1); g.strokeCircle(cx, cy, 6);
    this.upsertLabel("OWN", cx + 8, cy - 8, `${me.callsign} (OWN)`, false);

    lastSnapshot.players.forEach(p => {
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

  // Contacts panel
  renderContactsPanel() {
    if (!lastSnapshot) return;
    const me = lastSnapshot.players.find(p => p.id === myId);
    if (!me) { this.contactsDiv.innerHTML = `<div class="muted">Join a session to see contacts.</div>`; return; }

    const rows = lastSnapshot.players
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

// helpers
function pad3(n:number){ return String(Math.round(n)%360).padStart(3,"0"); }
function cryptoRand(){ return Math.random().toString(36).slice(2,9); }

new Phaser.Game({
  type: Phaser.AUTO,
  parent: "app",
  backgroundColor: "#020702",
  scale: { mode: Phaser.Scale.RESIZE, autoCenter: Phaser.Scale.CENTER_BOTH, width: 960, height: 640 },
  scene: [RadarScene],
});
