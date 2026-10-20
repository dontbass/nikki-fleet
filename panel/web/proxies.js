// nikki-fleet panel: proxy groups — switch nodes, test delays, update subscriptions.
// Data: agent command "proxies" (compact /proxies + /providers/proxies);
// older agents fall back to mihomo.api GET /proxies.
// SPDX-License-Identifier: GPL-3.0-or-later
"use strict";

const PX_TEST_URL = "https://www.gstatic.com/generate_204", PX_TIMEOUT = 5000;
const PX_SELECTABLE = {Selector:true, URLTest:true, Fallback:true}; // URLTest/Fallback: pin a node (mihomo "fixed")
const PX_GTYPE = {Selector:"ручной", URLTest:"самый быстрый", Fallback:"первый живой", LoadBalance:"балансировка", Relay:"цепочка"};

function pxFromMihomo(px){
  px = px || {}; const order = {}; (px.GLOBAL?.all || []).forEach((n,i) => order[n] = i);
  const nodes = {}, groups = [];
  for(const [n,p] of Object.entries(px)){
    const h = p.history || [];
    nodes[n] = {t:p.type, u:!!p.udp, d:h.length ? h[h.length-1].delay : null, a:p.alive};
    if(Array.isArray(p.all) && n !== "GLOBAL") groups.push({name:n, type:p.type, now:p.now||"", fixed:p.fixed||"", all:p.all, hidden:!!p.hidden, icon:p.icon||"", test_url:p.testUrl||""});
  }
  groups.sort((a,b) => (order[a.name] ?? 1e5) - (order[b.name] ?? 1e5));
  return {ok:true, mode:"", groups, nodes, providers:null};
}
const pxKind = n => n ? `${String(n.t||"").toLowerCase()}${n.u ? " / udp" : ""}` : "";
function pxDelay(d, cls){
  if(d === undefined || d === null) return `<span class="pxd none ${cls||""}">⚡</span>`;
  if(d === 0) return `<span class="pxd bad ${cls||""}">✕</span>`;
  return `<span class="pxd ${d<300?"good":d<800?"mid":"bad"} ${cls||""}">${d}</span>`;
}
const pxStore = (k, v) => { try{ if(v === undefined) return JSON.parse(localStorage.getItem("nf.px." + k) || "null"); localStorage.setItem("nf.px." + k, JSON.stringify(v)); }catch(e){ return null; } };

function tabProxies(body, r){
  if(!r.online){ body.innerHTML = `<div class="note">Роутер не на связи — группы появятся, когда агент подключится.</div>`; return; }
  const P = { data:null, view:pxStore("view") || "groups", q:"", sort:pxStore("sort") || "config", hideDead:!!pxStore("hideDead"),
    open:pxStore("open:" + r.id) || {}, testing:new Set(), busy:false, legacy:false };
  const edit = canEdit();
  body.innerHTML = `
    <div class="pxbar">
      <div class="seg" role="tablist"><button data-pxview="groups">Группы</button><button data-pxview="providers">Подписки</button></div>
      <input id="pxQ" type="search" placeholder="поиск: узел или группа">
      <select id="pxSort" aria-label="Сортировка узлов"><option value="config">как в конфиге</option><option value="delay">по задержке</option><option value="name">по имени</option></select>
      <label class="small muted pxchk"><input type="checkbox" id="pxDead"> скрыть недоступные</label>
      <span class="grow"></span>
      <button id="pxTestAll" title="Проверить задержку всех групп">⚡ Проверить все</button>
      <button id="pxReload" class="ghost" title="Обновить">↻</button>
    </div>
    <div id="pxBody" class="pxbody"><div class="muted small">Загрузка…</div></div>`;
  $("#pxSort").value = P.sort; $("#pxDead").checked = P.hideDead;

  async function load(){
    if(P.busy) return; P.busy = true;
    try{
      let d = null;
      if(!P.legacy){
        try{ d = await cmd(r.id, "proxies"); if(d.ok === false) throw new Error(d.error || "нет данных"); }
        catch(e){ if(!/unknown command|неизвестная команда/.test(e.message)) throw e; P.legacy = true; }
      }
      if(!d){
        const x = await cmd(r.id, "mihomo.api", {method:"GET", path:"/proxies"});
        if(!x.ok) throw new Error(x.error || ("mihomo API: HTTP " + x.code));
        d = pxFromMihomo(x.data?.proxies);
      }
      P.data = d;
    }catch(e){ $("#pxBody").innerHTML = `<div class="note err">${esc(e.message)}</div>`; P.busy = false; return; }
    P.busy = false; draw();
  }

  // effective delay of a member: a group shows the delay of what it currently uses
  function delayOf(name, depth){
    const d = P.data, n = d.nodes[name]; if(!n) return null;
    const g = d.groups.find(x => x.name === name);
    if(g && g.now && (depth||0) < 5) return delayOf(g.now, (depth||0)+1);
    return n.d;
  }
  function chainOf(g){
    const out = []; let cur = g, guard = 0;
    while(cur && cur.now && guard++ < 6){ out.push(cur.now); cur = P.data.groups.find(x => x.name === cur.now); }
    return out;
  }
  function members(list){
    const q = P.q; let ms = list.slice();
    if(q) ms = ms.filter(n => n.toLowerCase().includes(q));
    if(P.hideDead) ms = ms.filter(n => { const d = delayOf(n); return d !== 0; });
    if(P.sort === "delay") ms.sort((a,b) => { const x = delayOf(a) || 1e9, y = delayOf(b) || 1e9; return x - y; });
    else if(P.sort === "name") ms.sort((a,b) => a.localeCompare(b, "ru"));
    return ms;
  }
  function tile(name, g){
    const n = P.data.nodes[name], sel = g && g.now === name, can = edit && g && PX_SELECTABLE[g.type];
    const isGroup = P.data.groups.some(x => x.name === name);
    return `<div class="pxt${sel ? " sel" : ""}${can ? " can" : ""}" ${can ? `role="button" tabindex="0" data-pxsel="${esc(name)}" data-pxg="${esc(g.name)}"` : ""} title="${esc(name)}">
      <span class="pxn">${esc(name)}</span>
      <span class="pxk">${isGroup ? `<span class="pxgrp">группа</span> ` : ""}${esc(pxKind(n))}</span>
      <button class="pxdb" data-pxtest="${esc(name)}" title="Проверить задержку" aria-label="Проверить задержку ${esc(name)}">${P.testing.has("n:" + name) ? `<span class="pxd none">…</span>` : pxDelay(delayOf(name))}</button>
    </div>`;
  }

  function drawGroups(){
    const d = P.data, q = P.q;
    let gs = d.groups.filter(g => !g.hidden);
    if(q) gs = gs.filter(g => g.name.toLowerCase().includes(q) || g.all.some(n => n.toLowerCase().includes(q)));
    if(!gs.length) return `<div class="note">${q ? "Ничего не найдено" : "В конфиге нет групп прокси"}</div>`;
    return gs.map((g, i) => {
      const open = P.open[g.name] ?? (i < 3), all = g.all, alive = all.filter(n => { const x = delayOf(n); return x > 0; }).length;
      const ms = q && !g.name.toLowerCase().includes(q) ? members(all) : (q ? all.slice() : members(all));
      const chain = chainOf(g);
      return `<section class="panel pxg">
        <div class="pxgh">
          <button class="pxtog" data-pxopen="${esc(g.name)}" aria-expanded="${open}"><span class="chev">${open ? "▾" : "▸"}</span><b>${esc(g.name)}</b>
            <span class="pill">${esc(PX_GTYPE[g.type] || g.type)}</span><span class="small muted">${alive}/${all.length}</span></button>
          <span class="pxnow small">${chain.length ? esc(chain.join(" → ")) : "—"}${g.fixed ? ` <span class="pill warn" title="Автовыбор отключён: узел закреплён вручную">закреплён</span>${edit ? ` <button class="ghost small" data-pxunfix="${esc(g.name)}">открепить</button>` : ""}` : ""}</span>
          <span class="grow"></span>
          ${pxDelay(delayOf(g.name))}
          <button class="small" data-pxgtest="${esc(g.name)}" ${P.testing.has("g:" + g.name) ? "disabled" : ""}>${P.testing.has("g:" + g.name) ? "проверяю…" : "⚡ проверить"}</button>
        </div>
        ${open ? `<div class="pxgrid">${ms.map(n => tile(n, g)).join("") || `<div class="muted small">Нет узлов под фильтр</div>`}</div>` : ""}
      </section>`;
    }).join("");
  }

  function drawProviders(){
    const ps = P.data.providers;
    if(!ps) return `<div class="note">Список подписок доступен после обновления nikki-fleet на роутере до 0.1.9 или новее.</div>`;
    if(!ps.length) return `<div class="note">В конфиге нет подписок (proxy-providers).</div>`;
    return ps.map(p => {
      const open = P.open["p:" + p.name] ?? false, alive = p.proxies.filter(n => (P.data.nodes[n]?.d || 0) > 0).length;
      const used = p.sub ? (p.sub.Upload||0) + (p.sub.Download||0) : 0, pct = p.sub?.Total ? Math.min(100, used/p.sub.Total*100) : 0;
      return `<section class="panel pxg">
        <div class="pxgh">
          <button class="pxtog" data-pxopen="p:${esc(p.name)}" aria-expanded="${open}"><span class="chev">${open ? "▾" : "▸"}</span><b>${esc(p.name)}</b>
            <span class="pill">${esc(p.vehicle === "HTTP" ? "подписка" : p.vehicle === "File" ? "файл" : p.vehicle || "")}</span><span class="small muted">${alive}/${p.proxies.length}</span></button>
          <span class="small muted">обновлена ${ago(p.updated)}${p.sub ? " · " + esc(subLine(p.sub)) : ""}</span>
          <span class="grow"></span>
          ${edit && p.vehicle === "HTTP" ? `<button class="small" data-pxpupd="${esc(p.name)}">↻ обновить</button>` : ""}
          <button class="small" data-pxphc="${esc(p.name)}" ${P.testing.has("p:" + p.name) ? "disabled" : ""}>${P.testing.has("p:" + p.name) ? "проверяю…" : "⚡ проверить"}</button>
        </div>
        ${p.sub?.Total ? `<div class="bar"><i class="${pct>85?"hi":""}" style="width:${pct.toFixed(1)}%"></i></div>` : ""}
        ${open ? `<div class="pxgrid">${members(p.proxies).map(n => tile(n, null)).join("")}</div>` : ""}
      </section>`;
    }).join("");
  }

  function draw(){
    const el = $("#pxBody"); if(!el || !P.data) return;
    body.querySelectorAll("[data-pxview]").forEach(b => b.setAttribute("aria-selected", b.dataset.pxview === P.view));
    el.innerHTML = (P.data.mode === "global" ? `<div class="note">mihomo в режиме <b>global</b>: весь трафик идёт через группу GLOBAL, правила не действуют.</div>` : "")
      + (P.legacy ? `<div class="note small">На роутере старая версия nikki-fleet — данные загружаются полностью, без списка подписок. Обновите nikki-fleet на вкладке «Обзор».</div>` : "")
      + (P.view === "providers" ? drawProviders() : drawGroups());
  }

  const api = (method, path, b) => cmd(r.id, "mihomo.api", {method, path, body: b});
  // mihomo paths: escape everything outside [A-Za-z0-9_.~-] (the agent rejects "(", "!" etc. unescaped)
  const enc = n => encodeURIComponent(n).replace(/[!'()*]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  const testQ = url => `?url=${enc(url || PX_TEST_URL)}&timeout=${PX_TIMEOUT}`;

  async function testGroup(name){
    const g = P.data.groups.find(x => x.name === name); if(!g) return;
    P.testing.add("g:" + name); draw();
    try{
      const x = await api("GET", `/group/${enc(name)}/delay${testQ(g.test_url)}`);
      if(x.ok && x.data && typeof x.data === "object"){
        for(const n of g.all) if(P.data.nodes[n] && !P.data.groups.some(y => y.name === n)) P.data.nodes[n].d = x.data[n] ?? 0;
        for(const [n, v] of Object.entries(x.data)) if(P.data.nodes[n]) P.data.nodes[n].d = v;
      }else flash(x.data?.message || x.error || "Проверка не удалась", true);
    }catch(e){ flash(e.message, true); }
    P.testing.delete("g:" + name);
  }
  async function testNode(name){
    P.testing.add("n:" + name); draw();
    try{
      const x = await api("GET", `/proxies/${enc(name)}/delay${testQ()}`);
      if(P.data.nodes[name]) P.data.nodes[name].d = x.ok ? (x.data?.delay ?? 0) : 0;
    }catch(e){ flash(e.message, true); }
    P.testing.delete("n:" + name); draw();
  }

  body.addEventListener("click", async e => {
    const t = e.target;
    const v = t.closest("[data-pxview]"); if(v){ P.view = v.dataset.pxview; pxStore("view", P.view); return draw(); }
    const o = t.closest("[data-pxopen]");
    if(o){ const k = o.dataset.pxopen, idx = P.data.groups.findIndex(x => x.name === k);
      P.open[k] = !(P.open[k] ?? (!k.startsWith("p:") && idx >= 0 && idx < 3)); pxStore("open:" + r.id, P.open); return draw(); }
    const nt = t.closest("[data-pxtest]"); if(nt){ e.stopPropagation(); return testNode(nt.dataset.pxtest); }
    const gt = t.closest("[data-pxgtest]"); if(gt){ await testGroup(gt.dataset.pxgtest); return draw(); }
    const uf = t.closest("[data-pxunfix]");
    if(uf){ try{ const x = await api("DELETE", `/proxies/${enc(uf.dataset.pxunfix)}`); flash(x.ok ? "Автовыбор снова включён" : (x.error || "Не удалось"), !x.ok); }catch(err){ flash(err.message, true); } return load(); }
    const s = t.closest("[data-pxsel]");
    if(s){
      const g = P.data.groups.find(x => x.name === s.dataset.pxg), name = s.dataset.pxsel;
      if(!g || g.now === name) return;
      const prev = g.now; g.now = name; if(g.type !== "Selector") g.fixed = name; draw();
      try{
        const x = await api("PUT", `/proxies/${enc(g.name)}`, {name});
        if(!x.ok){ g.now = prev; draw(); flash(x.data?.message || x.error || "Не удалось переключить", true); }
        else flash(`${g.name}: ${name}`);
      }catch(err){ g.now = prev; draw(); flash(err.message, true); }
      return;
    }
    const pu = t.closest("[data-pxpupd]");
    if(pu){ pu.disabled = true; pu.textContent = "обновляю…";
      try{ const x = await api("PUT", `/providers/proxies/${enc(pu.dataset.pxpupd)}`); flash(x.ok ? "Подписка обновлена" : (x.data?.message || x.error || "Не удалось обновить"), !x.ok); }catch(err){ flash(err.message, true); }
      return load(); }
    const hc = t.closest("[data-pxphc]");
    if(hc){ const n = hc.dataset.pxphc; P.testing.add("p:" + n); draw();
      try{ await api("GET", `/providers/proxies/${enc(n)}/healthcheck`); }catch(err){ flash(err.message, true); }
      P.testing.delete("p:" + n); return load(); }
  });
  body.addEventListener("keydown", e => { if((e.key === "Enter" || e.key === " ") && e.target.matches("[data-pxsel]")){ e.preventDefault(); e.target.click(); } });
  $("#pxQ").oninput = e => { P.q = e.target.value.trim().toLowerCase(); draw(); };
  $("#pxSort").onchange = e => { P.sort = e.target.value; pxStore("sort", P.sort); draw(); };
  $("#pxDead").onchange = e => { P.hideDead = e.target.checked; pxStore("hideDead", P.hideDead); draw(); };
  $("#pxReload").onclick = load;
  $("#pxTestAll").onclick = async e => {
    const b = e.currentTarget; b.disabled = true;
    const gs = P.data?.groups.filter(g => !g.hidden && g.type !== "Relay") || [];
    for(let i = 0; i < gs.length; i++){ b.textContent = `⚡ ${i+1}/${gs.length}`; await testGroup(gs[i].name); draw(); }
    b.disabled = false; b.textContent = "⚡ Проверить все";
  };

  load();
  every(30000, () => { if(!document.hidden && !P.testing.size) load(); });
}
