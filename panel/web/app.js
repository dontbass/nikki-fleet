// nikki-fleet panel UI (no build step, no dependencies)
// SPDX-License-Identifier: GPL-3.0-or-later
"use strict";

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
const app = $("#app");
const S = {me:null, info:null, routers:[], router:null, tab:"overview", timers:[], live:null};

/* ---------- API ---------- */
async function req(method, path, body){
  const r = await fetch(path, {method, headers:{"X-NF":"1", ...(body!==undefined?{"Content-Type":"application/json"}:{})},
    body: body!==undefined ? JSON.stringify(body) : undefined, credentials:"same-origin", cache:"no-store"});
  let j = null; try{ j = await r.json(); }catch(e){}
  if(!r.ok){ const e = new Error(j?.error || ("HTTP " + r.status)); e.status = r.status; throw e; }
  return j;
}
const get = p => req("GET", p), post = (p,b) => req("POST", p, b ?? {}), patch = (p,b) => req("PATCH", p, b), del = p => req("DELETE", p);

// Run a command on a router through its agent. Returns the agent's data object.
async function cmd(id, type, args){
  const res = await post(`/api/routers/${id}/cmd`, {type, args});
  if(res.data !== undefined && res.data !== null) return res.data;
  if(!res.ok) throw new Error(res.error || "команда не выполнена");
  return {ok:true};
}

/* ---------- helpers ---------- */
let tt;
function flash(msg, err){ const t = $("#toast"); t.textContent = msg; t.className = err ? "err" : ""; clearTimeout(tt); tt = setTimeout(()=>t.textContent = "", 4000); }
function ago(t){
  if(!t) return "—"; const d = new Date(t); if(isNaN(d) || d.getFullYear()<2000) return "—";
  const s = Math.round((Date.now()-d)/1000);
  if(s < 60) return "только что"; if(s < 3600) return `${Math.round(s/60)} мин назад`; if(s < 86400) return `${Math.round(s/3600)} ч назад`;
  return d.toLocaleString("ru-RU", {day:"numeric", month:"short", hour:"2-digit", minute:"2-digit"});
}
const fmtDate = t => t ? new Date(t).toLocaleString("ru-RU", {day:"numeric", month:"short", year:"numeric", hour:"2-digit", minute:"2-digit"}) : "—";
const bytes = b => { if(b == null) return "—"; const u = ["Б","КБ","МБ","ГБ","ТБ"]; let i = 0; b = +b; while(b >= 1024 && i < 4){ b /= 1024; i++; } return (i ? b.toFixed(b < 10 ? 1 : 0) : b) + " " + u[i]; };
const dur = s => { s = +s || 0; const d = Math.floor(s/86400), h = Math.floor(s%86400/3600), m = Math.floor(s%3600/60); return d ? `${d} д ${h} ч` : h ? `${h} ч ${m} мин` : `${m} мин`; };
const delay = d => d == null ? "" : !d ? `<span class="dl bad">таймаут</span>` : `<span class="dl ${d<300?"good":d<800?"mid":"bad"}">${d} мс</span>`;
const ROLE = {owner:"владелец", editor:"редактор", viewer:"просмотр"};
const GT = {Selector:"ручной выбор", URLTest:"самый быстрый", Fallback:"первый живой", LoadBalance:"балансировка", Relay:"цепочка"};
function statusOf(r){ try{ return typeof r.status === "string" ? JSON.parse(r.status) : (r.status || {}); }catch(e){ return {}; } }
function subLine(sub){
  if(!sub) return "";
  const used = (sub.Upload||0) + (sub.Download||0), parts = [];
  if(sub.Total) parts.push(`${bytes(used)} из ${bytes(sub.Total)}`); else if(used) parts.push(bytes(used));
  if(sub.Expire) parts.push("до " + new Date(sub.Expire*1000).toLocaleDateString("ru-RU"));
  return parts.join(" · ");
}
/* ---------- nikki-fleet updates ---------- */
function vcmp(a, b){
  const pa = String(a||"").replace(/^v/,"").split(/[.-]/).map(x => parseInt(x)||0), pb = String(b||"").replace(/^v/,"").split(/[.-]/).map(x => parseInt(x)||0);
  for(let i = 0; i < Math.max(pa.length, pb.length); i++){ const d = (pa[i]||0) - (pb[i]||0); if(d) return d < 0 ? -1 : 1; }
  return 0;
}
let latestP = null, latestAt = 0;
function latestFleet(){
  if(!latestP || Date.now() - latestAt > 10*60*1000){ latestAt = Date.now(); latestP = get("/api/fleet/latest").then(d => d.version).catch(() => { latestP = null; return null; }); }
  return latestP;
}
S.latest = null;
const needsUpdate = r => S.latest && r.agent_version && /^\d/.test(r.agent_version) && vcmp(r.agent_version, S.latest) < 0;

function updateDialog(r){
  const target = S.latest;
  openDialog(`<h2>Обновление nikki-fleet на «${esc(r.name)}»</h2>
    <div class="small muted">${esc(r.agent_version || "?")} → <b>${esc(target || "последняя")}</b>. Роутер скачает пакеты (с GitHub или через эту панель) и обновит их. Nikki, mihomo и профили не меняются, интернет не прерывается. Агент перезапустится — роутер на несколько секунд пропадёт из панели.</div>
    <div class="note small" id="updState">Запускаю…</div>
    <pre class="code" id="updLog" style="max-height:40vh">…</pre>
    <div class="row end"><button data-close>Закрыть</button></div>`, async () => {
    const st = (t, cls) => { const e = $("#updState"); if(e){ e.textContent = t; e.className = "note small " + (cls||""); } };
    try{
      const d = await cmd(r.id, "fleet.update");
      if(!d.ok) return st(d.error || "Не удалось запустить обновление", "err");
      st(d.running ? "Обновление уже идёт…" : "Обновление идёт…");
    }catch(e){ return st(e.message, "err"); }
    const t0 = Date.now();
    dlg._timer = setInterval(async () => {
      if(!$("#updLog")) return clearInterval(dlg._timer);
      let rr = null; try{ rr = await get("/api/routers/" + r.id); }catch(e){}
      try{ const l = await cmd(r.id, "logs.tail", {which:"update", lines:60}); if(l.content){ const o = $("#updLog"); o.textContent = l.content; o.scrollTop = o.scrollHeight; } }catch(e){}
      if(rr && target && rr.online && vcmp(rr.agent_version, target) >= 0){
        clearInterval(dlg._timer); st(`Готово: nikki-fleet ${rr.agent_version}`, "ok");
        if(S.router?.id === r.id){ S.router = rr; drawOverview(); }
      }else if(Date.now() - t0 > 5*60*1000){ clearInterval(dlg._timer); st("Обновление не завершилось за 5 минут — смотрите журнал выше", "err"); }
    }, 4000);
  });
}

function clearTimers(){ S.timers.forEach(clearInterval); S.timers = []; }
function every(ms, fn){ S.timers.push(setInterval(fn, ms)); }

/* ---------- icons ---------- */
const IC = {
  power:'<path d="M12 3v8"/><path d="M6.4 6.4a8 8 0 1 0 11.2 0"/>',
  globe:'<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/>',
  swap:'<path d="M7 4v14M7 18l-3-3M7 18l3-3M17 20V6M17 6l-3 3M17 6l3 3"/>',
  chip:'<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
  router:'<rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 16.5h.01M11 16.5h.01M8 9.5a5.5 5.5 0 0 1 8 0M5.5 7a9 9 0 0 1 13 0"/>',
  on:'<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  off:'<path d="M12 8v5M12 16.5h.01"/><circle cx="12" cy="12" r="9"/>',
  up:'<path d="M12 19V5M5 12l7-7 7 7"/>',
  sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon:'<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  auto:'<circle cx="12" cy="12" r="9"/><path d="M12 3v18" /><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor"/>',
};
const icon = (k, cls) => `<svg viewBox="0 0 24 24" aria-hidden="true" class="${cls||""}">${IC[k]}</svg>`;
function stat(label, value, detail, ic, grad){
  return `<div class="stat"><b>${label}</b><span class="v">${value}</span><span class="ic ${grad}">${icon(ic)}</span>${detail != null ? `<span class="d">${detail}</span>` : ""}</div>`;
}

/* ---------- theme: auto / light / dark ---------- */
function themeGet(){ try{ return localStorage.getItem("nf.theme") || "auto"; }catch(e){ return "auto"; } }
function themeApply(t){
  const el = document.documentElement;
  if(t === "light" || t === "dark") el.dataset.theme = t; else delete el.dataset.theme;
  const f = document.querySelector("iframe.frame");
  try{ if(f?.contentDocument){ const r = f.contentDocument.documentElement; if(el.dataset.theme) r.dataset.theme = el.dataset.theme; else delete r.dataset.theme; } }catch(e){}
}
document.addEventListener("click", e => {
  const b = e.target.closest("#themeBtn"); if(!b) return;
  const order = ["auto","light","dark"], t = order[(order.indexOf(themeGet()) + 1) % 3];
  try{ localStorage.setItem("nf.theme", t); }catch(err){}
  themeApply(t); renderNav();
});

/* ---------- dialog ---------- */
const dlg = $("#dlg");
function openDialog(html, onMount){ $("#dlgBody").innerHTML = html; dlg.showModal(); onMount && onMount($("#dlgBody")); }
dlg.addEventListener("click", e => { if(e.target.closest("[data-close]")) dlg.close(); });
dlg.addEventListener("close", () => { clearInterval(dlg._timer); });

async function copy(text){
  try{ await navigator.clipboard.writeText(text); flash("Скопировано"); }
  catch(e){ flash("Скопируйте вручную: выделите текст", true); }
}

/* ---------- top nav ---------- */
function renderNav(){
  const n = $("#topnav");
  if(!S.me){ n.innerHTML = ""; return; }
  const t = themeGet(), tl = {auto:"Тема: как в системе", light:"Тема: светлая", dark:"Тема: тёмная"}[t];
  n.innerHTML = `<button class="ghost" id="themeBtn" title="${tl}" aria-label="${tl}">${icon(t==="auto" ? "auto" : t==="light" ? "sun" : "moon", "ti")}</button><a class="btn ghost" href="#/account">${esc(S.me.username)}${S.me.is_admin ? " · админ" : ""}</a><button class="ghost" id="logout">Выйти</button>`;
}
document.addEventListener("click", async e => {
  if(e.target.closest("#logout")){ await post("/api/auth/logout"); S.me = null; location.hash = "#/"; boot(); }
});

/* ---------- auth ---------- */
function renderAuth(){
  const first = S.info?.first_user, canReg = S.info?.registration;
  let mode = first ? "register" : "login";
  const draw = () => {
    app.innerHTML = `<div class="auth"><img class="brandlogo only-light" src="logo.webp" alt="nikki-fleet" width="720" height="431"><img class="brandlogo only-dark" src="logo-dark.webp" alt="nikki-fleet" width="720" height="431"><form class="panel" id="authForm">
      <h1>${mode==="register" ? (first ? "Создайте учётную запись администратора" : "Регистрация") : "Вход в nikki-fleet"}</h1>
      ${first ? `<div class="note">Это первый запуск панели. Первая учётная запись получает права администратора.</div>` : ""}
      <label class="f"><span>Имя пользователя</span><input id="au" autocomplete="username" required minlength="3" maxlength="64"></label>
      <label class="f"><span>Пароль</span><input id="ap" type="password" autocomplete="${mode==="register"?"new-password":"current-password"}" required minlength="8"></label>
      <div class="err small" id="aerr"></div>
      <button class="primary" type="submit">${mode==="register" ? "Создать и войти" : "Войти"}</button>
      ${!first && canReg ? `<button type="button" class="ghost" id="aswitch">${mode==="register" ? "У меня есть учётная запись" : "Зарегистрироваться"}</button>` : ""}
    </form></div>`;
    $("#au").focus();
    $("#aswitch")?.addEventListener("click", () => { mode = mode==="register" ? "login" : "register"; draw(); });
    $("#authForm").addEventListener("submit", async e => {
      e.preventDefault();
      try{
        S.me = await post(mode==="register" ? "/api/auth/register" : "/api/auth/login", {username:$("#au").value.trim(), password:$("#ap").value});
        boot();
      }catch(err){ $("#aerr").textContent = err.message; }
    });
  };
  draw();
}

/* ---------- fleet list ---------- */
function routerCard(r){
  const st = statusOf(r), b = st.board || {}, nk = st.nikki || {};
  const subs = (st.providers || []).filter(p => p.sub || p.count).slice(0, 4);
  return `<a class="card ${r.online ? "on" : "off"}" href="#/r/${r.id}">
    <div class="spread"><span class="name">${esc(r.name)}</span>${r.online ? `<span class="pill on">в сети</span>` : `<span class="pill off">не в сети · ${ago(r.last_seen)}</span>`}</div>
    <div class="meta">
      ${b.model ? `<span>${esc(b.model)}</span>` : ""}${b.release ? `<span>OpenWrt ${esc(b.release)}</span>` : ""}
      ${st.mihomo?.version ? `<span>mihomo ${esc(st.mihomo.version)}</span>` : ""}
      ${st.uptime ? `<span>аптайм ${dur(st.uptime)}</span>` : ""}
    </div>
    <div class="meta">
      ${nk.profile?.name ? `<span>профиль ${esc(nk.profile.name)}</span>` : ""}
      ${st.nikki ? (nk.running ? `<span class="ok">Nikki работает</span>` : `<span class="err">Nikki остановлен</span>`) : `<span>статус ещё не получен</span>`}
      ${r.role !== "owner" ? `<span>${ROLE[r.role]} · владелец ${esc(r.owner)}</span>` : ""}
      ${needsUpdate(r) ? `<span class="pill warn">есть обновление ${esc(S.latest)}</span>` : ""}
    </div>
    ${subs.length ? `<div class="subs">${subs.map(p => {
      const used = p.sub ? (p.sub.Upload||0)+(p.sub.Download||0) : 0, pct = p.sub?.Total ? Math.min(100, used/p.sub.Total*100) : 0;
      return `<div class="s"><span>${fname(p.name)} <span class="muted">${p.alive}/${p.count}</span></span><span>${esc(subLine(p.sub))}</span></div>${p.sub?.Total ? `<div class="bar"><i class="${pct>85?"hi":""}" style="width:${pct.toFixed(1)}%"></i></div>` : ""}`;
    }).join("")}</div>` : ""}
  </a>`;
}
async function renderFleet(){
  clearTimers();
  const draw = () => {
    const rs = S.routers, on = rs.filter(r => r.online).length;
    app.innerHTML = `
      <div class="fleethero"><div class="txt"><h1>Fleet</h1><p>Роутеры с Nikki + mihomo: статус, прокси-группы, трафик и конфиг — удалённо, без белого IP.</p>
        <button class="primary" id="addRouter">+ Подключить роутер</button></div><img class="art" src="art.webp" alt="" width="560" height="265"></div>
      ${rs.length ? `<div class="fleetstats">
        ${stat("Роутеров", rs.length, "всего в панели", "router", "g-main")}
        ${stat("В сети", on, on === rs.length ? "все на связи" : "", "on", "g-ok")}
        ${stat("Не в сети", rs.length - on, rs.length - on ? "агент не подключён" : "нет таких", "off", rs.length - on ? "g-warn" : "g-info")}
        ${stat("Обновления", rs.filter(needsUpdate).length, S.latest ? `последняя ${esc(S.latest)}` : "", "up", rs.some(needsUpdate) ? "g-amber" : "g-info")}
      </div>` : ""}
      ${rs.length ? `<div class="grid">${rs.map(routerCard).join("")}</div>` : `
      <div class="panel empty">
        <h2>Подключите первый роутер</h2>
        <ol>
          <li>Нажмите «Подключить роутер» и скопируйте команду.</li>
          <li>Выполните её в SSH на роутере с OpenWrt 24.10 или 25.12. Если <a href="https://github.com/nikkinikki-org/OpenWrt-nikki" target="_blank" rel="noopener">Nikki</a> ещё нет, команда установит и его. Роутер появится здесь через несколько секунд.</li>
        </ol>
        <button class="primary" id="addRouter2">Подключить роутер</button>
      </div>`}`;
  };
  try{ S.routers = await get("/api/routers"); }catch(e){ return handleErr(e); }
  draw();
  latestFleet().then(v => { if(v && v !== S.latest){ S.latest = v; if(location.hash==="#/"||!location.hash) draw(); } });
  every(15000, async () => { try{ S.routers = await get("/api/routers"); if(location.hash==="#/" || location.hash==="") draw(); }catch(e){} });
}
document.addEventListener("click", e => { if(e.target.closest("#addRouter,#addRouter2")) addRouterDialog(); });

function addRouterDialog(){
  openDialog(`<h2>Подключить роутер</h2>
    <label class="f"><span>Название (необязательно)</span><input id="rn" placeholder="например, Дача или Офис"></label>
    <div class="row end"><button data-close>Отмена</button><button class="primary" id="mkcode">Получить команду</button></div>`, body => {
    $("#rn").focus();
    $("#mkcode").onclick = async () => {
      let c; try{ c = await post("/api/routers/enroll", {name:$("#rn").value.trim()}); }catch(e){ return flash(e.message, true); }
      const before = new Set(S.routers.map(r => r.id));
      body.innerHTML = `<h2>Выполните на роутере</h2>
        <div class="small muted">Подключитесь к роутеру по SSH (<code>ssh root@192.168.1.1</code>) и выполните команду. Если Nikki ещё не установлен, она сначала поставит официальный Nikki, затем nikki-fleet, и подключит роутер к этой панели. Подходит для OpenWrt 24.10 и 25.12.</div>
        <div class="cmd"><code id="cmdText">${esc(c.command)}</code><button id="cp1">Копировать</button></div>
        <details><summary class="small">Через curl</summary><div class="cmd" style="margin-top:8px"><code>${esc(c.curl)}</code><button id="cp3">Копировать</button></div></details>
        <details><summary class="small">Пакеты уже установлены</summary><div class="cmd" style="margin-top:8px"><code>${esc(c.manual)}</code><button id="cp2">Копировать</button></div></details>
        <div class="note">Код <b class="mono">${esc(c.code)}</b> одноразовый и действует 30 минут. <span id="wait">Жду подключения роутера…</span></div>
        <div class="row end"><button data-close>Закрыть</button></div>`;
      $("#cp1").onclick = () => copy(c.command); $("#cp2").onclick = () => copy(c.manual); $("#cp3").onclick = () => copy(c.curl);
      dlg._timer = setInterval(async () => {
        try{
          const rs = await get("/api/routers"); const n = rs.find(r => !before.has(r.id));
          if(n){ clearInterval(dlg._timer); S.routers = rs; $("#wait").innerHTML = `<b class="ok">Роутер «${esc(n.name)}» подключён.</b> <a href="#/r/${n.id}" data-close>Открыть</a>`; if(location.hash==="#/"||!location.hash) renderFleet(); }
        }catch(e){}
      }, 3000);
    };
  });
}

/* ---------- router workspace ---------- */
const TABS = [["overview","Обзор"],["proxies","Прокси"],["traffic","Трафик"],["config","Конфигуратор"],["history","История"],["logs","Логи"],["access","Доступ"],["settings","Настройки"]];
async function renderRouter(id, tab){
  clearTimers();
  try{ S.router = await get("/api/routers/" + id); }catch(e){ return handleErr(e); }
  S.tab = TABS.some(t => t[0]===tab) ? tab : "overview";
  const r = S.router;
  const st0 = statusOf(r), b0 = st0.board || {};
  app.innerHTML = `
    <div class="hero">
      <div class="rhead"><a href="#/" class="btn ghost" aria-label="К списку">←</a><h1>${esc(r.name)}</h1><span id="rpill"></span>
        ${r.role!=="owner" ? `<span class="pill">${ROLE[r.role]}</span>` : ""}</div>
      <div class="sub">${[b0.model, b0.release ? "OpenWrt " + b0.release : "", st0.mihomo?.version ? "mihomo " + st0.mihomo.version : ""].filter(Boolean).map(esc).join(" · ") || "&nbsp;"}</div>
      <div class="tabs" role="tablist">${TABS.map(([k,l]) => `<a class="tab btn" role="tab" href="#/r/${r.id}/${k}" aria-selected="${k===S.tab}">${l}</a>`).join("")}</div>
    </div>
    <div id="tabBody" class="tabbody"></div>`;
  drawPill();
  every(15000, async () => { try{ S.router = await get("/api/routers/" + id); drawPill(); if(S.tab==="overview") drawOverview(); }catch(e){} });
  const body = $("#tabBody");
  ({overview:tabOverview, proxies:tabProxies, traffic:tabTraffic, config:tabConfig, history:tabHistory, logs:tabLogs, access:tabAccess, settings:tabSettings})[S.tab](body, r);
}
function drawPill(){
  const r = S.router, p = $("#rpill"); if(!p) return;
  p.innerHTML = r.online ? `<span class="pill on">в сети</span>` : `<span class="pill off">не в сети · ${ago(r.last_seen)}</span>`;
}
const canEdit = () => S.router && S.router.role !== "viewer";

function tabOverview(body){
  body.innerHTML = `<div id="ov"></div>`;
  drawOverview();
  latestFleet().then(v => { if(v && v !== S.latest){ S.latest = v; drawOverview(); } });
}
function drawOverview(){
  const el = $("#ov"); if(!el) return;
  const r = S.router, st = statusOf(r), b = st.board || {}, nk = st.nikki || {}, m = st.memory || {};
  const used = m.total ? m.total - m.available : null, ex = st.exit;
  el.innerHTML = `
    <div class="stats">
      ${stat("Nikki", nk.running ? "работает" : st.nikki ? "остановлен" : "—", st.mihomo?.reachable ? "mihomo " + esc(st.mihomo.version) : esc(st.mihomo?.error || ""), "power", nk.running ? "g-ok" : "g-warn")}
      ${stat("Выход", ex?.chain?.length ? fname(ex.chain[ex.chain.length-1]) : "—", ex ? [esc(ex.group), ...ex.chain.slice(0,-1).map(esc)].join(" → ") + (ex.delay ? ` · ${ex.delay} мс` : "") : "нет данных", "globe", "g-main")}
      ${stat("Трафик", st.traffic ? "↓ " + bytes(st.traffic.down) : "—", st.traffic ? `↑ ${bytes(st.traffic.up)} · ${st.traffic.connections} соед.` : "", "swap", "g-info")}
      ${stat("Память", used != null ? Math.round(used / m.total * 100) + "%" : "—", used != null ? `${bytes(used)} из ${bytes(m.total)}` : "", "chip", "g-amber")}
    </div>
    ${r.online && canEdit() && st.nikki && !nk.profile?.name ? `<div class="panel starter">
      <div><h2>Nikki ещё не настроен</h2><div class="small muted">Создайте рабочий профиль из готового шаблона — нужны только название и ссылка подписки. Nikki включится автоматически после проверки конфига.</div></div>
      <button class="primary" id="aStarter">Быстрая настройка</button></div>` : ""}
    ${st.status_error ? `<div class="note err small">Агент не смог собрать часть статуса: ${esc(st.status_error)}</div>` : ""}
    ${!r.online ? `<div class="note">Роутер не на связи с ${ago(r.last_seen)}. Показан последний полученный статус${r.status_at ? " (" + fmtDate(r.status_at) + ")" : ""}. Команды станут доступны, когда агент снова подключится.</div>` : ""}
    <div class="panel">
      <div class="spread"><h3>Роутер</h3><span class="small muted">статус ${ago(r.status_at)}</span></div>
      <div class="kv">
        <div><b>Модель</b><span>${esc(b.model || "—")}</span></div>
        <div><b>OpenWrt</b><span>${esc(b.release || "—")}${b.target ? ` <span class="muted small">${esc(b.target)}</span>` : ""}</span></div>
        <div><b>Аптайм</b><span>${st.uptime ? dur(st.uptime) : "—"}</span></div>
        <div><b>Нагрузка</b><span>${(st.load||[]).map(x => (+x).toFixed(2)).join(" / ") || "—"}</span></div>
        <div><b>Память</b><span>${m.total ? `${bytes(m.total - m.available)} из ${bytes(m.total)}` : "—"}</span></div>
        <div><b>nikki-fleet</b><span>${esc(r.agent_version || "—")}${needsUpdate(r) ? ` · <span class="warn-t">доступна ${esc(S.latest)}</span>${r.role==="owner" && r.online ? ` <button class="small primary" id="aUpdate">Обновить</button>` : ""}` : S.latest && r.agent_version ? ` <span class="muted small">последняя</span>` : ""}</span></div>
      </div>
    </div>
    <div class="panel">
      <div class="spread"><h3>Nikki и mihomo</h3>
        ${canEdit() && r.online ? `<div class="row">${nk.enabled===false ? `${nk.profile?.name ? `<button class="primary" id="aEnable">Включить Nikki</button>` : ""}<button id="aStarter2" title="Новый профиль из шаблона">Шаблон профиля</button>` : `<button id="aReload">Перезапустить Nikki</button><button id="aStarter2" title="Новый профиль из шаблона">Шаблон профиля</button><button id="aUpdSubs">Обновить подписки</button><button class="ghost danger" id="aDisable">Выключить</button>`}</div>` : ""}</div>
      <div class="kv">
        <div><b>Nikki</b><span>${nk.running ? `<span class="ok">работает</span>` : st.nikki ? `<span class="err">остановлен</span>` : "—"}${nk.enabled===false ? " · выключен в настройках" : ""}</span></div>
        <div><b>Версия Nikki</b><span>${esc(nk.version || "—")}</span></div>
        <div><b>mihomo</b><span>${st.mihomo?.reachable ? esc(st.mihomo.version) : `<span class="err">${esc(st.mihomo?.error || "нет ответа")}</span>`}</span></div>
        <div><b>Профиль</b><span>${esc(nk.profile?.name || "—")}${nk.profile?.kind==="subscription" ? " <span class='muted small'>подписка</span>" : ""}</span></div>
        <div><b>Трафик</b><span>${st.traffic ? `↑ ${bytes(st.traffic.up)} · ↓ ${bytes(st.traffic.down)}` : "—"}</span></div>
        <div><b>Соединения</b><span>${st.traffic?.connections ?? "—"}${st.traffic ? ` · <a href="#/r/${r.id}/traffic">куда идёт трафик →</a>` : ""}</span></div>
      </div>
    </div>
    <div class="cols">
      <div class="panel"><h3>Группы</h3>
        ${(st.groups||[]).length ? `<div class="tbl"><table><thead><tr><th>Группа</th><th>Тип</th><th>Сейчас</th><th></th></tr></thead><tbody>
          ${st.groups.map(g => `<tr><td>${esc(g.name)}</td><td class="muted">${esc(GT[g.type]||g.type)}</td><td>${g.now ? fname(g.now) : "—"}</td><td class="num">${delay(g.delay)}</td></tr>`).join("")}
        </tbody></table></div>` : `<div class="muted small">${st.mihomo?.reachable === false ? "mihomo не отвечает — групп не видно" : "Нет данных"}</div>`}
        ${(st.groups||[]).length ? `<a class="small" href="#/r/${r.id}/proxies">Управлять группами →</a>` : ""}
      </div>
      <div class="panel"><h3>Подписки</h3>
        ${(st.providers||[]).length ? `<div class="tbl"><table><thead><tr><th>Подписка</th><th>Узлы</th><th>Обновлена</th><th>Трафик / срок</th></tr></thead><tbody>
          ${st.providers.map(p => `<tr><td>${fname(p.name)}</td><td class="num">${p.alive}/${p.count}</td><td class="muted">${ago(p.updated)}</td><td>${esc(subLine(p.sub) || "—")}</td></tr>`).join("")}
        </tbody></table></div>` : `<div class="muted small">Нет данных</div>`}
      </div>
    </div>
    <div class="note small">Полная настройка — на вкладке «Конфигуратор»: подписки, правила, группы и клиенты, с сохранением прямо на роутер.</div>`;
  $("#aUpdate")?.addEventListener("click", () => updateDialog(S.router));
  $("#aStarter")?.addEventListener("click", () => starterDialog(S.router, {hasProfile:false}));
  $("#aStarter2")?.addEventListener("click", () => starterDialog(S.router, {hasProfile:!!nk.profile?.name}));
  $("#aReload")?.addEventListener("click", async e => {
    const b = e.currentTarget; b.disabled = true; b.textContent = "Перезапускаю…";
    try{ const d = await cmd(S.router.id, "nikki.reload"); flash(d.api ? "Nikki перезапущен, mihomo отвечает" : "Nikki перезапущен, но mihomo пока не отвечает", !d.api); }
    catch(err){ flash(err.message, true); }
    b.disabled = false; b.textContent = "Перезапустить Nikki";
  });
  const toggle = async (e, on) => {
    const b = e.currentTarget;
    if(!on && !b.dataset.armed){ b.dataset.armed = "1"; b.textContent = "Точно выключить прокси?"; setTimeout(()=>{ if(b.isConnected){ delete b.dataset.armed; b.textContent = "Выключить"; } }, 4000); return; }
    b.disabled = true; b.textContent = on ? "Включаю…" : "Выключаю…";
    try{
      const d = await cmd(S.router.id, "nikki.enable", {enabled: on});
      flash(d.ok ? (on ? "Nikki включён, mihomo работает" : "Nikki выключен") : (d.error || "Ошибка"), !d.ok);
      if(d.ok){ const st2 = await cmd(S.router.id, "status", {full:true}).catch(()=>null); if(st2){ S.router.status = st2; drawOverview(); } }
    }catch(err){ flash(err.message, true); }
    if(b.isConnected){ b.disabled = false; b.textContent = on ? "Включить Nikki" : "Выключить"; }
  };
  $("#aEnable")?.addEventListener("click", e => toggle(e, true));
  $("#aDisable")?.addEventListener("click", e => toggle(e, false));
  $("#aUpdSubs")?.addEventListener("click", async e => {
    const b = e.currentTarget; b.disabled = true; b.textContent = "Обновляю…";
    const names = (st.providers || []).map(p => p.name); let bad = 0;
    for(const n of names){ try{ const d = await cmd(S.router.id, "mihomo.api", {method:"PUT", path:"/providers/proxies/" + encodeURIComponent(n)}); if(!d.ok) bad++; }catch(err){ bad++; } }
    flash(bad ? `Не обновились: ${bad} из ${names.length}` : `Обновлено подписок: ${names.length}`, !!bad);
    b.disabled = false; b.textContent = "Обновить подписки";
  });
}

function tabConfig(body){
  const r = S.router;
  if(!r.online){ body.innerHTML = `<div class="note">Роутер не на связи — конфигуратор откроется, когда агент подключится.</div>`; return; }
  window.NF_HOST = {
    kind: "panel", title: r.name, canWrite: r.role !== "viewer",
    listProfiles: () => cmd(r.id, "profiles.list"),
    readProfile: async (kind, name) => { const d = await cmd(r.id, "profile.read", {kind, name}); if(!d.ok) throw new Error(d.error || "не удалось прочитать профиль"); return d.content; },
    writeProfile: (kind, name, content, o) => cmd(r.id, "profile.write", {kind, name, content, activate: !!o?.activate, reload: o?.reload !== false}),
    api: (method, path, b) => cmd(r.id, "mihomo.api", {method, path, body: b}),
  };
  body.innerHTML = `<iframe class="frame" src="configurator.html" title="Конфигуратор ${esc(r.name)}"></iframe>`;
  body.querySelector("iframe").addEventListener("load", () => themeApply(themeGet()));
}

async function tabHistory(body){
  const r = S.router;
  body.innerHTML = `<div class="panel"><h3>Версии, сохранённые через панель</h3><div id="vers" class="muted small">Загрузка…</div></div>
    <div class="panel"><div class="spread"><h3>Резервные копии на роутере</h3><span class="small muted">последние 10 версий активного профиля</span></div><div id="bks" class="muted small">${r.online ? "Загрузка…" : "Роутер не на связи"}</div></div>`;
  try{
    const vs = await get(`/api/routers/${r.id}/versions`);
    $("#vers").outerHTML = vs.length ? `<div class="tbl"><table><thead><tr><th>Когда</th><th>Кто</th><th>Профиль</th><th>Результат</th><th class="num">Размер</th><th></th></tr></thead><tbody>
      ${vs.map(v => `<tr><td>${fmtDate(v.time)}</td><td>${esc(v.user||"—")}</td><td>${esc(v.name)}</td><td>${v.result==="ok" ? `<span class="ok">применён</span>` : v.result==="rolled_back" ? `<span class="err">откат</span>` : `<span class="err">отклонён</span>`}</td><td class="num">${bytes(v.size)}</td>
      <td><div class="row"><button data-ver="${esc(v.id)}">Показать</button>${canEdit() && r.online ? `<button data-restore-ver="${esc(v.id)}" data-name="${esc(v.name)}" data-kind="${esc(v.kind)}">Вернуть</button>` : ""}</div></td></tr>`).join("")}
    </tbody></table></div>` : `<div class="muted small" id="vers">Пока нет: версии появятся после первого сохранения конфига через панель.</div>`;
  }catch(e){ $("#vers").textContent = e.message; }
  if(!r.online) return;
  try{
    const pl = await cmd(r.id, "profiles.list"), act = pl.active || {};
    if(!act.name){ $("#bks").textContent = "Активный профиль не выбран"; return; }
    const d = await cmd(r.id, "backups.list", {kind: act.kind, name: act.name});
    const bs = d.backups || [];
    $("#bks").outerHTML = bs.length ? `<div class="tbl"><table><thead><tr><th>Копия профиля ${esc(act.name)}</th><th>Когда</th><th class="num">Размер</th><th></th></tr></thead><tbody>
      ${bs.map(x => `<tr><td class="mono small">${esc(x.id)}</td><td>${fmtDate(x.mtime*1000)}</td><td class="num">${bytes(x.size)}</td><td>${canEdit() ? `<button data-restore-bk="${esc(x.id)}" data-name="${esc(act.name)}" data-kind="${esc(act.kind)}">Восстановить</button>` : ""}</td></tr>`).join("")}
    </tbody></table></div>` : `<div class="muted small" id="bks">Копий пока нет — они создаются при каждом сохранении профиля.</div>`;
  }catch(e){ $("#bks").textContent = e.message; }
}
document.addEventListener("click", async e => {
  const r = S.router; if(!r) return;
  const v = e.target.closest("[data-ver]");
  if(v){ try{ const d = await get(`/api/routers/${r.id}/versions/${v.dataset.ver}`); openDialog(`<h2>Версия конфига</h2><pre class="code">${esc(d.content)}</pre><div class="row end"><button data-close>Закрыть</button></div>`); }catch(err){ flash(err.message, true); } }
  const rv = e.target.closest("[data-restore-ver]");
  if(rv){
    if(!rv.dataset.armed){ rv.dataset.armed = "1"; rv.textContent = "Точно вернуть?"; setTimeout(()=>{ if(rv.isConnected){ delete rv.dataset.armed; rv.textContent = "Вернуть"; } }, 4000); return; }
    rv.disabled = true; rv.textContent = "Применяю…";
    try{
      const d = await get(`/api/routers/${r.id}/versions/${rv.dataset.restoreVer}`);
      const w = await cmd(r.id, "profile.write", {kind: rv.dataset.kind, name: rv.dataset.name, content: d.content, reload: true});
      flash(w.ok ? "Версия применена на роутере" : (w.error || "Роутер не принял версию"), !w.ok);
    }catch(err){ flash(err.message, true); }
    tabHistory($("#tabBody"));
  }
  const rb = e.target.closest("[data-restore-bk]");
  if(rb){
    if(!rb.dataset.armed){ rb.dataset.armed = "1"; rb.textContent = "Точно восстановить?"; setTimeout(()=>{ if(rb.isConnected){ delete rb.dataset.armed; rb.textContent = "Восстановить"; } }, 4000); return; }
    rb.disabled = true; rb.textContent = "Восстанавливаю…";
    try{ const w = await cmd(r.id, "backup.restore", {kind: rb.dataset.kind, name: rb.dataset.name, id: rb.dataset.restoreBk, reload: true}); flash(w.ok ? "Копия восстановлена и применена" : (w.error || "Ошибка"), !w.ok); }
    catch(err){ flash(err.message, true); }
    tabHistory($("#tabBody"));
  }
});

function tabLogs(body){
  const r = S.router;
  body.innerHTML = `<div class="panel">
    <div class="row"><select id="lw" style="width:auto"><option value="core">Лог mihomo (core)</option><option value="app">Лог Nikki (app)</option></select>
      <select id="ln" style="width:auto"><option>100</option><option selected>200</option><option>500</option></select>
      <button id="lget" class="primary">Показать</button><label class="small muted"><input type="checkbox" id="lauto" style="width:auto"> обновлять каждые 10 с</label></div>
    <pre class="code" id="lout">${r.online ? "" : "Роутер не на связи"}</pre></div>`;
  const load = async () => {
    try{ const d = await cmd(r.id, "logs.tail", {which: $("#lw").value, lines: +$("#ln").value}); const o = $("#lout"); o.textContent = d.content || "(пусто)"; o.scrollTop = o.scrollHeight; }
    catch(e){ $("#lout").textContent = e.message; }
  };
  $("#lget").onclick = load;
  $("#lauto").onchange = e => { clearTimers(); if(e.target.checked) every(10000, load); };
  if(r.online) load();
}

async function tabAccess(body){
  const r = S.router;
  body.innerHTML = `<div class="panel"><h3>У кого есть доступ</h3><div id="shares" class="muted small">Загрузка…</div></div>
    ${r.role==="owner" ? `<form class="panel" id="shareForm"><h3>Дать доступ</h3>
      <div class="note small">Пользователь должен быть зарегистрирован в этой панели. «Просмотр» — статус, конфиг и логи без изменений. «Редактор» — может менять и сохранять конфиг, перезапускать Nikki.</div>
      <div class="row"><input id="su" placeholder="имя пользователя" style="flex:1 1 200px" required><select id="sr" style="width:auto"><option value="viewer">просмотр</option><option value="editor">редактор</option></select><button class="primary">Добавить</button></div></form>` : ""}`;
  const load = async () => {
    try{
      const ss = await get(`/api/routers/${r.id}/shares`);
      $("#shares").outerHTML = `<div class="tbl" id="shares"><table><tbody>${ss.map(s => `<tr><td>${esc(s.username)}</td><td class="muted">${ROLE[s.role]}</td><td>${
        s.role!=="owner" && (r.role==="owner" || s.user_id===S.me.id) ? `<button class="danger" data-unshare="${esc(s.user_id)}">${s.user_id===S.me.id ? "Отказаться от доступа" : "Убрать"}</button>` : ""}</td></tr>`).join("")}</tbody></table></div>`;
    }catch(e){ $("#shares").textContent = e.message; }
  };
  load();
  $("#shareForm")?.addEventListener("submit", async e => {
    e.preventDefault();
    try{ await post(`/api/routers/${r.id}/shares`, {username: $("#su").value.trim(), role: $("#sr").value}); $("#su").value = ""; flash("Доступ выдан"); load(); }
    catch(err){ flash(err.message, true); }
  });
  body.onclick = async e => {
    const b = e.target.closest("[data-unshare]"); if(!b) return;
    try{ await del(`/api/routers/${r.id}/shares/${b.dataset.unshare}`); if(b.dataset.unshare===S.me.id){ location.hash = "#/"; return; } flash("Доступ убран"); load(); }
    catch(err){ flash(err.message, true); }
  };
}

async function tabSettings(body){
  const r = S.router;
  body.innerHTML = `
    ${canEdit() ? `<form class="panel" id="setForm"><h3>Роутер</h3>
      <label class="f"><span>Название</span><input id="sn" value="${esc(r.name)}" maxlength="80"></label>
      <label class="f"><span>Заметки</span><textarea id="snotes" rows="3" style="font-family:var(--f-ui);font-size:14px">${esc(r.notes)}</textarea></label>
      <div class="row end"><button class="primary">Сохранить</button></div></form>` : ""}
    <div class="panel"><h3>Журнал</h3><div id="audit" class="muted small">Загрузка…</div></div>
    ${r.role==="owner" ? `<div class="panel"><h3>Удаление</h3>
      <div class="small">Роутер исчезнет из панели, его токен перестанет работать. На самом роутере агент можно отключить командой <code>nikki-fleet unenroll</code>.</div>
      <div><button class="danger" id="delRouter">Удалить роутер из панели</button></div></div>` : ""}`;
  $("#setForm")?.addEventListener("submit", async e => {
    e.preventDefault();
    try{ await patch(`/api/routers/${r.id}`, {name: $("#sn").value, notes: $("#snotes").value}); flash("Сохранено"); renderRouter(r.id, "settings"); }
    catch(err){ flash(err.message, true); }
  });
  $("#delRouter")?.addEventListener("click", async e => {
    const b = e.currentTarget;
    if(!b.dataset.armed){ b.dataset.armed = "1"; b.textContent = "Нажмите ещё раз для удаления"; setTimeout(()=>{ if(b.isConnected){ delete b.dataset.armed; b.textContent = "Удалить роутер из панели"; } }, 4000); return; }
    try{ await del(`/api/routers/${r.id}`); flash("Роутер удалён"); location.hash = "#/"; }catch(err){ flash(err.message, true); }
  });
  const ACT = {"router.enrolled":"роутер подключён","cmd.ok":"изменение применено","cmd.error":"изменение отклонено","cmd.rolled_back":"откат после ошибки","share.added":"выдан доступ","share.removed":"доступ убран","agent.auto_rollback":"автооткат: панель была недоступна"};
  try{
    const a = await get(`/api/routers/${r.id}/audit`);
    $("#audit").outerHTML = a.length ? `<div class="tbl" id="audit"><table><tbody>${a.map(x => `<tr><td class="muted" style="white-space:nowrap">${fmtDate(x.time)}</td><td>${esc(x.user || "роутер")}</td><td>${esc(ACT[x.action] || x.action)}</td><td class="mono small">${esc(x.detail)}</td></tr>`).join("")}</tbody></table></div>` : `<div class="muted small" id="audit">Записей нет</div>`;
  }catch(e){ $("#audit").textContent = e.message; }
}

/* ---------- account / admin ---------- */
async function renderAccount(){
  clearTimers();
  app.innerHTML = `<h1>Учётная запись</h1>
    <form class="panel" id="pwForm"><h3>Смена пароля</h3>
      <label class="f"><span>Текущий пароль</span><input type="password" id="po" autocomplete="current-password" required></label>
      <label class="f"><span>Новый пароль</span><input type="password" id="pn" autocomplete="new-password" minlength="8" required></label>
      <div class="row end"><button class="primary">Сменить пароль</button></div></form>
    ${S.me.is_admin ? `<div class="panel" id="adm"><h3>Администрирование</h3><div class="muted small">Загрузка…</div></div>` : ""}
    <div class="muted small">nikki-fleet ${esc(S.info?.version || "")} · <a href="https://github.com/dontbass/nikki-fleet" target="_blank" rel="noopener">исходный код</a></div>`;
  $("#pwForm").addEventListener("submit", async e => {
    e.preventDefault();
    try{ await post("/api/me/password", {old: $("#po").value, new: $("#pn").value}); flash("Пароль изменён"); e.target.reset(); }
    catch(err){ flash(err.message, true); }
  });
  if(!S.me.is_admin) return;
  const draw = async () => {
    const d = await get("/api/admin/users");
    $("#adm").innerHTML = `<h3>Администрирование</h3>
      <label class="row small"><input type="checkbox" id="regOpen" style="width:auto"${d.registration==="open" ? " checked" : ""}> Открытая регистрация — любой может создать учётную запись и подключать свои роутеры</label>
      <div class="tbl"><table><thead><tr><th>Пользователь</th><th>Создан</th><th class="num">Роутеров</th><th></th></tr></thead><tbody>
        ${d.users.map(u => `<tr><td>${esc(u.username)}${u.is_admin ? " <span class='pill'>админ</span>" : ""}</td><td class="muted">${fmtDate(u.created)}</td><td class="num">${u.routers}</td><td>${u.id!==S.me.id ? `<button class="danger" data-deluser="${esc(u.id)}">Удалить</button>` : ""}</td></tr>`).join("")}
      </tbody></table></div>
      <form id="nuForm" class="row"><input id="nu" placeholder="новый пользователь" style="flex:1 1 160px" required><input id="np" type="password" placeholder="пароль (от 8 символов)" style="flex:1 1 160px" minlength="8" required><button class="primary">Создать</button></form>`;
    $("#regOpen").onchange = async e => { try{ await patch("/api/admin/settings", {registration: e.target.checked ? "open" : "closed"}); flash("Сохранено"); }catch(err){ flash(err.message, true); } };
    $("#nuForm").onsubmit = async e => { e.preventDefault(); try{ await post("/api/admin/users", {username: $("#nu").value.trim(), password: $("#np").value}); flash("Пользователь создан"); draw(); }catch(err){ flash(err.message, true); } };
    $("#adm").onclick = async e => {
      const b = e.target.closest("[data-deluser]"); if(!b) return;
      if(!b.dataset.armed){ b.dataset.armed = "1"; b.textContent = "Удалить вместе с роутерами?"; return; }
      try{ await del("/api/admin/users/" + b.dataset.deluser); flash("Пользователь удалён"); draw(); }catch(err){ flash(err.message, true); }
    };
  };
  draw().catch(e => flash(e.message, true));
}

/* ---------- routing ---------- */
function handleErr(e){
  if(e.status === 401){ S.me = null; boot(); return; }
  app.innerHTML = `<div class="panel"><h2>Ошибка</h2><div class="err">${esc(e.message)}</div><div><a class="btn" href="#/">К списку роутеров</a></div></div>`;
}
function route(){
  if(!S.me) return;
  const h = location.hash.replace(/^#/, "") || "/";
  const m = h.match(/^\/r\/([A-Za-z0-9]+)(?:\/([a-z]+))?/);
  if(m) return renderRouter(m[1], m[2]);
  if(h === "/account") return renderAccount();
  renderFleet();
}
window.addEventListener("hashchange", () => { if(dlg.open) dlg.close(); route(); });

async function boot(){
  clearTimers();
  try{ S.info = await get("/api/info"); }catch(e){}
  try{ S.me = await get("/api/me"); }catch(e){ S.me = null; }
  renderNav();
  if(!S.me) return renderAuth();
  route();
}
boot();
