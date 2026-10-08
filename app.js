import { WORDS } from "./words.js";

// A game is a setup plus one record per (week, player): the slots that player can make,
// and whether they are done. Both modes share it; own-phone mode merges records over gossip.

const V = 3;
const KEY = "intersched.v3";
const roomKey = (k) => `intersched.room.${k}`;
const store = {
  get(k) { try { const x = JSON.parse(localStorage.getItem(k)); return x && x.v === V ? x : null; } catch { return null; } },
  set(k, x) { try { localStorage.setItem(k, JSON.stringify({ ...x, v: V })); } catch {} },
};
const DEVICE = (() => {
  try {
    let d = localStorage.getItem("intersched.device");
    if (!d) localStorage.setItem("intersched.device", (d = Math.random().toString(36).slice(2)));
    return d;
  } catch { return Math.random().toString(36).slice(2); }
})();

// ---------- dates ----------
function iso(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
function parseIso(s) { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); }
const addDays = (s, n) => { const d = parseIso(s); d.setDate(d.getDate() + n); return d; };
const tomorrow = () => iso(addDays(iso(new Date()), 1));
const fmtDay = (d) => d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
const fmtRange = (s, w) => {
  const o = { day: "numeric", month: "short" };
  return `${addDays(s, 7 * w).toLocaleDateString("en-GB", o)} – ${addDays(s, 7 * w + 6).toLocaleDateString("en-GB", o)}`;
};
const h = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const list = (names) => names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

// ---------- game rules ----------
const nCells = (g) => 7 * g.setup.slots.length;
const recOf = (g, w, p) => g.recs[`${w}|${p}`];
const picks = (g, w, p) => new Set(recOf(g, w, p)?.cells || []);

// Cells every done player except `viewer` picked. A cell outside it can no longer work.
function openFor(g, w, viewer) {
  const open = new Set(Array.from({ length: nCells(g) }, (_, i) => i));
  g.setup.players.forEach((_, p) => {
    if (p === viewer || !recOf(g, w, p)?.done) return;
    const mine = picks(g, w, p);
    for (const c of [...open]) if (!mine.has(c)) open.delete(c);
  });
  return open;
}

function weekInfo(g, w) {
  const done = g.setup.players.map((_, p) => p).filter((p) => recOf(g, w, p)?.done);
  const common = openFor(g, w, -1);
  return { done, common, dead: done.length > 0 && common.size === 0, finished: done.length === g.setup.players.length && common.size > 0 };
}

// The first week that still has a slot everyone who answered can make.
function currentWeek(g) { let w = 0; while (w < 520 && weekInfo(g, w).dead) w++; return w; }

function setRec(g, w, p, patch) {
  const k = `${w}|${p}`, old = g.recs[k] || { cells: [], done: false, ts: 0 };
  g.recs[k] = { ...old, ...patch, ts: Math.max(Date.now(), old.ts + 1), by: DEVICE };
}

const newer = (a, b) => a.ts > b.ts || (a.ts === b.ts && a.by > b.by);
function merge(g, incoming) {
  let changed = false;
  if (incoming.setup && (!g.setup || newer(incoming.setup, g.setup))) { g.setup = incoming.setup; changed = true; }
  for (const [k, r] of Object.entries(incoming.recs || {})) {
    if (!g.recs[k] || newer(r, g.recs[k])) { g.recs[k] = r; changed = true; }
  }
  return changed;
}

// ---------- state ----------
const fresh = (prev) => ({
  screen: "setup",
  draft: {
    players: prev?.draft?.players?.length ? prev.draft.players : ["", "", ""],
    slots: prev?.draft?.slots?.length ? prev.draft.slots : ["Afternoon", "Evening"],
    start: tomorrow(),
  },
  game: null, turn: 0, history: [], sel: null,
});

let S = store.get(KEY) || fresh();
if (S.screen === "setup" && !(S.draft.start >= iso(new Date()))) S.draft.start = tomorrow();

// Own-phone mode. Lives only in memory; the room's game is saved under its topic.
let NET = null;

function save() {
  if (NET) {
    if (NET.key) store.set(roomKey(NET.key), { game: S.game, me: S.me, secret: NET.secret, sel: S.sel });
    store.set(KEY, { ...fresh(S), draft: S.draft });
  } else {
    store.set(KEY, S);
  }
}

const app = document.getElementById("app");
function render() {
  try { (NET ? renderNet : { setup: renderSetup, turn: renderTurn, done: renderDone }[S.screen])(); }
  catch (e) { console.error(e); if (NET) throw e; S = fresh(S); renderSetup(); }
  save();
}

// ---------- shared pieces ----------
// The shortest name prefix that tells each player apart, so Ann and Alex show as An and Al.
function tags(players) {
  return players.map((p) => {
    for (let len = 1; len < p.length; len++) {
      const t = p.slice(0, len).toLowerCase();
      if (players.filter((q) => q.slice(0, len).toLowerCase() === t).length === 1) return p.slice(0, len);
    }
    return p;
  });
}

// `live` lists who else has ticked each slot so far, for own-phone mode.
function gridHtml(g, w, viewer, editable, live = false) {
  const n = g.setup.slots.length, open = openFor(g, w, viewer), mine = picks(g, w, viewer);
  const others = live ? g.setup.players.map((_, p) => p).filter((p) => p !== viewer).map((p) => [p, picks(g, w, p)]) : [];
  const tag = tags(g.setup.players);
  let out = `<div></div>` + g.setup.slots.map((s) => `<div class="head">${h(s)}</div>`).join("");
  for (let day = 0; day < 7; day++) {
    const d = addDays(g.setup.start, 7 * w + day), wk = d.getDay() === 0 || d.getDay() === 6;
    out += `<div class="day ${wk ? "weekend" : ""}">${d.toLocaleDateString("en-GB", { weekday: "short" })}<span>${d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</span></div>`;
    for (let s = 0; s < n; s++) {
      const idx = day * n + s, yes = mine.has(idx), x = !open.has(idx);
      const who = others.filter(([, set]) => set.has(idx)).map(([p]) => p);
      const ini = who.length ? `<span class="ini">${who.map((p) => h(tag[p])).join(" ")}</span>` : "";
      const label = `${g.setup.slots[s]}${x ? ", someone can't" : ""}${who.length ? `, ${who.map((p) => g.setup.players[p]).join(", ")} can` : ""}`;
      out += `<button class="cell ${yes ? "yes" : ""} ${x ? "x" : ""}" data-idx="${idx}" aria-pressed="${yes}" ${editable ? "" : "disabled"} aria-label="${h(label)}">${x ? "×" : yes ? "✓" : ""}${ini}</button>`;
    }
  }
  return `<div class="week" style="grid-template-columns: 4.2em repeat(${n}, minmax(0, 1fr))">${out}</div>`;
}

function bindGrid(g, w, viewer) {
  app.querySelectorAll(".cell[data-idx]").forEach((b) => b.onclick = () => {
    const idx = +b.dataset.idx, mine = picks(g, w, viewer);
    mine.has(idx) ? mine.delete(idx) : mine.add(idx);
    setRec(g, w, viewer, { cells: [...mine].sort((a, b) => a - b) });
    render(); broadcast();
  });
}

// What still works for everyone once `viewer` commits their current picks.
function leftAfter(g, w, viewer) {
  const open = openFor(g, w, viewer), mine = picks(g, w, viewer);
  return [...open].filter((c) => mine.has(c)).length;
}

function seatsHtml(g, w, current) {
  return `<div class="table">${g.setup.players.map((p, i) => `<span class="seat ${recOf(g, w, i)?.done ? "ok" : i === current ? "now" : ""}">${h(p)}</span>`).join("")}</div>`;
}

function rolledNotice(g, w) {
  return w > 0 && weekInfo(g, w).done.length === 0
    ? `<div class="notice">Nothing worked for ${fmtRange(g.setup.start, w - 1)}. Same again for this week.</div>` : "";
}

function bindTwoTap(id, label, action) {
  const b = document.getElementById(id);
  b.onclick = () => {
    if (b.dataset.armed) return action();
    b.dataset.armed = "1"; b.textContent = "Tap again to confirm"; b.style.color = "var(--accent)";
    setTimeout(() => { if (b.isConnected) { delete b.dataset.armed; b.textContent = label; b.style.color = ""; } }, 3000);
  };
}

// ---------- setup ----------
function renderSetup() {
  const D = S.draft;
  const listRows = (key, ph) => D[key].map((v, i) => `
    <div class="row">
      <span class="num">${i + 1}</span>
      <input id="${key}-${i}" data-key="${key}" data-i="${i}" value="${h(v)}" placeholder="${ph}" autocomplete="off">
      <button class="icon-btn" data-del="${key}" data-i="${i}" aria-label="Remove">×</button>
    </div>`).join("");
  const passLabel = () => `Pass one phone · ${D.players.find((p) => p.trim()) || "player 1"} starts`;
  app.innerHTML = `
    <div class="brand">intersched</div>
    <fieldset>
      <span class="label">Players, in seat order</span>
      ${listRows("players", "Name")}
      <button class="ghost" data-add="players">+ Add player</button>
    </fieldset>
    <fieldset>
      <span class="label">Time slots, earliest first</span>
      ${listRows("slots", "e.g. Evening")}
      <button class="ghost" data-add="slots">+ Add slot</button>
    </fieldset>
    <fieldset>
      <label class="label" for="start">First day</label>
      <input id="start" type="date" value="${D.start}" min="${iso(new Date())}">
    </fieldset>
    <div class="error" id="err"></div>
    <div class="modes">
      <button class="primary" id="go-pass">${h(passLabel())}</button>
      <button class="secondary" id="go-net">Everyone on their own phone</button>
    </div>
    <form class="join" id="join">
      <label class="label" for="code">Room words from another phone</label>
      <div class="row">
        <input id="code" placeholder="otter maple cove lid" autocomplete="off" autocapitalize="none" spellcheck="false">
        <button class="secondary" type="submit">Join</button>
      </div>
      <div class="error" id="join-err"></div>
    </form>`;

  app.querySelectorAll("input[data-key]").forEach((el) => el.addEventListener("input", () => {
    D[el.dataset.key][+el.dataset.i] = el.value; save();
    if (el.dataset.key === "players") document.getElementById("go-pass").textContent = passLabel();
  }));
  app.querySelectorAll("[data-add]").forEach((b) => b.onclick = () => {
    const k = b.dataset.add; D[k].push(""); render();
    document.getElementById(`${k}-${D[k].length - 1}`).focus();
  });
  app.querySelectorAll("[data-del]").forEach((b) => b.onclick = () => {
    const k = b.dataset.del; if (D[k].length > 1) D[k].splice(+b.dataset.i, 1); else D[k][0] = ""; render();
  });
  document.getElementById("start").onchange = (e) => { D.start = e.target.value; save(); };

  const validSetup = () => {
    const players = D.players.map((p) => p.trim()).filter(Boolean);
    const slots = D.slots.map((p) => p.trim()).filter(Boolean);
    const err = document.getElementById("err");
    if (players.length < 2) return void (err.textContent = "Add at least two players.");
    if (new Set(players).size !== players.length) return void (err.textContent = "Give every player a different name.");
    if (!slots.length) return void (err.textContent = "Add at least one time slot.");
    if (!D.start) return void (err.textContent = "Pick a first day.");
    D.players = players; D.slots = slots;
    return { setup: { players, slots, start: D.start, ts: Date.now(), by: DEVICE }, recs: {} };
  };
  document.getElementById("go-pass").onclick = () => {
    const g = validSetup(); if (!g) return;
    Object.assign(S, { game: g, turn: 0, history: [], sel: null, screen: "turn" }); render();
  };
  document.getElementById("go-net").onclick = () => {
    const g = validSetup(); if (!g) return;
    openRoom(newWords(), g);
  };
  document.getElementById("join").onsubmit = (e) => {
    e.preventDefault();
    const words = parseWords(document.getElementById("code").value);
    if (!words) return void (document.getElementById("join-err").textContent = `Type the ${ROOM_WORDS} words shown on the other phone.`);
    openRoom(words);
  };
}

// ---------- pass one phone ----------
function renderTurn() {
  const g = S.game, me = S.turn, w = currentWeek(g), P = g.setup.players;
  const info = weekInfo(g, w), left = leftAfter(g, w, me);
  const others = P.map((_, i) => i).filter((i) => i !== me && !recOf(g, w, i)?.done);
  const btn = left === 0 ? "None of these work · next week" : others.length ? `Pass to ${P[nextTurn(g, w, me)]}` : "Done";
  const prev = S.history.length ? JSON.parse(S.history.at(-1)).turn : null;

  app.innerHTML = `
    <div class="brand">intersched <small>${fmtRange(g.setup.start, w)}</small></div>
    ${rolledNotice(g, w)}
    <div class="enter">
      <div class="who">${h(P[me])}</div>
      <div class="who-sub">Tap every slot you can make.</div>
    </div>
    ${gridHtml(g, w, me, true)}
    <div class="count"><b>${left}</b> of ${openFor(g, w, me).size} open slots work for you${info.done.length ? " and everyone before you" : ""}</div>
    ${seatsHtml(g, w, me)}
    <button class="primary" id="pass">${h(btn)}</button>
    <div class="foot">
      <button id="undo" ${prev == null ? "disabled" : ""}>↶ Back${prev == null ? "" : ` to ${h(P[prev])}`}</button>
      <button id="reset">Start over</button>
    </div>`;

  bindGrid(g, w, me);
  document.getElementById("pass").onclick = () => {
    S.history.push(JSON.stringify({ recs: g.recs, turn: me }));
    setRec(g, w, me, { done: true });
    const after = weekInfo(g, w);
    if (after.finished) { S.screen = "done"; S.sel = null; }
    else S.turn = after.dead ? (me + 1) % P.length : nextTurn(g, w, me);
    render(); window.scrollTo(0, 0);
  };
  document.getElementById("undo").onclick = undo;
  bindTwoTap("reset", "Start over", () => { S = fresh(S); render(); });
}

function nextTurn(g, w, me) {
  const n = g.setup.players.length;
  for (let k = 1; k < n; k++) { const p = (me + k) % n; if (!recOf(g, w, p)?.done) return p; }
  return (me + 1) % n;
}

function undo() {
  const prev = S.history.pop(); if (!prev) return;
  const { recs, turn } = JSON.parse(prev);
  S.game.recs = recs; S.turn = turn; S.screen = "turn"; render();
}

// ---------- result ----------
function doneHtml(g, w, foot) {
  const n = g.setup.slots.length, open = [...weekInfo(g, w).common].sort((a, b) => a - b);
  if (S.sel == null || !open.includes(S.sel)) S.sel = open[0];
  const label = (idx) => ({ d: fmtDay(addDays(g.setup.start, 7 * w + Math.floor(idx / n))), p: g.setup.slots[idx % n] });
  const sel = label(S.sel);
  return `
    <div class="done-head enter">${open.length === 1 ? "One slot works for everyone" : `${open.length} slots work for everyone`}</div>
    <div class="options">${open.map((idx) => { const l = label(idx); return `<button class="option ${idx === S.sel ? "sel" : ""}" data-opt="${idx}"><span class="d">${l.d}</span><span class="p">${h(l.p)}</span></button>`; }).join("")}</div>
    <div class="stack">
      <button class="primary" id="copy" data-text="${h(`${sel.d}, ${sel.p.toLowerCase()}`)}">Copy ${h(sel.d.split(" ")[0])} ${h(sel.p.toLowerCase())}</button>
      ${foot}
    </div>`;
}

function bindDone() {
  app.querySelectorAll("[data-opt]").forEach((b) => b.onclick = () => { S.sel = +b.dataset.opt; render(); });
  const copy = document.getElementById("copy");
  copy.onclick = () => {
    const text = copy.dataset.text;
    try { navigator.clipboard.writeText(text).then(() => { copy.textContent = "Copied"; }, () => { copy.textContent = text; }); }
    catch { copy.textContent = text; }
  };
}

function renderDone() {
  const g = S.game, w = currentWeek(g);
  app.innerHTML = `
    <div class="brand">intersched <small>${w ? `${w} week${w > 1 ? "s" : ""} skipped` : fmtRange(g.setup.start, w)}</small></div>
    ${doneHtml(g, w, `<div class="foot"><button id="undo">↶ Back to ${h(g.setup.players[S.turn])}</button><button id="reset">Start over</button></div>`)}`;
  bindDone();
  document.getElementById("undo").onclick = undo;
  bindTwoTap("reset", "Start over", () => { S = fresh(S); render(); });
}

// ---------- own phone ----------
// A room is four words; the words alone are enough to find it.
const ROOM_WORDS = 4;
const newWords = () => Array.from(crypto.getRandomValues(new Uint32Array(ROOM_WORDS)), (n) => WORDS[n % WORDS.length]).join("-");
const parseWords = (text) => {
  const words = (text.toLowerCase().match(/[a-z]+/g) || []);
  return words.length === ROOM_WORDS && words.every((w) => WORDS.includes(w)) ? words.join("-") : null;
};
const inviteUrl = () => `${location.origin}${location.pathname}#${NET.words}`;

async function openRoom(words, hostGame) {
  const saved = store.get(roomKey(words));
  NET = { key: words, words, room: null, mod: null, peers: 0, error: null, secret: saved?.secret || "", invite: !!hostGame };
  S.game = hostGame || saved?.game || { setup: null, recs: {} };
  S.me = saved?.me ?? null;
  S.sel = saved?.sel ?? null;
  history.replaceState(null, "", `#${words}`);
  render();
  try {
    NET.mod = await import("./pkg/intersched_net.js");
    await NET.mod.default();
    NET.room = await NET.mod.Room.open(words, NET.secret);
    NET.secret = NET.room.secret();
    pump(NET.room.events());
    broadcast();
    setInterval(broadcast, 15000);
  } catch (e) {
    console.error(e);
    NET.error = e?.message || String(e);
  }
  render();
}

async function pump(stream) {
  const reader = stream.getReader();
  for (;;) {
    let next;
    try { next = await reader.read(); } catch (e) { NET.error = String(e); render(); return; }
    if (next.done) return;
    const ev = next.value;
    NET.peers = ev.peers;
    if (ev.type === "up") broadcast();
    if (ev.type === "msg") {
      try { merge(S.game, JSON.parse(ev.data).s); } catch {}
    }
    render();
  }
}

// Gossip drops repeats of identical messages, so each broadcast carries a nonce.
function broadcast() {
  if (!NET?.room || !S.game?.setup) return;
  NET.room.broadcast(JSON.stringify({ n: Math.random(), s: { setup: S.game.setup, recs: S.game.recs } })).catch((e) => console.warn(e));
}

function peersPill() {
  if (NET.error) return `<span class="pill bad">Offline</span>`;
  if (!NET.room) return `<span class="pill">Connecting…</span>`;
  return `<span class="pill ${NET.peers ? "live" : ""}">${NET.peers ? `${NET.peers} other phone${NET.peers > 1 ? "s" : ""}` : "No one else yet"}</span>`;
}

function leave() { history.replaceState(null, "", location.pathname); location.reload(); }

function renderNet() {
  const g = S.game;
  const bar = (extra = "") => `<div class="brand">intersched <span class="bar">${extra}${peersPill()}</span></div>`;

  if (NET.invite && NET.room) {
    const url = inviteUrl();
    app.innerHTML = `
      ${bar()}
      <div class="center">
        <div class="qr">${NET.mod.qr_svg(url)}</div>
        <div class="words" id="words">${h(NET.words.replaceAll("-", " "))}</div>
        <button class="secondary" id="copy-link">Copy link</button>
      </div>
      <button class="primary" id="close">${S.me == null ? "Pick your name" : "Back to the week"}</button>`;
    document.getElementById("copy-link").onclick = (e) => {
      try { navigator.clipboard.writeText(url).then(() => { e.target.textContent = "Copied"; }); } catch {}
    };
    document.getElementById("close").onclick = () => { NET.invite = false; render(); };
    return;
  }

  if (!g.setup) {
    app.innerHTML = `
      ${bar()}
      <div class="center">
        <div class="done-head">${NET.error ? "Can't reach the room" : "Joining…"}</div>
        <div class="hint">${NET.error ? h(NET.error) : "Waiting for a phone that's already in the room."}</div>
      </div>
      <button class="secondary" id="leave">${NET.error ? "Try again" : "Cancel"}</button>`;
    document.getElementById("leave").onclick = NET.error ? () => location.reload() : leave;
    return;
  }

  const w = currentWeek(g), P = g.setup.players, info = weekInfo(g, w);

  if (S.me == null || S.me >= P.length) {
    app.innerHTML = `
      ${bar(NET.room ? `<button id="invite">Invite</button>` : "")}
      <div class="done-head">Who are you?</div>
      <div class="people">${P.map((p, i) => `<button class="person" data-me="${i}">${h(p)}${recOf(g, w, i)?.done ? "<span>done</span>" : ""}</button>`).join("")}</div>`;
    app.querySelectorAll("[data-me]").forEach((b) => b.onclick = () => { S.me = +b.dataset.me; render(); });
    bindInvite();
    return;
  }

  const foot = `<div class="foot"><button id="not-me">Not ${h(P[S.me])}?</button><button id="leave">Leave room</button></div>`;

  if (info.finished) {
    app.innerHTML = `${bar(`<button id="invite">Invite</button>`)}${doneHtml(g, w, foot)}`;
    bindDone(); bindInvite(); bindFoot();
    return;
  }

  const me = S.me, done = !!recOf(g, w, me)?.done, left = leftAfter(g, w, me);
  const waiting = P.filter((_, i) => i !== me && !recOf(g, w, i)?.done);
  const btn = left === 0 ? "None of these work · next week" : waiting.length ? "I'm done" : "Done";

  app.innerHTML = `
    ${bar(`<button id="invite">Invite</button>`)}
    ${rolledNotice(g, w)}
    <div class="me-line"><span class="label">${fmtRange(g.setup.start, w)}</span></div>
    <div class="enter">
      <div class="who">${h(P[me])}</div>
      <div class="who-sub">${done ? "Your picks are in." : "Tap every slot you can make."}</div>
    </div>
    ${gridHtml(g, w, me, !done, true)}
    <div class="count"><b>${left}</b> of ${openFor(g, w, me).size} open slots work for you${info.done.filter((p) => p !== me).length ? " and everyone who's done" : ""}</div>
    ${seatsHtml(g, w, me)}
    ${done
      ? `<div class="wait">Waiting for ${h(list(waiting))}</div><button class="secondary" id="edit">Change my picks</button>`
      : `<button class="primary" id="submit">${h(btn)}</button>`}
    ${foot}`;

  bindGrid(g, w, me);
  bindInvite(); bindFoot();
  const submit = document.getElementById("submit");
  if (submit) submit.onclick = () => { setRec(g, w, me, { done: true }); render(); broadcast(); window.scrollTo(0, 0); };
  const edit = document.getElementById("edit");
  if (edit) edit.onclick = () => { setRec(g, w, me, { done: false }); render(); broadcast(); };
}

function bindInvite() {
  const b = document.getElementById("invite");
  if (b) b.onclick = () => { NET.invite = true; render(); };
}

function bindFoot() {
  document.getElementById("not-me").onclick = () => { S.me = null; render(); };
  bindTwoTap("leave", "Leave room", leave);
}

// ---------- boot ----------
const join = parseWords(decodeURIComponent(location.hash.slice(1)));
if (join) openRoom(join);
else render();
