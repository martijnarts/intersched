import { WORDS } from "./words.js";
import { STRINGS } from "./strings.js";

// A game is a setup plus one record per (week, person): the slots that person can make,
// and whether they are done. Both modes share it; own-phone mode merges records over gossip.

const V = 4;
const KEY = "intersched.v4";
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

// ---------- language ----------
const pickLang = () => {
  try { const l = localStorage.getItem("intersched.lang"); if (STRINGS[l]) return l; } catch {}
  return (navigator.languages || [navigator.language]).some((l) => /^nl\b/i.test(l)) ? "nl" : "en";
};
let LANG = pickLang();
const t = (key, ...args) => { const v = STRINGS[LANG][key]; return typeof v === "function" ? v(...args) : v; };
document.documentElement.lang = LANG;

// ---------- dates ----------
function iso(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
function parseIso(s) { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); }
const addDays = (s, n) => { const d = parseIso(s); d.setDate(d.getDate() + n); return d; };
const today = () => iso(new Date());
const mondayOf = (s) => { const d = parseIso(s); d.setDate(d.getDate() - (d.getDay() + 6) % 7); return iso(d); };
const fmtDay = (d) => d.toLocaleDateString(t("locale"), { weekday: "long", day: "numeric", month: "long" });
const fmtRange = (s, w) => {
  const o = { day: "numeric", month: "short" };
  return `${addDays(s, 7 * w).toLocaleDateString(t("locale"), o)} – ${addDays(s, 7 * w + 6).toLocaleDateString(t("locale"), o)}`;
};
const h = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const list = (names) => names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} ${t("and")} ${names.at(-1)}`;

// ---------- game rules ----------
const nCells = (g) => 7 * g.setup.slots.length;
const recOf = (g, w, p) => g.recs[`${w}|${p}`];
const picks = (g, w, p) => new Set(recOf(g, w, p)?.cells || []);

// A slot on a day before today can no longer happen.
const isPast = (g, w, idx) => iso(addDays(g.setup.start, 7 * w + Math.floor(idx / g.setup.slots.length))) < today();

// Cells every done person except `viewer` picked. A cell outside it can no longer work.
function openFor(g, w, viewer) {
  const open = new Set(Array.from({ length: nCells(g) }, (_, i) => i).filter((i) => !isPast(g, w, i)));
  g.setup.people.forEach((_, p) => {
    if (p === viewer || !recOf(g, w, p)?.done) return;
    const mine = picks(g, w, p);
    for (const c of [...open]) if (!mine.has(c)) open.delete(c);
  });
  return open;
}

function weekInfo(g, w) {
  const done = g.setup.people.map((_, p) => p).filter((p) => recOf(g, w, p)?.done);
  const common = openFor(g, w, -1);
  return { done, common, dead: done.length > 0 && common.size === 0, finished: done.length === g.setup.people.length && common.size > 0 };
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
  // A setup from before the people rename has no people; ignore it rather than break.
  if (Array.isArray(incoming.setup?.people) && (!g.setup || newer(incoming.setup, g.setup))) { g.setup = incoming.setup; changed = true; }
  for (const [k, r] of Object.entries(incoming.recs || {})) {
    if (!g.recs[k] || newer(r, g.recs[k])) { g.recs[k] = r; changed = true; }
  }
  g.claims ??= {};
  for (const [k, c] of Object.entries(incoming.claims || {})) {
    if (!g.claims[k] || newer(c, g.claims[k])) { g.claims[k] = c; changed = true; }
  }
  return changed;
}

// A claim says which phone holds a person's name. `by` is null once the phone lets go.
function setClaim(g, p, by) {
  g.claims ??= {};
  const old = g.claims[p];
  g.claims[p] = { by, ts: Math.max(Date.now(), (old?.ts || 0) + 1) };
}

// ---------- state ----------
const fresh = (prev) => ({
  screen: "setup",
  draft: {
    people: prev?.draft?.people?.length ? prev.draft.people : ["", "", ""],
    inks: prev?.draft?.people?.length ? prev.draft.inks : [0, 1, 2],
    slots: prev?.draft?.slots?.length ? prev.draft.slots : [...t("defaultSlots")],
    start: mondayOf(today()),
  },
  game: null, turn: 0, history: [], sel: null,
});

let S = store.get(KEY) || fresh();
// Planning starts on a Monday, this week or later.
if (S.screen === "setup" && !(S.draft.start === mondayOf(S.draft.start || today()) && S.draft.start >= mondayOf(today()))) S.draft.start = mondayOf(today());

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
const calm = matchMedia("(prefers-reduced-motion: reduce)");

// A new screen grows in as a circle from where you tapped, like one more set joining the diagram.
let lastView = null, tapX = innerWidth / 2, tapY = innerHeight / 2;
addEventListener("pointerdown", (e) => { tapX = e.clientX; tapY = e.clientY; }, true);
// iOS only applies :active, the pressed state, when the page listens for touches.
addEventListener("touchstart", () => {}, { passive: true });
function viewKey() {
  try {
    const g = S.game, w = g?.setup ? currentWeek(g) : -1;
    if (NET) return `net ${NET.invite} ${S.me} ${w} ${!!g?.setup && weekInfo(g, w).finished} ${LANG}`;
    if (S.screen === "turn" || S.screen === "done") return `${S.screen} ${S.turn} ${w} ${LANG}`;
    return `${S.screen} ${LANG}`;
  } catch { return "?"; }
}

// How a screen change moves: "grow" out of the tap, "back" into it, or "roll" sideways to the next week.
let lastWeek = null, goBack = false;
function weekNow() { try { return S.game?.setup ? currentWeek(S.game) : null; } catch { return null; } }

function render() {
  const key = viewKey(), changed = lastView !== null && key !== lastView;
  const week = weekNow(), rolled = lastWeek !== null && week !== null && week > lastWeek;
  const kind = goBack ? "back" : rolled ? "roll" : "grow";
  lastView = key; lastWeek = week; goBack = false;
  if (!changed || !document.startViewTransition || calm.matches) return draw();
  const root = document.documentElement;
  // The circle grows exactly to the farthest corner, so the whole duration is visible.
  const r = Math.hypot(Math.max(tapX, innerWidth - tapX), Math.max(tapY, innerHeight - tapY)) + 8;
  root.style.setProperty("--vt-x", `${tapX}px`);
  root.style.setProperty("--vt-y", `${tapY}px`);
  root.style.setProperty("--vt-r", `${r}px`);
  root.dataset.vt = kind;
  root.classList.add("vt");
  const vt = document.startViewTransition(() => { draw(); if (kind !== "roll") ring(kind); });
  vt.finished.finally(() => {
    root.classList.remove("vt");
    delete root.dataset.vt;
    document.querySelectorAll(".vt-ring").forEach((el) => el.remove());
  });
}

// An ink ring rides the edge of the circle, so a half-revealed screen reads as a circle, not a glitch.
function ring(kind) {
  const el = document.createElement("div");
  el.className = `vt-ring ${kind}`;
  document.body.append(el);
}

// Animations on a new screen wait for the screen change to finish growing in.
const settle = () => (document.documentElement.classList.contains("vt") ? 450 : 0);

function draw() {
  curInks = !NET && (S.screen === "setup" || S.screen === "join") ? S.draft.inks : S.game?.setup?.inks || null;
  try { (NET ? renderNet : { setup: renderSetup, join: renderJoin, turn: renderTurn, done: renderDone }[S.screen])(); }
  catch (e) { console.error(e); if (NET) throw e; S = fresh(S); renderSetup(); }
  save();
}

// Plays a one-off animation class again, even if the element already had it.
function replay(el, cls) {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

function fail(el, msg) {
  el.textContent = msg;
  replay(el, "shake");
}

// ---------- shared pieces ----------
// Every tap redraws the screen, so only play the entrance animation when the view is new.
// Each part of a screen tracks its own last view, so a new pick can animate the label alone.
const lastEnter = {};
const enterOnce = (part, key) => (lastEnter[part] === key ? "" : ((lastEnter[part] = key), "enter"));
// Everyone keeps one ink from setup to result, so a colour always means that person's set.
const INKS = 10;
// Inks belong to people, not to rows: removing Ben leaves Cy her own colour and typeface.
let curInks = null;
const inkNum = (i) => (curInks?.[i] ?? i) % INKS;
const ink = (i) => `p${inkNum(i)}`;
// Slots seen open before, per week and viewer, so a slot that just dropped out gets stamped.
const seenOpen = new Map();
// The count shown last, per view, so it ticks only when it changes on the same screen.
let lastCount = null;
// The cell tapped last, so only that one plays its fill.
let justTapped = null, tapAt = null;
// The week label shown before a step, so it can slide out while the new one slides in.
let stepOld = "";
// The row just added, and the way the week stepper moved, for their one-off animations.
let newRow = null, stepDir = "";
// People already shown as done, so only a newly finished one pops.
const seenDone = new Set();
// The logo circles slide together once per page load.
let logoMet = false;
const logo = () => `<span class="logo${logoMet ? "" : ((logoMet = true), " meet")}"><svg viewBox="0 0 30 20" aria-hidden="true"><circle class="s0" cx="10" cy="10" r="8.5"/><circle class="s1" cx="20" cy="10" r="8.5"/></svg>When Diagram</span>`;

// The shortest name prefix that tells each person apart, so Ann and Alex show as An and Al.
function tags(people) {
  return people.map((p) => {
    for (let len = 1; len < p.length; len++) {
      const t = p.slice(0, len).toLowerCase();
      if (people.filter((q) => q.slice(0, len).toLowerCase() === t).length === 1) return p.slice(0, len);
    }
    return p;
  });
}

// `live` lists who else has ticked each slot so far, for own-phone mode.
function gridHtml(g, w, viewer, editable, live = false) {
  const n = g.setup.slots.length, open = openFor(g, w, viewer), mine = picks(g, w, viewer);
  const others = live ? g.setup.people.map((_, p) => p).filter((p) => p !== viewer).map((p) => [p, picks(g, w, p)]) : [];
  const tag = tags(g.setup.people);
  const key = `${w} ${viewer} ${S.screen}`, before = seenOpen.get(key);
  seenOpen.set(key, open);
  let stamps = 0;
  let out = `<div></div>` + g.setup.slots.map((s) => `<div class="head">${h(s)}</div>`).join("");
  for (let day = 0; day < 7; day++) {
    const d = addDays(g.setup.start, 7 * w + day), wk = d.getDay() === 0 || d.getDay() === 6;
    out += `<div class="day ${wk ? "weekend" : ""}">${d.toLocaleDateString(t("locale"), { weekday: "short" })}<span>${d.toLocaleDateString(t("locale"), { day: "numeric", month: "short" })}</span></div>`;
    for (let s = 0; s < n; s++) {
      const idx = day * n + s;
      if (isPast(g, w, idx)) {
        out += `<button class="cell past" disabled aria-label="${h(`${g.setup.slots[s]}, ${t("past")}`)}"></button>`;
        continue;
      }
      const yes = mine.has(idx), x = !open.has(idx), out_ = x && (!before || before.has(idx));
      const who = others.filter(([, set]) => set.has(idx)).map(([p]) => p);
      const ini = who.length ? `<span class="ini">${who.map((p) => `<b class="${ink(p)}">${h(tag[p])}</b>`).join(" ")}</span>` : "";
      const label = `${g.setup.slots[s]}${x ? t("cellX") : ""}${who.length ? t("cellWho", list(who.map((p) => g.setup.people[p])), who.length) : ""}`;
      out += `<button class="cell ${yes ? "yes" : ""} ${x ? "x" : ""} ${out_ ? "out" : ""} ${idx === justTapped ? "pop" : ""}" style="${out_ ? `--s:${stamps++};` : ""}${idx === justTapped && tapAt ? `--px:${tapAt[0]}%;--py:${tapAt[1]}%` : ""}" data-idx="${idx}" aria-pressed="${yes}" ${editable ? "" : "disabled"} aria-label="${h(label)}">${x ? "×" : yes ? `<span class="tick">✓</span>` : ""}${ini}</button>`;
    }
  }
  return `<div class="week ${ink(viewer)}" style="grid-template-columns: 4.2em repeat(${n}, minmax(0, 1fr)); --b:${settle()}ms">${out}</div>`;
}

function bindGrid(g, w, viewer) {
  app.querySelectorAll(".cell[data-idx]").forEach((b) => b.onclick = (e) => {
    const idx = +b.dataset.idx, mine = picks(g, w, viewer);
    // The fill grows from where the finger landed; a keyboard press starts it in the middle.
    const box = b.getBoundingClientRect();
    tapAt = e.detail ? [((e.clientX - box.left) / box.width) * 100, ((e.clientY - box.top) / box.height) * 100].map((v) => Math.round(Math.min(100, Math.max(0, v)))) : [50, 50];
    mine.has(idx) ? mine.delete(idx) : mine.add(idx);
    setRec(g, w, viewer, { cells: [...mine].sort((a, b) => a - b) });
    justTapped = idx; render(); justTapped = null; broadcast();
  });
}

function countHtml(view, left, total, suffix) {
  const dir = lastCount?.view === view && lastCount.left !== left ? (left < lastCount.left ? "down" : "up") : "";
  lastCount = { view, left };
  return `<div class="count">${t("left", left, total).replace("<b>", `<b class="${dir}">`)}${suffix}</div>`;
}

// What still works for everyone once `viewer` commits their current picks.
function leftAfter(g, w, viewer) {
  const open = openFor(g, w, viewer), mine = picks(g, w, viewer);
  return [...open].filter((c) => mine.has(c)).length;
}

function chipsHtml(g, w, current) {
  return `<div class="chips">${g.setup.people.map((p, i) => {
    const done = !!recOf(g, w, i)?.done, key = `${w}:${i}`, fresh = done && !seenDone.has(key);
    if (done) seenDone.add(key); else seenDone.delete(key);
    return `<span class="chip ${ink(i)} ${done ? "ok" : i === current ? "now" : ""} ${fresh ? "pop" : ""}">${h(p)}</span>`;
  }).join("")}</div>`;
}

function rolledNotice(g, w) {
  return w > 0 && weekInfo(g, w).done.length === 0
    ? `<div class="notice ${enterOnce("notice", `rolled ${w}`)}">${t("rolled", fmtRange(g.setup.start, w - 1))}</div>` : "";
}

function bindTwoTap(id, label, action) {
  const b = document.getElementById(id);
  b.onclick = () => {
    if (b.dataset.armed) return action();
    b.dataset.armed = "1"; b.textContent = t("confirm"); b.style.color = "var(--accent)";
    setTimeout(() => { if (b.isConnected) { delete b.dataset.armed; b.textContent = label; b.style.color = ""; } }, 3000);
  };
}

// ---------- setup ----------
// Where every movable part of the form sits before a row comes or goes. Rows after a removed one
// are filed under the index they will have afterwards, so each one finds itself again.
function flipTops(list, removed) {
  const tops = new Map();
  app.querySelectorAll("[data-flip]").forEach((el) => {
    let key = el.dataset.flip;
    const m = key.match(/^(people|slots)-(\d+)$/);
    if (m && m[1] === list && removed >= 0) {
      if (+m[2] === removed) return;
      if (+m[2] > removed) key = `${list}-${+m[2] - 1}`;
    }
    tops.set(key, el.getBoundingClientRect().top);
  });
  return tops;
}

// Slides each part from where it was to where it is now.
function flipPlay(tops) {
  if (calm.matches) return;
  app.querySelectorAll("[data-flip]").forEach((el) => {
    const before = tops.get(el.dataset.flip);
    const dy = before == null ? 0 : before - el.getBoundingClientRect().top;
    if (Math.abs(dy) > 0.5) el.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: 380, easing: "cubic-bezier(0.2, 1.25, 0.4, 1)" });
  });
}

// A new person gets the first ink nobody in the list has.
const freeInk = (inks) => { for (let k = 0; k < INKS; k++) if (!inks.includes(k)) return k; return inks.length % INKS; };

function renderSetup() {
  const D = S.draft;
  if (!Array.isArray(D.inks) || D.inks.length !== D.people.length) D.inks = D.people.map((_, i) => D.inks?.[i] ?? i);
  curInks = D.inks;
  const pushRow = (k) => { D[k].push(""); if (k === "people") D.inks.push(freeInk(D.inks)); };
  // The × buttons stay out of the tab order, so Tab and the keyboard's next key go name to name.
  const listRows = (key, ph) => D[key].map((v, i) => `
    <div class="row ${key === "people" ? `named ${ink(i)}` : ""} ${newRow === `${key}-${i}` ? "new" : ""}" data-flip="${key}-${i}">
      <span class="num">${i + 1}</span>
      <input id="${key}-${i}" data-key="${key}" data-i="${i}" value="${h(v)}" placeholder="${ph}" autocomplete="off" enterkeyhint="next">
      <button type="button" class="icon-btn" data-del="${key}" data-i="${i}" tabindex="-1" aria-label="${t("remove")}">×</button>
    </div>`).join("");
  const ahead = Math.round((parseIso(D.start) - parseIso(mondayOf(today()))) / (7 * 864e5));
  const tag = ahead === 0 ? t("thisWeek") : ahead === 1 ? t("nextWeek") : t("inWeeks", ahead);
  app.innerHTML = `
    <div class="brand">${logo()} <span class="bar"><button type="button" class="lang" id="lang">${t("other").toUpperCase()}</button><button type="button" id="to-join">${t("join")}</button></span></div>
    <form class="setup" id="setup" novalidate>
      <fieldset>
        <span class="label">${t("people")}</span>
        ${listRows("people", t("name"))}
        <button type="button" class="ghost" data-add="people" data-flip="add-people">${t("addPerson")}</button>
      </fieldset>
      <fieldset>
        <span class="label" data-flip="label-slots">${t("slots")}</span>
        ${listRows("slots", t("slotExample"))}
        <button type="button" class="ghost" data-add="slots" data-flip="add-slots">${t("addSlot")}</button>
      </fieldset>
      <fieldset>
        <span class="label" data-flip="label-week">${t("week")}</span>
        <div class="stepper" data-flip="week">
          <button type="button" id="wk-prev" aria-label="${t("earlier")}" ${ahead <= 0 ? "disabled" : ""}>‹</button>
          <div class="wk-track"><span class="wk ${stepDir}">${fmtRange(D.start, 0)}${tag ? ` <small>${tag}</small>` : ""}</span>${stepDir ? `<span class="wk-old ${stepDir}" aria-hidden="true">${stepOld}</span>` : ""}</div>
          <button type="button" id="wk-next" aria-label="${t("later")}">›</button>
        </div>
      </fieldset>
      <div class="error" id="err"></div>
      <button type="submit" class="primary" data-flip="start">${t("start")}</button>
    </form>`;

  app.querySelectorAll("input[data-key]").forEach((el) => {
    el.addEventListener("input", () => {
      D[el.dataset.key][+el.dataset.i] = el.value; save();
    });
    // Enter moves to the next row. On the last filled row it adds one.
    el.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const k = el.dataset.key, i = +el.dataset.i;
      if (i < D[k].length - 1) return document.getElementById(`${k}-${i + 1}`).focus();
      if (el.value.trim()) { pushRow(k); newRow = `${k}-${i + 1}`; render(); newRow = null; return document.getElementById(`${k}-${i + 1}`).focus(); }
      if (k === "people") return document.getElementById("slots-0").focus();
      el.blur();
    });
  });
  // Removing a row: the name squeezes back into its circle, the circle pops like a set leaving
  // the diagram, and everything below slides up into the gap.
  app.querySelectorAll("[data-del]").forEach((b) => b.onclick = () => {
    const k = b.dataset.del, i = +b.dataset.i, row = b.closest(".row");
    const drop = () => {
      const tops = flipTops(k, i);
      if (D[k].length > 1) { D[k].splice(i, 1); if (k === "people") D.inks.splice(i, 1); } else D[k][0] = "";
      render(); flipPlay(tops);
    };
    if (calm.matches || D[k].length <= 1) return drop();
    // The next row's × would slide under the finger, so they all wait until this row is gone.
    app.querySelectorAll("[data-del]").forEach((x) => { x.disabled = true; });
    row.classList.add("leaving");
    row.querySelector(".num").addEventListener("animationend", drop, { once: true });
  });
  app.querySelectorAll("[data-add]").forEach((b) => b.onclick = () => {
    const k = b.dataset.add, tops = flipTops(k, -1);
    pushRow(k); newRow = `${k}-${D[k].length - 1}`; render(); newRow = null; flipPlay(tops);
    document.getElementById(`${k}-${D[k].length - 1}`).focus();
  });
  const step = (days, dir) => () => {
    stepOld = app.querySelector(".stepper .wk").innerHTML;
    D.start = iso(addDays(D.start, days)); stepDir = dir; render(); stepDir = "";
  };
  document.getElementById("wk-prev").onclick = step(-7, "from-left");
  document.getElementById("wk-next").onclick = step(7, "from-right");
  document.getElementById("lang").onclick = () => {
    const before = t("defaultSlots");
    LANG = t("other");
    try { localStorage.setItem("intersched.lang", LANG); } catch {}
    document.documentElement.lang = LANG;
    // Untouched default slots follow the language.
    if (D.slots.join("|") === before.join("|")) D.slots = [...t("defaultSlots")];
    render();
  };

  const validSetup = () => {
    const kept = D.people.map((p, i) => [p.trim(), D.inks[i]]).filter(([p]) => p);
    const people = kept.map(([p]) => p), inks = kept.map(([, k]) => k);
    const slots = D.slots.map((p) => p.trim()).filter(Boolean);
    const err = document.getElementById("err");
    if (people.length < 2) return fail(err, t("needPeople"));
    if (new Set(people).size !== people.length) return fail(err, t("uniqueNames"));
    if (!slots.length) return fail(err, t("needSlot"));
    D.people = people; D.inks = inks; D.slots = slots;
    return { setup: { people, inks, slots, start: D.start, ts: Date.now(), by: DEVICE }, recs: {}, claims: {} };
  };
  document.getElementById("setup").onsubmit = (e) => {
    e.preventDefault();
    const g = validSetup(); if (!g) return;
    Object.assign(S, { game: g, turn: 0, history: [], sel: null, screen: "turn" }); render();
  };
  document.getElementById("to-join").onclick = () => { S.screen = "join"; render(); };
}

function renderJoin() {
  app.innerHTML = `
    <div class="brand">${logo()} <span class="bar"><button type="button" id="cancel">${t("cancel")}</button></span></div>
    <form class="join" id="join">
      <label class="label" for="code">${t("joinWords")}</label>
      <input id="code" placeholder="${h(roomWords([817, 650, 230, 702]).join(" "))}" autocomplete="off" autocapitalize="none" spellcheck="false" enterkeyhint="go">
      <div class="error" id="join-err"></div>
      <button class="primary" type="submit">${t("join")}</button>
    </form>`;
  document.getElementById("code").focus();
  document.getElementById("cancel").onclick = () => { goBack = true; S.screen = "setup"; render(); };
  document.getElementById("join").onsubmit = (e) => {
    e.preventDefault();
    const ids = parseWords(document.getElementById("code").value);
    if (!ids) return fail(document.getElementById("join-err"), t("badWords", ROOM_WORDS));
    S.screen = "setup";
    openRoom(ids);
  };
}

// Sharing turns this phone's game into a room; picks so far carry over.
function share() {
  const g = S.game;
  openRoom(newRoom(), { setup: { ...g.setup, ts: Date.now(), by: DEVICE }, recs: g.recs, claims: {} });
}

// ---------- pass one phone ----------
function renderTurn() {
  const g = S.game, me = S.turn, w = currentWeek(g), P = g.setup.people;
  const info = weekInfo(g, w), left = leftAfter(g, w, me);
  const others = P.map((_, i) => i).filter((i) => i !== me && !recOf(g, w, i)?.done);
  const btn = left === 0 ? t("noneWork") : others.length ? t("passTo", P[nextTurn(g, w, me)]) : t("done");
  const prev = S.history.length ? JSON.parse(S.history.at(-1)).turn : null;

  app.innerHTML = `
    <div class="brand">${logo()} <span class="bar"><small>${fmtRange(g.setup.start, w)}</small><button type="button" id="share">${t("share")}</button></span></div>
    ${rolledNotice(g, w)}
    <div class="${enterOnce("who", `turn ${w} ${me}`)} ${ink(me)}">
      <div class="who">${h(P[me])}</div>
      <div class="who-sub">${t("tapHint")}</div>
    </div>
    ${gridHtml(g, w, me, true)}
    ${countHtml(`turn ${w} ${me}`, left, openFor(g, w, me).size, info.done.length ? t("andBefore") : "")}
    ${chipsHtml(g, w, me)}
    <button class="primary" id="pass">${h(btn)}</button>
    <div class="foot">
      <button id="undo" ${prev == null ? "disabled" : ""}>${prev == null ? t("back") : h(t("backTo", P[prev]))}</button>
      <button id="reset">${t("startOver")}</button>
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
  document.getElementById("share").onclick = share;
  bindTwoTap("reset", t("startOver"), () => { goBack = true; S = fresh(S); render(); });
}

function nextTurn(g, w, me) {
  const n = g.setup.people.length;
  for (let k = 1; k < n; k++) { const p = (me + k) % n; if (!recOf(g, w, p)?.done) return p; }
  return (me + 1) % n;
}

function undo() {
  const prev = S.history.pop(); if (!prev) return;
  goBack = true;
  const { recs, turn } = JSON.parse(prev);
  S.game.recs = recs; S.turn = turn; S.screen = "turn"; render();
}

// ---------- result ----------
// The result replays the session: each person's set lands in the order they finished, the
// count in the middle drops to what still works for everyone, and the last landing opens the
// shared lens with the answer in it.
const LAND = 480, HOLD = 220;
// Small groups land one set after another; bigger ones overlap so the whole replay stays under two seconds.
const gapFor = (n) => (n <= 4 ? LAND : Math.round(1500 / (n - 1)));
const landAt = (base, n) => base + (n - 1) * gapFor(n) + LAND + HOLD;

function vennHtml(people, day, slot, { fresh, freshLabel, order, counts, base }) {
  const n = people.length, c = 150, R = 92, r = n === 2 ? 44 : 52;
  // Two people sit side by side, first name on the left; more go round from the top.
  const dirs = people.map((_, i) => {
    const a = (n === 2 ? Math.PI : -Math.PI / 2) + (2 * Math.PI * i) / n;
    return [Math.cos(a), Math.sin(a)];
  });
  const xs = dirs.map(([x]) => c + r * x), ys = dirs.map(([, y]) => c + r * y), pad = 2;
  const box = [Math.min(...xs) - R - pad, Math.min(...ys) - R - pad];
  const size = [Math.max(...xs) + R + pad - box[0], Math.max(...ys) + R + pad - box[1]];
  const max = n > 6 ? 6 : 9, short = (p) => (p.length > max ? `${p.slice(0, max - 1)}…` : p);
  const rank = people.map((_, i) => order.indexOf(i));
  const land = landAt(base, n), GAP = gapFor(n);
  // Each set flies in from outside along its own direction, in finishing order.
  const at = (i) => `--i:${rank[i]};--dx:${(dirs[i][0] * 70).toFixed(1)}px;--dy:${(dirs[i][1] * 70).toFixed(1)}px`;
  const circle = (cls, i) => `<circle class="${cls} s${inkNum(i)}" style="${at(i)}" cx="${xs[i]}" cy="${ys[i]}" r="${R}"/>`;
  const fills = people.map((_, i) => circle("v-set", i)).join("");
  const lines = people.map((_, i) => circle("v-line", i)).join("");
  // The lens is the true intersection: a paper fill clipped by every circle in turn.
  const clips = people.map((_, i) => `<clipPath id="vc${i}"><circle cx="${xs[i]}" cy="${ys[i]}" r="${R}"/></clipPath>`).join("");
  const lens = people.reduceRight((inner, _, i) => `<g clip-path="url(#vc${i})">${inner}</g>`,
    `<rect class="v-lens" x="${box[0]}" y="${box[1]}" width="${size[0]}" height="${size[1]}"/>`);
  const names = people.map((p, i) => `<text class="v-name ${ink(i)}" style="--i:${rank[i]}" x="${c + (r + R * 0.6) * dirs[i][0]}" y="${c + (r + R * 0.6) * dirs[i][1]}">${h(short(p))}</text>`).join("");
  // On the last landing, dots in everyone's inks burst out of the lens.
  const bits = fresh ? Array.from({ length: 12 }, (_, k) => {
    const a = (k / 12) * 2 * Math.PI + 0.26, d = 130 + ((k * 23) % 35);
    return `<circle class="v-bit s${inkNum(k % n)}" cx="${c}" cy="${c}" r="${6 + (k % 3) * 1.5}" style="--k:${k};--tx:${(Math.cos(a) * d).toFixed(1)}px;--ty:${(Math.sin(a) * d).toFixed(1)}px"/>`;
  }).join("") : "";
  // Only counts that changed get a step, so the middle never re-pops the same number.
  const steps = counts.map((v, k) => [v, k]).filter(([v], j) => j === 0 || v !== counts[j - 1]);
  return `<svg class="venn ${fresh} ${n > 4 ? "crowd" : ""}" style="--b:${base}ms;--gap:${GAP}ms;--land:${land}ms;--crowd:${Math.min(1, 4 / n).toFixed(2)}" viewBox="${box.map((v) => v.toFixed(1)).join(" ")} ${size.map((v) => v.toFixed(1)).join(" ")}" role="img" aria-label="${h(`${list(people)}: ${day}, ${slot}`)}">
    <defs>${clips}</defs>
    ${fills}<g class="v-lens-g" style="transform-origin:${c}px ${c}px">${lens}</g>${lines}
    ${bits}${names}
    ${fresh ? steps.map(([v, k], j) => {
      // Each count shows from its landing until the next change, the last until the lens opens.
      const t0 = base + k * GAP + LAND - 60, t1 = j < steps.length - 1 ? base + steps[j + 1][1] * GAP + LAND - 60 : land;
      return `<text class="v-count" style="--t0:${t0}ms;--dur:${t1 - t0}ms" x="${c}" y="${c}">${v}</text>`;
    }).join("") : ""}
    <g class="v-label ${freshLabel}"><text class="v-day" x="${c}" y="${c - 3}">${h(day)}</text>
    <text class="v-slot" x="${c}" y="${c + 16}">${h(slot)}</text></g>
  </svg>`;
}

function doneHtml(g, w, foot) {
  const n = g.setup.slots.length, open = [...weekInfo(g, w).common].sort((a, b) => a - b);
  if (S.sel == null || !open.includes(S.sel)) S.sel = open[0];
  const label = (idx) => ({ d: fmtDay(addDays(g.setup.start, 7 * w + Math.floor(idx / n))), p: g.setup.slots[idx % n] });
  const sel = label(S.sel);
  const selDay = addDays(g.setup.start, 7 * w + Math.floor(S.sel / n)).toLocaleDateString(t("locale"), { weekday: "short", day: "numeric", month: "short" });
  const fresh = enterOnce("venn", `done ${w}`), freshLabel = enterOnce("label", `${w} ${S.sel}`);
  // Finishing order, and what still worked for everyone after each person.
  const order = g.setup.people.map((_, p) => p).sort((a, b) => (recOf(g, w, a)?.ts || 0) - (recOf(g, w, b)?.ts || 0));
  let still = null;
  const counts = order.map((p) => {
    const mine = picks(g, w, p);
    still = still ? new Set([...still].filter((c) => mine.has(c))) : mine;
    return still.size;
  });
  const base = settle(), land = landAt(base, order.length);
  const words = t("result", open.length).split(" ").map((x, i) => `<span class="w" style="--i:${i}">${x}</span>`).join(" ");
  return `
    <div class="done-head ${enterOnce("head", `done ${w}`)}" style="--b:${land}ms">${words}</div>
    ${vennHtml(g.setup.people, selDay, sel.p, { fresh, freshLabel, order, counts, base })}
    <div class="options ${fresh}" style="--land:${land}ms">${open.map((idx, i) => { const l = label(idx); return `<button class="option ${idx === S.sel ? "sel" : ""} ${idx === S.sel && freshLabel && !fresh ? "pop" : ""}" style="--i:${i}" data-opt="${idx}"><span class="d">${l.d}</span><span class="p">${h(l.p)}</span></button>`; }).join("")}</div>
    <div class="stack ${fresh}" style="--land:${land}ms">
      <button class="primary" id="copy" data-text="${h(`${sel.d}, ${sel.p.toLowerCase()}`)}">${h(t("copy", sel.d.split(" ")[0], sel.p.toLowerCase()))}</button>
      ${foot}
    </div>`;
}

function bindDone() {
  app.querySelectorAll("[data-opt]").forEach((b) => b.onclick = () => { S.sel = +b.dataset.opt; render(); });
  const copy = document.getElementById("copy");
  copy.onclick = () => {
    const text = copy.dataset.text;
    try { navigator.clipboard.writeText(text).then(() => { copy.textContent = t("copied"); replay(copy, "copied"); }, () => { copy.textContent = text; }); }
    catch { copy.textContent = text; }
  };
}

function renderDone() {
  const g = S.game, w = currentWeek(g);
  app.innerHTML = `
    <div class="brand">${logo()} <small>${w ? t("skipped", w) : fmtRange(g.setup.start, w)}</small></div>
    ${doneHtml(g, w, `<div class="foot"><button id="undo">${h(t("backTo", g.setup.people[S.turn]))}</button><button id="reset">${t("startOver")}</button></div>`)}`;
  bindDone();
  document.getElementById("undo").onclick = undo;
  bindTwoTap("reset", t("startOver"), () => { goBack = true; S = fresh(S); render(); });
}

// ---------- own phone ----------
// A room is four words; the words alone are enough to find it.
const ROOM_WORDS = 4;
// A room is four positions in the word lists; each device shows them in its own language.
const newRoom = () => Array.from(crypto.getRandomValues(new Uint32Array(ROOM_WORDS)), (n) => n % WORDS.en.length);
const parseWords = (text) => {
  const words = text.toLowerCase().match(/[a-z]+/g) || [];
  if (words.length !== ROOM_WORDS) return null;
  for (const list of Object.values(WORDS)) {
    const ids = words.map((w) => list.indexOf(w));
    if (ids.every((i) => i >= 0)) return ids;
  }
  return null;
};
const roomWords = (ids) => ids.map((i) => WORDS[LANG][i]);
const inviteUrl = () => `${location.origin}${location.pathname}#${roomWords(NET.ids).join("-")}`;

async function openRoom(ids, hostGame) {
  const key = ids.join(".");
  const saved = store.get(roomKey(key));
  NET = { key, ids, room: null, mod: null, peers: 0, error: null, secret: saved?.secret || "", invite: !!hostGame, seen: {}, notice: null };
  S.game = hostGame || saved?.game || { setup: null, recs: {} };
  S.me = saved?.me ?? null;
  S.sel = saved?.sel ?? null;
  history.replaceState(null, "", `#${roomWords(ids).join("-")}`);
  render();
  try {
    NET.mod = await import("./pkg/intersched_net.js");
    await NET.mod.default();
    NET.room = await Promise.race([
      NET.mod.Room.open(`room:${key}`, NET.secret),
      new Promise((_, no) => setTimeout(() => no(new Error(t("unreachable"))), 25000)),
    ]);
    NET.secret = NET.room.secret();
    pump(NET.room.events());
    broadcast();
    // The broadcast doubles as a heartbeat; names of phones that went quiet free up.
    setInterval(() => { broadcast(); if (S.me == null && !NET.invite) render(); }, 15000);
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
      try { const m = JSON.parse(ev.data); NET.seen[m.from] = Date.now(); merge(S.game, m.s); } catch {}
    }
    render();
  }
}

// Gossip drops repeats of identical messages, so each broadcast carries a nonce.
function broadcast() {
  if (!NET?.room || !S.game?.setup) return;
  NET.room.broadcast(JSON.stringify({ n: Math.random(), from: DEVICE, s: { setup: S.game.setup, recs: S.game.recs, claims: S.game.claims || {} } })).catch((e) => console.warn(e));
}

function peersPill() {
  if (NET.error) return `<button class="pill bad" id="retry" onclick="location.reload()">${t("offline")} ↻</button>`;
  if (!NET.room) return `<span class="pill">${t("connecting")}</span>`;
  return `<span class="pill ${NET.peers ? "live" : ""}">${NET.peers ? t("others", NET.peers) : t("alone")}</span>`;
}

// A phone holds a name while it keeps broadcasting.
const CLAIM_TIMEOUT = 45000;
function takenByOther(g, p) {
  const c = g.claims?.[p];
  return !!c?.by && c.by !== DEVICE && Date.now() - (NET.seen[c.by] || 0) < CLAIM_TIMEOUT;
}

function release() {
  if (S.me == null || !S.game?.setup) return Promise.resolve();
  setClaim(S.game, S.me, null);
  S.me = null;
  return NET.room ? NET.room.broadcast(JSON.stringify({ n: Math.random(), from: DEVICE, s: { claims: S.game.claims } })).catch(() => {}) : Promise.resolve();
}

// The invite as dots: round modules and rounded corner eyes, one per ink, so the code is a little
// Venn of its own. The eyes stay dark enough for cameras to find them.
function qrHtml(text) {
  const bits = NET.mod.qr_modules(text), n = Math.round(Math.sqrt(bits.length)), q = 3, mid = (n - 1) / 2;
  const inEye = (x, y) => (x < 7 && y < 7) || (x >= n - 7 && y < 7) || (x < 7 && y >= n - 7);
  let dots = "";
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    if (!bits[y * n + x] || inEye(x, y)) continue;
    dots += `<circle class="qr-dot" style="--d:${Math.hypot(x - mid, y - mid).toFixed(1)}" cx="${x + q + 0.5}" cy="${y + q + 0.5}" r="0.47"/>`;
  }
  const eyes = [[0, 0], [n - 7, 0], [0, n - 7]].map(([x, y], i) => `<g class="qr-eye e${i}" style="--e:${i}">
    <rect class="qr-ring" x="${x + q + 0.5}" y="${y + q + 0.5}" width="6" height="6" rx="2.2"/>
    <rect class="qr-pupil" x="${x + q + 2}" y="${y + q + 2}" width="3" height="3" rx="1.1"/></g>`).join("");
  return `<svg class="qr-code" viewBox="0 0 ${n + 2 * q} ${n + 2 * q}" role="img" aria-label="${h(text)}">${dots}${eyes}</svg>`;
}

async function leave() {
  await release();
  history.replaceState(null, "", location.pathname);
  location.reload();
}

function renderNet() {
  const g = S.game;
  const bar = (extra = "") => `<div class="brand">${logo()} <span class="bar">${extra}${peersPill()}</span></div>`;

  if (NET.invite && NET.room) {
    const url = inviteUrl();
    app.innerHTML = `
      ${bar()}
      <div class="center ${enterOnce("qr", NET.key)}">
        <div class="qr">${qrHtml(url)}</div>
        <div class="words" id="words">${h(roomWords(NET.ids).join(" "))}</div>
        <button class="secondary" id="copy-link">${t("copyLink")}</button>
      </div>
      <button class="primary" id="close">${S.me == null ? t("pickName") : t("backToWeek")}</button>`;
    document.getElementById("copy-link").onclick = (e) => {
      try { navigator.clipboard.writeText(url).then(() => { e.target.textContent = t("copied"); }); } catch {}
    };
    // Tapping the code plays its wave again.
    app.querySelector(".qr-code").onclick = (e) => replay(e.currentTarget, "wave");
    document.getElementById("close").onclick = () => { goBack = true; NET.invite = false; render(); };
    return;
  }

  if (!g.setup) {
    app.innerHTML = `
      ${bar()}
      <div class="center">
        <div class="done-head">${NET.error ? t("unreachable") : t("joining")}</div>
        <div class="hint">${NET.error ? h(NET.error) : t("waitingRoom")}</div>
      </div>
      <button class="secondary" id="leave">${NET.error ? t("retry") : t("cancel")}</button>`;
    document.getElementById("leave").onclick = NET.error ? () => location.reload() : leave;
    return;
  }

  const w = currentWeek(g), P = g.setup.people, info = weekInfo(g, w);

  // Someone else took our name, or we came back to a name that is ours again.
  if (S.me != null && S.me < P.length && g.claims?.[S.me]?.by !== DEVICE) {
    if (takenByOther(g, S.me)) { NET.notice = t("lostClaim", P[S.me]); S.me = null; }
    else { setClaim(g, S.me, DEVICE); broadcast(); }
  }

  if (S.me == null || S.me >= P.length) {
    const notice = NET.notice; NET.notice = null;
    app.innerHTML = `
      ${bar(NET.room ? `<button id="invite">${t("share")}</button>` : "")}
      ${notice ? `<div class="notice">${h(notice)}</div>` : ""}
      <div class="done-head">${t("whoAreYou")}</div>
      <div class="people">${P.map((p, i) => { const taken = takenByOther(g, i); return `<button class="person ${ink(i)}" data-me="${i}" ${taken ? "disabled" : ""}>${h(p)}${taken ? `<span>${t("takenTag")}</span>` : recOf(g, w, i)?.done ? `<span>${t("doneTag")}</span>` : ""}</button>`; }).join("")}</div>`;
    app.querySelectorAll("[data-me]").forEach((b) => b.onclick = () => {
      const p = +b.dataset.me;
      if (takenByOther(g, p)) return render();
      S.me = p; setClaim(g, p, DEVICE); render(); broadcast();
    });
    bindInvite();
    return;
  }

  const foot = `<div class="foot"><button id="not-me">${h(t("notMe", P[S.me]))}</button><button id="leave">${t("leave")}</button></div>`;

  if (info.finished) {
    app.innerHTML = `${bar(`<button id="invite">${t("share")}</button>`)}${doneHtml(g, w, foot)}`;
    bindDone(); bindInvite(); bindFoot();
    return;
  }

  const me = S.me, done = !!recOf(g, w, me)?.done, left = leftAfter(g, w, me);
  const waiting = P.filter((_, i) => i !== me && !recOf(g, w, i)?.done);
  const btn = left === 0 ? t("noneWork") : waiting.length ? t("imDone") : t("done");

  app.innerHTML = `
    ${bar(`<button id="invite">${t("share")}</button>`)}
    ${rolledNotice(g, w)}
    <div class="me-line"><span class="label">${fmtRange(g.setup.start, w)}</span></div>
    <div class="${enterOnce("who", `own ${w} ${me}`)} ${ink(me)}">
      <div class="who">${h(P[me])}</div>
      <div class="who-sub">${done ? t("picksIn") : t("tapHint")}</div>
    </div>
    ${gridHtml(g, w, me, !done, true)}
    ${countHtml(`own ${w} ${me}`, left, openFor(g, w, me).size, info.done.filter((p) => p !== me).length ? t("andDone") : "")}
    ${chipsHtml(g, w, me)}
    ${done
      ? `<div class="wait">${h(t("waitingFor", list(waiting)))}</div><button class="secondary" id="edit">${t("edit")}</button>`
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
  document.getElementById("not-me").onclick = () => { goBack = true; release(); render(); };
  bindTwoTap("leave", t("leave"), leave);
}

// ---------- boot ----------
const join = parseWords(decodeURIComponent(location.hash.slice(1)));
if (join) openRoom(join);
else render();
