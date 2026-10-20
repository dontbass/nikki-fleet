// nikki-fleet panel: live traffic tab — where and how traffic goes through mihomo.
// Data comes from the agent command "traffic" (compact /connections snapshot);
// older agents fall back to mihomo.api GET /connections.
// SPDX-License-Identifier: GPL-3.0-or-later
"use strict";

const TR_POLL = 2000, TR_HIST = 90; // 2 s × 90 = 3 minutes of history

function trFromMihomo(d){
  const all = (d?.connections || []).slice().sort((a,b) => (b.upload+b.download) - (a.upload+a.download));
  return { ok:true, up_total:d?.uploadTotal||0, down_total:d?.downloadTotal||0, count:all.length, leases:{},
    conns: all.slice(0, 300).map(c => { const m = c.metadata || {}; return {
      id:c.id, host:m.host || m.sniffHost || "", dst:m.destinationIP || "", port:m.destinationPort || "", src:m.sourceIP || "",
      net:m.network || "", type:m.type || "", proc:m.process || "", rule:c.rule || "", payload:c.rulePayload || "",
      chain:c.chains || [], up:c.upload||0, down:c.download||0, start:c.start || "" }; }) };
}

const speed = b => b == null ? "—" : bytes(Math.round(b)) + "/с";
const trRoute = c => (c.chain || []).slice().reverse().join(" → ") || "—";
const trNode = c => (c.chain || [])[0] || "—";
const trDev = (T, ip) => T.leases[ip] ? `${T.leases[ip]}` : ip || "—";
const trRule = c => c.rule ? (c.payload ? `${c.rule}: ${c.payload}` : c.rule) : "—";
const trAge = s => { const t = Date.parse(s); if(!t) return "—"; const x = Math.max(0, Math.round((Date.now()-t)/1000));
  return x < 60 ? `${x} с` : x < 3600 ? `${Math.floor(x/60)} мин` : `${Math.floor(x/3600)} ч ${Math.floor(x%3600/60)} мин`; };

function tabTraffic(body, r){
  if(!r.online){ body.innerHTML = `<div class="note">Роутер не на связи — живой трафик появится, когда агент подключится.</div>`; return; }
  const T = { prev:null, prevAt:0, rates:new Map(), hist:[], data:null, leases:{}, paused:false, busy:false,
    q:"", sort:"speed", legacy:false, err:"" };
  body.innerHTML = `
    <div class="panel">
      <div class="spread"><h3>Сейчас</h3>
        <div class="row"><span class="small muted" id="trInfo">подключаюсь…</span><button id="trPause" class="ghost">Пауза</button></div></div>
      <div class="trnow">
        <div><b>Загрузка</b><span class="big dn" id="trDn">—</span></div>
        <div><b>Отдача</b><span class="big up" id="trUp">—</span></div>
        <div><b>Соединения</b><span class="big" id="trCnt">—</span></div>
        <div><b>Всего с запуска mihomo</b><span id="trTot">—</span></div>
      </div>
      <div class="trchart" id="trChart" role="img" aria-label="Скорость за последние 3 минуты"></div>
    </div>
    <div class="cols3">
      <div class="panel"><div class="spread"><h3>Через что</h3><span class="small muted">узел / DIRECT</span></div><div id="trByNode" class="trlist"></div></div>
      <div class="panel"><div class="spread"><h3>Устройства</h3><span class="small muted">кто качает</span></div><div id="trByDev" class="trlist"></div></div>
      <div class="panel"><div class="spread"><h3>Правила</h3><span class="small muted">почему туда</span></div><div id="trByRule" class="trlist"></div></div>
    </div>
    <div class="panel">
      <div class="spread"><h3>Соединения</h3>
        <div class="row trtools"><input id="trQ" type="search" placeholder="домен, IP, устройство, узел, правило">
          <select id="trSort" style="width:auto"><option value="speed">по скорости</option><option value="total">по объёму</option><option value="new">новые сверху</option></select></div></div>
      <div class="tbl"><table class="trtbl"><thead><tr><th>Куда</th><th>Устройство</th><th>Правило</th><th>Маршрут</th><th class="num">Скорость ↓ / ↑</th><th class="num">Всего</th><th class="num">Время</th>${canEdit() ? "<th></th>" : ""}</tr></thead>
        <tbody id="trRows"><tr><td colspan="8" class="muted small">Загрузка…</td></tr></tbody></table></div>
      <div class="small muted" id="trFoot"></div>
    </div>`;

  $("#trPause").onclick = e => { T.paused = !T.paused; e.currentTarget.textContent = T.paused ? "Продолжить" : "Пауза"; if(!T.paused) poll(); };
  $("#trQ").oninput = e => { T.q = e.target.value.trim().toLowerCase(); draw(); };
  $("#trSort").onchange = e => { T.sort = e.target.value; draw(); };
  body.addEventListener("click", async e => {
    const f = e.target.closest("[data-trf]");
    if(f){ T.q = f.dataset.trf.toLowerCase(); $("#trQ").value = f.dataset.trf; draw(); $("#trQ").scrollIntoView({block:"nearest", behavior:"smooth"}); return; }
    const k = e.target.closest("[data-trkill]");
    if(k){
      k.disabled = true;
      try{ const d = await cmd(r.id, "mihomo.api", {method:"DELETE", path:"/connections/" + k.dataset.trkill}); flash(d.ok ? "Соединение закрыто" : (d.error || "Не удалось закрыть"), !d.ok); poll(); }
      catch(err){ flash(err.message, true); k.disabled = false; }
    }
  });

  async function fetchSnap(){
    if(!T.legacy){
      try{
        const d = await cmd(r.id, "traffic", {limit:300});
        if(d.ok !== false) return d;
        if(!/unknown command/.test(d.error || "")) throw new Error(d.error || "нет данных");
      }catch(e){ if(!/unknown command|неизвестная команда/.test(e.message)) throw e; }
      T.legacy = true;
    }
    const d = await cmd(r.id, "mihomo.api", {method:"GET", path:"/connections"});
    if(!d.ok) throw new Error(d.error || ("mihomo API: HTTP " + d.code));
    return trFromMihomo(d.data);
  }

  async function poll(){
    if(T.busy || T.paused || document.hidden || !$("#trRows")) return;
    T.busy = true;
    try{
      const d = await fetchSnap(), now = Date.now();
      if(T.prev){
        const dt = Math.max(0.5, (now - T.prevAt) / 1000), old = new Map(T.prev.conns.map(c => [c.id, c]));
        T.rates = new Map(d.conns.map(c => { const o = old.get(c.id);
          return [c.id, o ? {dn:Math.max(0,(c.down-o.down)/dt), up:Math.max(0,(c.up-o.up)/dt)} : {dn:0, up:0}]; }));
        T.hist.push({dn:Math.max(0,(d.down_total-T.prev.down_total)/dt), up:Math.max(0,(d.up_total-T.prev.up_total)/dt)});
        if(T.hist.length > TR_HIST) T.hist.shift();
      }
      T.prev = d; T.prevAt = now; T.data = d; T.leases = d.leases || {}; T.err = "";
    }catch(e){ T.err = e.message; }
    T.busy = false;
    draw();
  }

  function group(list, keyFn, labelFn){
    const m = new Map();
    for(const c of list){
      const k = keyFn(c), g = m.get(k) || {key:k, label:labelFn ? labelFn(c) : k, dn:0, up:0, total:0, n:0};
      const rt = T.rates.get(c.id) || {dn:0, up:0};
      g.dn += rt.dn; g.up += rt.up; g.total += c.up + c.down; g.n++; m.set(k, g);
    }
    return [...m.values()].sort((a,b) => (b.dn+b.up) - (a.dn+a.up) || b.total - a.total).slice(0, 8);
  }
  function drawList(el, groups){
    if(!groups.length){ el.innerHTML = `<div class="muted small">Нет соединений</div>`; return; }
    const maxS = Math.max(...groups.map(g => g.dn+g.up)), maxT = Math.max(...groups.map(g => g.total));
    el.innerHTML = groups.map(g => { const w = maxS > 0 ? (g.dn+g.up)/maxS : g.total/(maxT||1);
      return `<button class="tritem" data-trf="${esc(g.key)}" title="Показать соединения">
        <span class="trname">${g.html ? fname(g.label) : esc(g.label)}</span><span class="trval">${maxS > 0 ? speed(g.dn+g.up) : bytes(g.total)}</span>
        <span class="bar"><i style="width:${Math.max(2, Math.round(w*100))}%"></i></span>
        <span class="small muted">${g.n} соед. · ${bytes(g.total)}</span></button>`; }).join("");
  }
  function drawChart(){
    const el = $("#trChart"), h = T.hist; if(!el) return;
    if(h.length < 2){ el.innerHTML = `<div class="muted small">График появится через несколько секунд</div>`; return; }
    const W = 600, H = 120, n = TR_HIST - 1, max = Math.max(1024, ...h.map(p => Math.max(p.dn, p.up)));
    const x = i => (W * (n - (h.length - 1 - i)) / n).toFixed(1), y = v => (H - 4 - (H - 8) * v / max).toFixed(1);
    const line = k => h.map((p,i) => `${i ? "L" : "M"}${x(i)},${y(p[k])}`).join("");
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
      <line x1="0" x2="${W}" y1="${y(max)}" y2="${y(max)}" class="gl"/><line x1="0" x2="${W}" y1="${y(max/2)}" y2="${y(max/2)}" class="gl"/>
      <path d="${line("dn")}L${x(h.length-1)},${H}L${x(0)},${H}Z" class="area dn"/><path d="${line("dn")}" class="ln dn"/><path d="${line("up")}" class="ln up"/></svg>
      <span class="trmax small muted">${speed(max)}</span><span class="trlegend small"><i class="dn"></i>загрузка <i class="up"></i>отдача · 3 мин</span>`;
  }

  function draw(){
    if(!$("#trRows")) return;
    const d = T.data;
    $("#trInfo").textContent = T.err ? "ошибка: " + T.err : T.paused ? "пауза" : d ? `обновляется каждые ${TR_POLL/1000} с${T.legacy ? " · старый агент: без имён устройств" : ""}` : "подключаюсь…";
    $("#trInfo").className = "small " + (T.err ? "err" : "muted");
    if(!d) return;
    const last = T.hist[T.hist.length - 1];
    $("#trDn").textContent = last ? speed(last.dn) : "…";
    $("#trUp").textContent = last ? speed(last.up) : "…";
    $("#trCnt").textContent = d.count;
    $("#trTot").textContent = `↓ ${bytes(d.down_total)} · ↑ ${bytes(d.up_total)}`;
    drawChart();
    drawList($("#trByNode"), group(d.conns, trNode).map(g => ({...g, html:true})));
    drawList($("#trByDev"), group(d.conns, c => c.src || "—", c => trDev(T, c.src)));
    drawList($("#trByRule"), group(d.conns, trRule));

    const q = T.q;
    let rows = d.conns.filter(c => !q || [c.host, c.dst, c.src, T.leases[c.src], c.rule, c.payload, trRule(c), trRoute(c), c.proc, ...(c.chain||[])]
      .some(v => v && String(v).toLowerCase().includes(q)));
    const rt = c => T.rates.get(c.id) || {dn:0, up:0};
    rows.sort(T.sort === "total" ? (a,b) => (b.up+b.down)-(a.up+a.down)
      : T.sort === "new" ? (a,b) => (Date.parse(b.start)||0) - (Date.parse(a.start)||0)
      : (a,b) => (rt(b).dn+rt(b).up) - (rt(a).dn+rt(a).up) || (b.up+b.down)-(a.up+a.down));
    const shown = rows.slice(0, 150);
    $("#trRows").innerHTML = shown.length ? shown.map(c => { const s = rt(c), direct = trNode(c) === "DIRECT";
      return `<tr>
        <td class="c-host"><div class="trhost">${esc(c.host || c.dst || "—")}${c.port ? `<span class="muted">:${esc(c.port)}</span>` : ""}</div>
          <div class="small muted">${esc((c.net||"").toUpperCase())}${c.type ? " · " + esc(c.type) : ""}${c.host && c.dst ? " · " + esc(c.dst) : ""}${c.proc ? " · " + esc(c.proc) : ""}</div></td>
        <td class="c-dev">${esc(trDev(T, c.src))}${T.leases[c.src] ? `<div class="small muted">${esc(c.src)}</div>` : ""}</td>
        <td class="small c-rule">${esc(trRule(c))}</td>
        <td class="c-route"><span class="route${direct ? " direct" : ""}">${(c.chain || []).slice().reverse().map(fname).join(" → ") || "—"}</span></td>
        <td class="num c-speed">${s.dn || s.up ? `${speed(s.dn)}<div class="small muted">${speed(s.up)}</div>` : `<span class="muted">—</span>`}</td>
        <td class="num c-total">${bytes(c.down + c.up)}</td>
        <td class="num muted c-age">${trAge(c.start)}</td>
        ${canEdit() ? `<td class="c-kill"><button class="ghost small" data-trkill="${esc(c.id)}" title="Закрыть соединение" aria-label="Закрыть соединение">✕</button></td>` : ""}</tr>`; }).join("")
      : `<tr><td colspan="8" class="muted small">${q ? "Ничего не найдено" : "Нет активных соединений"}</td></tr>`;
    $("#trFoot").textContent = d.count > d.conns.length || rows.length > shown.length
      ? `Показано ${shown.length} из ${d.count} соединений (самые активные).` : "";
  }

  every(TR_POLL, poll);
  poll();
}
