// nikki-fleet panel: fleet dashboard — KPI row, router cards with live sparklines,
// the hero illustration and the notifications menu in the header.
// SPDX-License-Identifier: GPL-3.0-or-later
"use strict";

Object.assign(IC, {
  bell:'<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2.2 2.2 0 0 0 4 0"/>',
  dots:'<circle cx="12" cy="5.5" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="12" cy="18.5" r="1.4"/>',
  clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  link:'<path d="M5 12h14M13 6l6 6-6 6"/>',
  users:'<circle cx="9" cy="9" r="3.2"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0M16 6.5a3 3 0 0 1 0 6M17.5 19a5 5 0 0 0-2.3-4.2"/>',
  temp:'<path d="M10 14.5V5a2 2 0 0 1 4 0v9.5a4 4 0 1 1-4 0z"/><path d="M12 11v6"/>',
  conn:'<path d="M4 8h12l-3-3M20 16H8l3 3"/>',
  warn:'<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17h.01"/>',
});

/* ---------- formatting ---------- */
const bps = v => { // bytes/s → bits/s, compact
  if(v == null || !isFinite(v)) return "—";
  let b = v * 8; const u = ["бит/с","Кбит/с","Мбит/с","Гбит/с"]; let i = 0;
  while(b >= 1000 && i < 3){ b /= 1000; i++; }
  return (b < 10 && i ? b.toFixed(1) : Math.round(b)) + " " + u[i];
};
const pct = v => Math.max(0, Math.min(100, v));
const level = p => p >= 90 ? "bad" : p >= 70 ? "mid" : "good";
const offFor = t => { const s = (Date.now() - new Date(t)) / 1000; if(!t || isNaN(s) || s > 86400*365) return "давно"; return s < 3600 ? `${Math.max(1, Math.round(s/60))} мин` : s < 86400 ? `${Math.round(s/3600)} ч` : `${Math.round(s/86400)} дн`; };

/* ---------- sparkline: down = filled area, up = line ---------- */
function spark(samples, {w = 280, h = 54, keyA = "down", keyB = "up", cls = ""} = {}){
  const pts = (samples || []).filter(s => s[keyA] != null);
  if(pts.length < 2) return `<svg class="spark ${cls} empty" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><path d="M0 ${h-1.5}H${w}" class="base"/></svg>`;
  const max = Math.max(1, ...pts.map(s => Math.max(s[keyA] || 0, keyB ? s[keyB] || 0 : 0))) * 1.15;
  const t0 = pts[0].t, t1 = pts[pts.length-1].t, span = Math.max(1, t1 - t0);
  const xy = k => pts.map(s => [((s.t - t0) / span) * w, h - 2 - ((s[k] || 0) / max) * (h - 6)]);
  const line = a => a.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join("");
  const A = xy(keyA), last = A[A.length-1];
  return `<svg class="spark ${cls}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
    <path class="area" d="${line(A)}L${w} ${h}L0 ${h}Z"/><path class="la" d="${line(A)}"/>
    ${keyB ? `<path class="lb" d="${line(xy(keyB))}"/>` : ""}
    <circle class="dot" cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="2.6"/></svg>`;
}

/* ---------- fleet-wide numbers ---------- */
function fleetTraffic(rs){ // the routers' rates summed per 1-minute bucket (one sample per router per bucket)
  const b = new Map();
  for(const r of rs){
    const per = new Map();
    for(const s of r.spark || []) per.set(Math.round(s.t / 60) * 60, s);
    for(const [k, s] of per){ const x = b.get(k) || {t:k, down:0, up:0}; x.down += s.down || 0; x.up += s.up || 0; b.set(k, x); }
  }
  return [...b.values()].sort((a, c) => a.t - c.t);
}
const lastS = r => (r.spark || [])[(r.spark || []).length - 1];

/* ---------- notifications (derived from router status) ---------- */
function alertsOf(rs){
  const out = [];
  for(const r of rs){
    const st = statusOf(r), nk = st.nikki || {}, go = `#/r/${r.id}`;
    if(!r.online){ out.push({k:`off:${r.id}`, lvl:"bad", r, go, t:`нет связи ${offFor(r.last_seen)}`}); continue; }
    if(needsUpdate(r)) out.push({k:`upd:${r.id}:${S.latest}`, lvl:"mid", r, go:go+"/overview", t:`доступно обновление nikki-fleet ${S.latest}`});
    if(st.nikki && nk.enabled && !nk.running) out.push({k:`nk:${r.id}`, lvl:"bad", r, go, t:"Nikki остановлен"});
    else if(st.mihomo && !st.mihomo.reachable && nk.running) out.push({k:`mh:${r.id}`, lvl:"bad", r, go:go+"/logs", t:"mihomo не отвечает"});
    if(st.flash?.free_kb != null && st.flash.free_kb < 3072) out.push({k:`fl:${r.id}`, lvl:"mid", r, go:go+"/overview", t:`мало места на флеше: ${bytes(st.flash.free_kb*1024)}`});
    for(const p of st.providers || []){
      const s = p.sub; if(!s) continue;
      const days = s.Expire ? (s.Expire*1000 - Date.now()) / 864e5 : null;
      if(days != null && days < 7) out.push({k:`exp:${r.id}:${p.name}:${s.Expire}`, lvl: days < 2 ? "bad" : "mid", r, go:go+"/proxies", t: days <= 0 ? `подписка ${p.name} истекла` : `подписка ${p.name} истекает через ${Math.max(1, Math.round(days))} дн`});
      if(s.Total && (s.Upload + s.Download) / s.Total > 0.9) out.push({k:`q:${r.id}:${p.name}`, lvl:"mid", r, go:go+"/proxies", t:`подписка ${p.name}: израсходовано ${Math.round((s.Upload + s.Download) / s.Total * 100)}% трафика`});
      if(p.count && !p.alive) out.push({k:`dead:${r.id}:${p.name}`, lvl:"mid", r, go:go+"/proxies", t:`подписка ${p.name}: нет живых узлов`});
    }
  }
  return out;
}
const seenGet = () => { try{ return new Set(JSON.parse(localStorage.getItem("nf.seen") || "[]")); }catch(e){ return new Set(); } };
const seenSet = s => { try{ localStorage.setItem("nf.seen", JSON.stringify([...s].slice(-300))); }catch(e){} };
function drawBell(){
  const b = $("#bell"); if(!b) return;
  const al = alertsOf(S.routers || []), seen = seenGet(), fresh = al.filter(a => !seen.has(a.k)).length;
  b.querySelector(".bdg").textContent = fresh || "";
  b.querySelector(".bdg").hidden = !fresh;
  b.classList.toggle("has", al.length > 0);
  b.title = al.length ? `Уведомления: ${al.length}` : "Уведомлений нет";
  const m = $("#bellMenu");
  if(m) m.innerHTML = `<div class="nm-h"><b>Уведомления</b><span class="muted small">${al.length ? al.length : "всё спокойно"}</span></div>
    ${al.length ? al.map(a => `<a class="nm-i ${a.lvl}${seen.has(a.k) ? "" : " new"}" href="${a.go}"><i></i><span><b>${esc(a.r.name)}</b>${esc(a.t)}</span></a>`).join("")
      : `<div class="nm-empty">${icon("on")}<span>Все роутеры на связи, обновлений и проблем нет</span></div>`}`;
}
function netState(ok){
  const n = $("#netState"); if(!n) return;
  n.className = "net " + (ok ? "ok" : "bad");
  n.title = ok ? "Связь с панелью есть" : "Нет связи с панелью — проверьте интернет";
  n.querySelector("span").textContent = ok ? "онлайн" : "нет связи";
}
document.addEventListener("click", e => {
  const b = e.target.closest("#bell"), m = $("#bellMenu");
  if(b){
    e.preventDefault();
    const open = m.hidden; m.hidden = !open; b.setAttribute("aria-expanded", open);
    if(open){ drawBell(); const s = seenGet(); alertsOf(S.routers || []).forEach(a => s.add(a.k)); seenSet(s); setTimeout(() => { const x = $("#bell .bdg"); if(x){ x.hidden = true; } }, 400); }
    return;
  }
  if(m && !m.hidden && !e.target.closest("#bellMenu")) m.hidden = true;
  if(e.target.closest("#bellMenu a")) m.hidden = true;
});
// the header keeps the router list fresh for the bell even outside the fleet page
setInterval(async () => {
  if(!S.me || document.hidden || location.hash === "" || location.hash === "#/") return;
  try{ S.routers = await get("/api/routers"); drawBell(); }catch(e){}
}, 60000);

/* ---------- hero illustration: fleet, satellite, tower, ship ---------- */
function heroArt(){
  // isometric helper: box at (x,y) with width/depth/height
  const iso = (x, y, w, d, hgt, cls) => {
    const p = (a, b, c) => `${(x + (a - b) * 0.866).toFixed(1)},${(y + (a + b) * 0.5 - c).toFixed(1)}`;
    return `<g class="${cls}">
      <polygon class="f-l" points="${p(0,d,0)} ${p(w,d,0)} ${p(w,d,hgt)} ${p(0,d,hgt)}"/>
      <polygon class="f-r" points="${p(w,0,0)} ${p(w,d,0)} ${p(w,d,hgt)} ${p(w,0,hgt)}"/>
      <polygon class="f-t" points="${p(0,0,hgt)} ${p(w,0,hgt)} ${p(w,d,hgt)} ${p(0,d,hgt)}"/></g>`;
  };
  let grid = "";
  for(let i = -6; i <= 6; i++){
    grid += `<path d="M${300 + i*34} ${130 + i*0} l${-8*34*0.866} ${8*34*0.5}"/><path d="M${300 + i*34} ${130} l${8*34*0.866} ${8*34*0.5}"/>`;
  }
  return `<svg class="art" viewBox="0 0 600 270" role="img" aria-label="Иллюстрация: роутеры, спутник и корабль, связанные линиями данных">
    <defs>
      <linearGradient id="hgLink" x1="0" x2="1"><stop offset="0" stop-color="#5ee7f0"/><stop offset="1" stop-color="#b794ff"/></linearGradient>
      <radialGradient id="hgGlow"><stop offset="0" stop-color="#7aa2ff" stop-opacity=".55"/><stop offset="1" stop-color="#7aa2ff" stop-opacity="0"/></radialGradient>
      <linearGradient id="hgSea" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#5ee7f0" stop-opacity=".5"/><stop offset="1" stop-color="#5ee7f0" stop-opacity="0"/></linearGradient>
      <clipPath id="hgFloor"><polygon points="300,96 560,226 300,356 40,226"/></clipPath>
    </defs>
    <ellipse cx="318" cy="168" rx="190" ry="70" fill="url(#hgGlow)"/>
    <g class="grid" clip-path="url(#hgFloor)">${grid}</g>

    <!-- links: hub to nodes, satellite and tower -->
    <g class="links" fill="none">
      <path class="lk" d="M318 150 Q260 150 214 190"/>
      <path class="lk" d="M318 150 Q380 160 430 196"/>
      <path class="lk" d="M318 150 Q330 205 318 228"/>
      <path class="lk" d="M318 150 Q240 110 150 118"/>
      <path class="lk sat" d="M330 128 Q420 70 486 52"/>
      <path class="lk" d="M318 150 Q190 190 120 214"/>
    </g>

    <!-- tower with radio waves -->
    <g class="tower" transform="translate(150 60)">
      <path d="M0 80 L12 0 L24 80 M4 54 H20 M7 32 H17 M0 80 L20 54 M24 80 L4 54 M4 54 L17 32 M20 54 L7 32"/>
      <circle cx="12" cy="0" r="3.2" class="tip"/>
      <path class="wave w1" d="M-6 -8 a20 20 0 0 1 36 0"/><path class="wave w2" d="M-14 -14 a30 30 0 0 1 52 0"/><path class="wave w3" d="M-22 -20 a40 40 0 0 1 68 0"/>
    </g>

    <!-- satellite -->
    <g class="sat" transform="translate(470 22) rotate(-18)">
      <rect x="-40" y="10" width="30" height="16" rx="2" class="panel"/><rect x="26" y="10" width="30" height="16" rx="2" class="panel"/>
      <path d="M-36 18H-14M30 18H52M-28 10V26M-20 10V26M38 10V26M46 10V26" class="cells"/>
      <path d="M-10 18H0M16 18H26" class="arm"/>
      <rect x="0" y="6" width="16" height="24" rx="4" class="body"/>
      <path d="M8 30 V38" class="arm"/><circle cx="8" cy="40" r="3" class="tip"/>
    </g>
    <g class="beam"><path d="M486 66 L432 132 M486 66 L470 140" /></g>

    <!-- hub and routers -->
    ${iso(318, 116, 34, 30, 22, "box hub")}
    <g class="leds"><circle cx="300" cy="158" r="1.8"/><circle cx="307" cy="161.5" r="1.8"/><circle cx="314" cy="165" r="1.8"/></g>
    ${iso(214, 176, 20, 18, 12, "box node")}
    ${iso(430, 184, 20, 18, 12, "box node")}
    ${iso(318, 214, 20, 18, 12, "box node")}
    ${iso(150, 108, 18, 16, 10, "box node dim")}
    <g class="ants"><path d="M214 166 v-12 M430 174 v-12 M318 204 v-12"/><circle cx="214" cy="152" r="2"/><circle cx="430" cy="160" r="2"/><circle cx="318" cy="190" r="2"/></g>

    <!-- ship on the waves -->
    <g class="ship" transform="translate(70 196)">
      <path class="hull" d="M0 18 H64 L54 32 H10 Z"/>
      <path class="cabin" d="M16 18 V8 H40 V18 M22 8 V2 H34 V8"/>
      <path class="mast" d="M28 2 V-14 M20 -10 L28 -14 L36 -10"/>
      <circle cx="28" cy="-17" r="2.4" class="tip"/>
      <path class="win" d="M20 13h3M26 13h3M32 13h3"/>
    </g>
    <path class="sea" d="M20 232 q12 -6 24 0 t24 0 t24 0 t24 0 t24 0 t24 0"/><path class="sea s2" d="M36 242 q12 -6 24 0 t24 0 t24 0 t24 0 t24 0"/>

    <!-- data particles -->
    <g class="pts"><circle cx="262" cy="120" r="1.6"/><circle cx="400" cy="112" r="1.4"/><circle cx="452" cy="140" r="1.8"/><circle cx="210" cy="140" r="1.3"/><circle cx="360" cy="236" r="1.5"/><circle cx="520" cy="190" r="1.4"/><circle cx="96" cy="150" r="1.2"/></g>
  </svg>`;
}

/* ---------- KPI cards ---------- */
function kpi({label, value, sub, ic, tone, extra = ""}){
  return `<div class="kpi ${tone}"><div class="kpi-h"><span class="ind"></span><b>${label}</b><span class="kic">${icon(ic)}</span></div>
    <div class="kpi-v">${value}</div><div class="kpi-s">${sub}</div>${extra}</div>`;
}

/* ---------- router card ---------- */
function routerCard(r){
  const st = statusOf(r), b = st.board || {}, nk = st.nikki || {}, hw = st.hw || {}, s = lastS(r);
  const mem = st.memory?.total ? (1 - st.memory.available / st.memory.total) * 100 : null;
  const cpu = st.load ? (hw.cpus ? st.load[0] / hw.cpus * 100 : null) : null;
  const fl = st.flash?.total_kb ? (1 - st.flash.free_kb / st.flash.total_kb) * 100 : null;
  const ex = st.exit, chain = ex ? [ex.group, ...(ex.chain || [])].filter((x, i, a) => x && a.indexOf(x) === i) : [];
  const warns = [];
  if(needsUpdate(r)) warns.push(["mid", `обновление ${S.latest}`]);
  if(r.online && st.nikki && nk.enabled && !nk.running) warns.push(["bad", "Nikki остановлен"]);
  if(r.online && st.nikki && !nk.enabled) warns.push(["mid", "Nikki выключен"]);
  if(r.online && st.mihomo && !st.mihomo.reachable && nk.running) warns.push(["bad", "mihomo не отвечает"]);
  if(st.flash?.free_kb != null && st.flash.free_kb < 3072) warns.push(["mid", "мало места на флеше"]);
  const bar = (name, v, txt) => v == null ? "" : `<div class="mb"><span>${name}</span><div class="mt"><i class="${level(v)}" style="width:${pct(v).toFixed(1)}%"></i></div><b class="mono">${txt}</b></div>`;
  const subs = (st.providers || []).filter(p => p.count);
  return `<div class="rc ${r.online ? "on" : "off"}" data-go="#/r/${r.id}" tabindex="0" role="link" aria-label="${esc(r.name)}">
    <div class="rc-h">
      <div class="rc-t"><span class="rc-name">${esc(r.name)}</span><span class="rc-model">${esc(b.model || st.hostname || "—")}</span></div>
      ${r.online ? `<span class="badge on"><i></i>в сети</span>` : `<span class="badge off" title="последний раз ${esc(fmtDate(r.last_seen))}"><i></i>нет связи ${offFor(r.last_seen)}</span>`}
      <button class="kebab" data-menu="${esc(r.id)}" aria-label="Быстрые действия" aria-haspopup="menu">${icon("dots")}</button>
    </div>
    <div class="rc-v mono">
      ${b.release ? `<span title="OpenWrt">OpenWrt ${esc(b.release)}</span>` : ""}
      ${nk.version ? `<span title="Nikki">Nikki ${esc(String(nk.version).replace(/-r\d+$/, ""))}</span>` : ""}
      ${st.mihomo?.version ? `<span title="mihomo">mihomo ${esc(st.mihomo.version)}</span>` : ""}
      ${r.agent_version ? `<span title="nikki-fleet" class="${needsUpdate(r) ? "upd" : ""}">fleet ${esc(r.agent_version)}</span>` : ""}
    </div>
    ${chain.length ? `<div class="rc-exit">${icon("globe")}<span class="chain">${chain.map((x, i) => i === chain.length - 1 ? `<b>${fname(x)}</b>` : esc(x)).join(`<em>→</em>`)}</span>${ex.delay != null ? delay(ex.delay) : ""}</div>`
      : st.nikki ? `<div class="rc-exit muted">${icon("globe")}<span>${nk.running ? "выход ещё не определён" : "прокси не работает"}</span></div>` : ""}
    <div class="rc-tr">
      <div class="tr-n"><span class="dn">↓ <b>${r.online && s ? bps(s.down) : "—"}</b></span><span class="upl">↑ <b>${r.online && s ? bps(s.up) : "—"}</b></span><span class="muted small">${(r.spark || []).length > 1 ? "за час" : "копим данные…"}</span></div>
      ${spark(r.spark, {cls: r.online ? "" : "dead"})}
    </div>
    <div class="rc-m">
      ${bar("CPU", cpu, cpu != null ? Math.round(cpu) + "%" : "")}
      ${cpu == null && st.load ? `<div class="mb"><span>LA</span><div class="mt"><i class="${level(st.load[0]*50)}" style="width:${pct(st.load[0]*50)}%"></i></div><b class="mono">${st.load[0].toFixed(2)}</b></div>` : ""}
      ${bar("RAM", mem, mem != null ? Math.round(mem) + "%" : "")}
      ${bar("Флеш", fl, fl != null ? Math.round(fl) + "%" : "")}
    </div>
    ${subs.length ? `<div class="rc-subs">${subs.slice(0, 4).map(p => { const lv = p.alive / p.count; return `<span class="rsub ${lv > .5 ? "good" : lv > 0 ? "mid" : "bad"}" title="${esc(p.name)}: живых узлов ${p.alive} из ${p.count}${p.sub ? " · " + esc(subLine(p.sub)) : ""}"><i></i>${fname(p.name)} <b class="mono">${p.alive}/${p.count}</b></span>`; }).join("")}${subs.length > 4 ? `<span class="rsub more">+${subs.length - 4}</span>` : ""}</div>` : ""}
    <div class="rc-f mono">
      ${st.uptime ? `<span title="аптайм">${icon("clock")}${dur(st.uptime)}</span>` : ""}
      ${st.traffic ? `<span title="открытых соединений">${icon("conn")}${st.traffic.connections}</span>` : ""}
      ${hw.clients != null ? `<span title="клиентов DHCP">${icon("users")}${hw.clients}</span>` : ""}
      ${hw.temp != null ? `<span title="температура" class="${hw.temp >= 80 ? "bad" : hw.temp >= 65 ? "mid" : ""}">${icon("temp")}${Math.round(hw.temp)}°C</span>` : ""}
      ${r.role !== "owner" ? `<span title="ваша роль">${ROLE[r.role]}</span>` : ""}
    </div>
    ${warns.length ? `<div class="rc-w">${warns.map(([l, t]) => `<span class="${l}">${icon("warn")}${esc(t)}</span>`).join("")}</div>` : ""}
  </div>`;
}

// quick-actions menu of a card
document.addEventListener("click", e => {
  const k = e.target.closest(".kebab");
  const open = $("#rcMenu");
  if(k){
    e.preventDefault(); e.stopPropagation();
    if(open && open.dataset.for === k.dataset.menu){ open.remove(); return; }
    open?.remove();
    const r = (S.routers || []).find(x => x.id === k.dataset.menu); if(!r) return;
    const m = document.createElement("div");
    m.id = "rcMenu"; m.className = "menu"; m.dataset.for = r.id; m.setAttribute("role", "menu");
    const items = [["overview","Обзор"],["proxies","Прокси и узлы"],["traffic","Трафик"],["config","Конфигуратор"],["logs","Логи"],["settings","Настройки"]];
    m.innerHTML = items.map(([t, l]) => `<a role="menuitem" href="#/r/${r.id}/${t}">${l}</a>`).join("") +
      (needsUpdate(r) && r.role === "owner" ? `<a role="menuitem" class="hl" href="#/r/${r.id}/overview">Обновить nikki-fleet → ${esc(S.latest)}</a>` : "");
    document.body.append(m);
    const rc = k.getBoundingClientRect(), mw = 220;
    m.style.top = (rc.bottom + window.scrollY + 6) + "px";
    m.style.left = Math.max(8, Math.min(window.innerWidth - mw - 8, rc.right - mw)) + "px";
    return;
  }
  if(open && !e.target.closest("#rcMenu")) open.remove();
  if(e.target.closest("#rcMenu a")) open?.remove();
  const card = e.target.closest(".rc[data-go]");
  if(card && !e.target.closest("a,button")) location.hash = card.dataset.go;
});
document.addEventListener("keydown", e => {
  if(e.key === "Escape"){ $("#rcMenu")?.remove(); const m = $("#bellMenu"); if(m) m.hidden = true; }
  const c = e.target.closest?.(".rc[data-go]");
  if(c && (e.key === "Enter" || e.key === " ") && e.target === c){ e.preventDefault(); location.hash = c.dataset.go; }
});
window.addEventListener("hashchange", () => $("#rcMenu")?.remove());

/* ---------- the page ---------- */
async function renderFleet(){
  clearTimers();
  const draw = () => {
    const rs = S.routers, on = rs.filter(r => r.online).length, off = rs.length - on, upd = rs.filter(needsUpdate).length;
    const ft = fleetTraffic(rs.filter(r => r.online)), fl = ft[ft.length - 1];
    app.innerHTML = `
      <section class="fleethero">
        <div class="txt">
          <span class="eyebrow"><i></i>${rs.length ? `${on} из ${rs.length} на связи` : "панель готова"}</span>
          <h1>Fleet</h1>
          <p>Роутеры с Nikki + клиенты: статус, прокси-группы, трафик и конфиг — удалённо, без белого IP.</p>
          <button class="glow" id="addRouter"><span>+</span> Подключить роутер</button>
        </div>
        ${heroArt()}
      </section>
      ${rs.length ? `<div class="kpis">
        ${kpi({label:"Роутеров", value:rs.length, sub:"всего в панели", ic:"router", tone:"blue",
          extra:`<div class="seg2" title="в сети ${on}, не в сети ${off}"><i class="on" style="flex:${on}"></i><i class="off" style="flex:${off}"></i></div>`})}
        ${kpi({label:"В сети", value:on, sub: on ? `активно${fl ? ` · ↓ ${bps(fl.down)}` : ""}` : "никого", ic:"on", tone:"green" + (on ? " pulse" : ""),
          extra: spark(ft, {w:220, h:30, cls:"mini"})})}
        ${kpi({label:"Не в сети", value:off, sub: off ? `нет связи — агент не подключён` : "все на связи", ic:"off", tone: off ? "red" : "muted",
          extra: off ? `<div class="kpi-l">${rs.filter(r => !r.online).slice(0, 3).map(r => `<a href="#/r/${r.id}">${esc(r.name)}</a> <span>${offFor(r.last_seen)}</span>`).join("")}</div>` : ""})}
        ${kpi({label:"Обновления", value:upd, sub: upd ? `доступна ${esc(S.latest)} · ${upd} шт` : S.latest ? `всё актуально · ${esc(S.latest)}` : "проверяем…", ic:"up", tone: upd ? "amber" : "muted"})}
      </div>
      <div class="sechead"><h2>Роутеры</h2><span class="muted small">обновляется каждые 15 с · данные агентов раз в минуту</span></div>
      <div class="rgrid">${rs.map(routerCard).join("")}</div>` : `
      <div class="panel empty">
        <h2>Подключите первый роутер</h2>
        <ol>
          <li>Нажмите «Подключить роутер» и скопируйте команду.</li>
          <li>Выполните её в SSH на роутере с OpenWrt 24.10 или 25.12. Если <a href="https://github.com/nikkinikki-org/OpenWrt-nikki" target="_blank" rel="noopener">Nikki</a> ещё нет, команда установит и его. Роутер появится здесь через несколько секунд.</li>
        </ol>
        <button class="primary" id="addRouter2">Подключить роутер</button>
      </div>`}`;
    drawBell();
  };
  try{ S.routers = await get("/api/routers"); }catch(e){ return handleErr(e); }
  draw();
  latestFleet().then(v => { if(v && v !== S.latest){ S.latest = v; if(location.hash === "#/" || !location.hash) draw(); } });
  every(15000, async () => {
    if(document.hidden || $("#rcMenu")) return;
    try{ S.routers = await get("/api/routers"); if(location.hash === "#/" || location.hash === "") draw(); }catch(e){}
  });
}
