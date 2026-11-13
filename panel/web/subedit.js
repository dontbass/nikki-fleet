// nikki-fleet panel: add or remove a subscription right from Proxies → Subscriptions.
//
// Safety, in order:
//  1. the active profile is read fresh from the router (a Nikki subscription
//     profile is refused: its next update would undo the change);
//  2. the change is planned on the parsed config (same engine as the one-click
//     add and the copy to other routers: groups by the router's own pattern);
//  3. the result is verified here before anything is sent: every section the
//     change does not touch is identical, no new dangling reference (group,
//     provider, rule target, rule-provider proxy) and no group left empty, and
//     the written YAML parses back to exactly the planned config;
//  4. the router writes it only if the profile is still the one we read
//     ("expect"), runs mihomo -t, keeps a backup, restarts and rolls back by
//     itself if mihomo does not come up or the panel cannot be reached;
//  5. afterwards the change can be undone with one button (the previous text is
//     written back the same safe way) and every version is in History.
// SPDX-License-Identifier: GPL-3.0-or-later
"use strict";

const SE_SKIP = new Set(["www","sub","subs","api","cdn","s","x","xo","vpn","panel","link","get","my","app","go","url"]);
const SE_TOUCHED = new Set(["proxy-providers", "proxy-groups", "rules", "rule-providers"]);

/* ---------- helpers ---------- */
function seStable(v){ // JSON with sorted keys: order-independent comparison
  if(Array.isArray(v)) return "[" + v.map(seStable).join(",") + "]";
  if(v && typeof v === "object") return "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + seStable(v[k])).join(",") + "}";
  return JSON.stringify(v);
}
const seEq = (a, b) => seStable(a) === seStable(b);
const seGroups = d => Array.isArray(d["proxy-groups"]) ? d["proxy-groups"] : [];
const seProv = d => d["proxy-providers"] && typeof d["proxy-providers"] === "object" ? d["proxy-providers"] : {};
const seRuleTarget = r => typeof r === "string" ? scRuleTarget(r) : null;

function seNameFromUrl(u, doc){
  let host = ""; try{ host = new URL(u).hostname; }catch(e){}
  let base;
  if(/^\d+\.\d+\.\d+\.\d+$/.test(host)) base = "sub" + host.split(".").pop();
  else { const parts = host.split(".").filter(Boolean); base = parts.slice(0, -1).reverse().find(x => !SE_SKIP.has(x.toLowerCase()) && x.length > 1) || parts[0] || "sub"; }
  base = base.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24) || "sub";
  let n = base, i = 2; while(seTaken(doc, n)) n = base + (i++);
  return n;
}
const seTaken = (doc, n) => { const l = n.toLowerCase(); return Object.keys(seProv(doc)).some(k => k.toLowerCase() === l) || seGroups(doc).some(g => String(g.name).toLowerCase() === l) || SC_BUILTIN.includes(n); };

// the provider most subscriptions look like (device headers, checks, interval); a tie goes to the first one
function seTemplate(doc){
  const ps = Object.values(seProv(doc)).filter(p => p && String(p.type || "").toLowerCase() === "http");
  if(!ps.length) return {type:"http", interval:3600, "health-check":{enable:true, url:"https://www.gstatic.com/generate_204", interval:300}};
  const key = p => seStable(p.header || {}), cnt = {};
  ps.forEach(p => cnt[key(p)] = (cnt[key(p)] || 0) + 1);
  const t = scClone(ps.reduce((a, b) => cnt[key(b)] > cnt[key(a)] ? b : a));
  for(const k of ["url", "path", "filter", "exclude-filter", "exclude-type", "payload"]) delete t[k];
  return t;
}

// names a value may reference: groups, static proxies, built-ins
function seNames(d){
  return new Set([...seGroups(d).map(g => g.name), ...(Array.isArray(d.proxies) ? d.proxies.map(p => p?.name) : []), ...SC_BUILTIN]);
}
// every reference that points nowhere (and empty groups) — to compare before/after
function seDangling(d){
  const out = new Set(), names = seNames(d), provs = new Set(Object.keys(seProv(d)));
  for(const g of seGroups(d)){
    const use = Array.isArray(g.use) ? g.use : [], px = Array.isArray(g.proxies) ? g.proxies : [];
    use.forEach(u => provs.has(u) || out.add(`группа ${g.name}: нет подписки ${u}`));
    px.forEach(p => names.has(p) || out.add(`группа ${g.name}: нет «${p}»`));
    if(!use.length && !px.length && !g["include-all"] && !g["include-all-proxies"] && !g["include-all-providers"]) out.add(`группа ${g.name} пустая`);
  }
  (Array.isArray(d.rules) ? d.rules : []).forEach(r => { const t = seRuleTarget(r); if(t && !names.has(t)) out.add(`правило «${r}» ведёт в несуществующую группу`); });
  for(const [k, rp] of Object.entries(d["rule-providers"] || {})) if(rp?.proxy && !names.has(rp.proxy)) out.add(`набор правил ${k}: нет группы ${rp.proxy}`);
  return out;
}

/* ---------- planning ---------- */
function sePlanAdd(doc, {url, name, header}){
  url = String(url || "").trim();
  if(!/^https?:\/\/[^\s]+$/i.test(url)) throw new Error("Нужна ссылка вида https://…");
  const dup = Object.entries(seProv(doc)).find(([, p]) => p?.url === url);
  if(dup) throw new Error(`Эта ссылка уже есть в конфиге — подписка «${dup[0]}»`);
  name = String(name || "").trim() || seNameFromUrl(url, doc);
  if(!/^[\p{L}\p{N}_.-]{1,40}$/u.test(name)) throw new Error("Имя: буквы, цифры, _ . - (до 40 символов)");
  if(seTaken(doc, name)) throw new Error(`Имя «${name}» уже занято в конфиге`);
  const p = seTemplate(doc);
  p.url = url;
  if(header) p.header = header;
  const sum = scMerge(doc, name, p, {});
  return {kind:"add", name:sum.name, groups:sum.groups, parents:sum.parents.filter(x => !(sum.pools || []).includes(x)), pools:sum.pools || [], rules:sum.rules || 0, mode:sum.mode, path:p.path};
}

function sePlanRemove(doc, name){
  const pp = seProv(doc);
  if(!(name in pp)) throw new Error(`В активном профиле нет подписки «${name}» — возможно, её добавляет не профиль, а настройки Nikki`);
  const groups = seGroups(doc), lo = name.toLowerCase();
  const before = new Map(groups.map(g => [g.name, scClone(g)]));
  // own groups: named after it and using it (a longer subscription name wins: VPN vs SilVPN)
  const own = groups.filter(g => {
    const gl = String(g.name).toLowerCase(), use = Array.isArray(g.use) ? g.use : [];
    if(!use.includes(name) || !gl.includes(lo) || gl === lo) return false;
    return !Object.keys(pp).some(o => o !== name && o.length > name.length && o.toLowerCase().includes(lo) && gl.includes(o.toLowerCase()) && use.includes(o));
  }).map(g => g.name);
  const gone = new Set(own), fromUse = [];
  delete pp[name];
  for(const g of groups) if(Array.isArray(g.use) && g.use.includes(name)){ g.use = g.use.filter(u => u !== name); if(!gone.has(g.name)) fromUse.push(g.name); }
  // cascade: a group that only had what was removed is removed too
  const cascade = [];
  for(let changed = true; changed;){
    changed = false;
    for(const g of groups){
      if(gone.has(g.name)) continue;
      if(Array.isArray(g.proxies)) g.proxies = g.proxies.filter(m => !gone.has(m));
      const was = before.get(g.name), wasEmpty = !(was.use || []).length && !(was.proxies || []).length;
      const empty = !(g.use || []).length && !(g.proxies || []).length && !g["include-all"] && !g["include-all-proxies"] && !g["include-all-providers"];
      if(empty && !wasEmpty){ gone.add(g.name); cascade.push(g.name); changed = true; }
    }
  }
  for(const g of groups){ if(Array.isArray(g.use) && !g.use.length && g.proxies?.length) delete g.use; }
  // where a removed group sat: the first kept group that listed it (followed upwards)
  const parentOf = n => { const seen = new Set(); let cur = n;
    while(cur && gone.has(cur) && !seen.has(cur)){ seen.add(cur); const p = [...before.values()].find(g => (g.proxies || []).includes(cur)); cur = p ? p.name : null; }
    return cur && !gone.has(cur) ? cur : null; };
  // rules into removed groups: a duplicate of a sibling's rule is dropped, a unique one goes to the parent group
  const rules = Array.isArray(doc.rules) ? doc.rules : [], kept = [], moved = [], stuck = [];
  let dropped = 0;
  for(const r of rules){
    const t = seRuleTarget(r);
    if(!t || !gone.has(t)){ kept.push(r); continue; }
    if(rules.some(o => o !== r && !gone.has(seRuleTarget(o)) && scRuleKey(o) === scRuleKey(r))){ dropped++; continue; }
    const to = parentOf(t);
    if(to){ kept.push(scRetarget(r, to)); moved.push(`${r} → ${to}`); } else { stuck.push(r); kept.push(r); }
  }
  if(Array.isArray(doc.rules)) doc.rules = kept;
  for(const [k, rp] of Object.entries(doc["rule-providers"] || {})) if(rp?.proxy && gone.has(rp.proxy)){
    const to = parentOf(rp.proxy); if(to){ moved.push(`набор правил ${k} → ${to}`); rp.proxy = to; } else stuck.push(`набор правил ${k}`);
  }
  if(stuck.length) throw new Error("Не удаляю: на удаляемые группы ссылаются правила, которым некуда перейти:\n" + stuck.join("\n") + "\nУберите их в конфигураторе.");
  // anything else that names a removed group (dns "#GROUP", dialer-proxy…) — refuse rather than guess
  const elsewhere = [];
  for(const [k, v] of Object.entries(doc)){
    if(SE_TOUCHED.has(k)) continue;
    const s = JSON.stringify(v) || "";
    for(const n of gone) if(s.includes(`"${n}"`) || s.includes(`#${n}"`)) elsewhere.push(`${k}: ${n}`);
  }
  if(elsewhere.length) throw new Error("Не удаляю: удаляемые группы используются вне групп и правил:\n" + elsewhere.join("\n"));
  doc["proxy-groups"] = groups.filter(g => !gone.has(g.name));
  return {kind:"remove", name, groups:own, cascade, fromUse, dropped, moved};
}

// everything must hold before the text leaves the browser
function seVerify(orig, next){
  for(const k of new Set([...Object.keys(orig), ...Object.keys(next)]))
    if(!SE_TOUCHED.has(k) && !seEq(orig[k], next[k])) throw new Error(`Проверка не пройдена: изменился раздел «${k}», которого правка не касается`);
  const was = seDangling(orig), now = [...seDangling(next)].filter(x => !was.has(x));
  if(now.length) throw new Error("Проверка не пройдена — появились бы битые ссылки:\n" + now.join("\n"));
  const text = scDump(next);
  if(!seEq(jsyaml.load(text), next)) throw new Error("Проверка не пройдена: YAML после записи читается иначе");
  return text;
}

// line diff for the preview (only changed lines with a little context)
function seDiff(a, b){
  const A = a.split("\n"), B = b.split("\n"), n = A.length, m = B.length;
  if(n * m > 4e6) return `<div class="small muted">Конфиг слишком большой для показа разницы.</div>`;
  const L = Array.from({length:n + 1}, () => new Uint32Array(m + 1));
  for(let i = n - 1; i >= 0; i--) for(let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i+1][j+1] + 1 : Math.max(L[i+1][j], L[i][j+1]);
  const ops = []; let i = 0, j = 0;
  while(i < n || j < m){
    if(i < n && j < m && A[i] === B[j]){ ops.push([" ", A[i]]); i++; j++; }
    else if(j < m && (i >= n || L[i][j+1] >= L[i+1][j])){ ops.push(["+", B[j]]); j++; }
    else { ops.push(["-", A[i]]); i++; }
  }
  const show = new Set(); ops.forEach((o, k) => { if(o[0] !== " ") for(let x = k - 2; x <= k + 2; x++) show.add(x); });
  let out = "", last = -2;
  ops.forEach((o, k) => { if(!show.has(k)) return; if(k !== last + 1) out += `<div class="dl gap">⋯</div>`; out += `<div class="dl ${o[0] === "+" ? "add" : o[0] === "-" ? "del" : ""}">${esc(o[0] + " " + o[1])}</div>`; last = k; });
  return out || `<div class="small muted">Текст не изменился.</div>`;
}

/* ---------- the dialog ---------- */
// mode: "add" | "remove"; onDone() reloads the tab
async function subEditDialog(r, mode, provName, onDone){
  try{ await stLoadYaml(); }catch(e){ return flash(e.message, true); }
  let prof, doc, tpl;
  const steps = [];
  openDialog(`<h2>${mode === "add" ? "Новая подписка" : `Удалить подписку «${esc(provName)}»`}</h2><div id="seBody"><div class="muted small">Читаю профиль роутера…</div></div>`, async body => {
    const box = body.querySelector("#seBody");
    try{
      prof = await scActiveProfile(r.id);
      if(prof.kind === "subscription") throw new Error(`Активный профиль «${prof.name}» — подписка Nikki: при её следующем обновлении правка пропадёт. Сделайте активным профиль-файл (например, через «Конфигуратор» → «Сохранить как новый профиль») и повторите.`);
      doc = jsyaml.load(prof.content) || {};
      if(typeof doc !== "object" || Array.isArray(doc)) throw new Error("Профиль не похож на конфиг mihomo");
    }catch(e){ box.innerHTML = `<div class="err small" style="white-space:pre-wrap">${esc(e.message)}</div><div class="row end"><button data-close>Закрыть</button></div>`; return; }
    const comments = /(^|\s)#(?![^\n]*["'])/m.test(prof.content);
    mode === "add" ? formAdd() : planAndConfirm({name: provName});

    function formAdd(v = {}){
      tpl = seTemplate(doc);
      const h = v.header || tpl.header || {}, hv = k => esc((Array.isArray(h[k]) ? h[k][0] : h[k]) ?? "");
      box.innerHTML = `
        <label class="f"><span>Ссылка подписки</span>
          <div class="row nowrap"><input id="seUrl" placeholder="https://…" value="${esc(v.url || "")}" autocomplete="off" spellcheck="false" style="flex:1">
          <button type="button" id="sePaste" title="Вставить из буфера">Вставить</button></div></label>
        <label class="f"><span>Название (по нему назовутся группы)</span><input id="seName" value="${esc(v.name || "")}" placeholder="определится по ссылке" maxlength="40" spellcheck="false"></label>
        <details class="sedet"${v.header ? " open" : ""}><summary>Заголовки устройства — как у большинства подписок этого роутера</summary>
          <div class="segrid">
            ${[["User-Agent","Клиент (User-Agent)"],["x-hwid","x-hwid"],["x-device-os","ОС"],["x-ver-os","Версия ОС"],["x-device-model","Модель"]].map(([k, l]) =>
              `<label class="f"><span>${l}</span><input data-h="${k}" value="${hv(k)}" spellcheck="false"></label>`).join("")}
          </div>
          <button type="button" class="small" id="seHwid">новый x-hwid</button>
        </details>
        <div class="small muted">Остальное — интервал обновления, проверка узлов, путь к файлу — берётся по образцу подписок этого роутера. Группы создадутся так же, как у соседних подписок.</div>
        <div class="err small" id="seErr" style="white-space:pre-wrap"></div>
        <div class="row end"><button data-close>Отмена</button><button class="primary" id="seNext">Далее</button></div>`;
      const url = box.querySelector("#seUrl"), nm = box.querySelector("#seName");
      let nameTouched = !!v.name;
      const auto = () => { if(!nameTouched && /^https?:\/\//.test(url.value.trim())) nm.placeholder = seNameFromUrl(url.value.trim(), doc); };
      url.oninput = auto; nm.oninput = () => { nameTouched = !!nm.value; };
      url.addEventListener("paste", () => setTimeout(auto));
      box.querySelector("#sePaste").onclick = async () => { try{ const t = (await navigator.clipboard.readText()).trim(); const m = t.match(/https?:\/\/\S+/); url.value = m ? m[0] : t; auto(); }catch(e){ flash("Браузер не дал доступ к буферу — вставьте ссылку вручную", true); } };
      box.querySelector("#seHwid").onclick = () => { box.querySelector('[data-h="x-hwid"]').value = scUUID(); box.querySelector("details").open = true; };
      box.querySelector("#seNext").onclick = () => {
        const header = {}; let changed = false;
        box.querySelectorAll("[data-h]").forEach(i => { const val = i.value.trim(); if(val) header[i.dataset.h] = [val]; });
        const tplH = {}; Object.entries(tpl.header || {}).forEach(([k, x]) => tplH[k] = Array.isArray(x) ? x : [x]);
        changed = !seEq(header, Object.fromEntries(Object.entries(tplH).filter(([k]) => ["User-Agent","x-hwid","x-device-os","x-ver-os","x-device-model"].includes(k))));
        const extra = Object.fromEntries(Object.entries(tplH).filter(([k]) => !["User-Agent","x-hwid","x-device-os","x-ver-os","x-device-model"].includes(k)));
        planAndConfirm({url: url.value.trim(), name: nm.value.trim() || nm.placeholder.replace(/^определится.*/, ""), header: changed ? {...extra, ...header} : null, form: {url: url.value, name: nm.value, header: changed ? header : null}});
      };
      setTimeout(() => url.focus());
    }

    function planAndConfirm(o){
      const next = scClone(doc);
      let plan, text;
      try{
        plan = mode === "add" ? sePlanAdd(next, o) : sePlanRemove(next, o.name);
        text = seVerify(doc, next);
      }catch(e){
        if(mode === "add"){ formAdd(o.form); box.querySelector("#seErr").textContent = e.message; }
        else box.innerHTML = `<div class="err small" style="white-space:pre-wrap">${esc(e.message)}</div><div class="row end"><button data-close>Закрыть</button></div>`;
        return;
      }
      const li = (t, xs) => xs.length ? `<li>${t}: <b>${xs.map(esc).join(", ")}</b></li>` : "";
      box.innerHTML = `
        <div class="seplan ${mode}">
          <div class="small muted">Профиль <b>${esc(prof.name)}</b> на ${esc(r.name)}. Изменится:</div>
          <ul>${mode === "add" ? `
            <li>новая подписка <b>${esc(plan.name)}</b> <span class="mono small">${esc(o.url.replace(/^(https?:\/\/[^/]+\/).{6,}$/, "$1…"))}</span></li>
            ${li("свои группы", plan.groups)}${li("встанут в", plan.parents)}${li("добавится в общие группы", plan.pools)}
            ${plan.rules ? `<li>правил по образцу соседей: <b>${plan.rules}</b></li>` : ""}
            ${!plan.groups.length && !plan.pools.length && !plan.parents.length ? `<li class="warn">в конфиге нет образца: подписка будет доступна только в списке подписок — добавьте её в группы в конфигураторе</li>` : ""}`
          : `
            <li>подписка <b>${esc(plan.name)}</b> удаляется</li>
            ${li("удаляются её группы", plan.groups)}${li("удаляются опустевшие группы", plan.cascade)}${li("убирается из общих групп", plan.fromUse)}
            ${plan.dropped ? `<li>убираются повторяющиеся правила: <b>${plan.dropped}</b></li>` : ""}
            ${plan.moved.length ? `<li>переводятся в другую группу:<div class="mono small">${plan.moved.map(esc).join("<br>")}</div></li>` : ""}`}
          </ul>
          <div class="small ok">✓ остальной конфиг не меняется · ✓ ссылки между группами целы · ✓ YAML проверен</div>
          ${comments ? `<div class="small muted">В профиле есть комментарии (#) — при записи они не сохранятся, сам конфиг от этого не меняется.</div>` : ""}
          <details class="sedet"><summary>Что поменяется в тексте</summary><div class="sediff">${seDiff(prof.content.replace(/\s+$/, ""), text.replace(/\s+$/, ""))}</div></details>
        </div>
        <div class="err small" id="seErr" style="white-space:pre-wrap"></div>
        <div class="row end">${mode === "add" ? `<button id="seBack">Назад</button>` : `<button data-close>Отмена</button>`}
          <button class="${mode === "add" ? "primary" : "danger"}" id="seGo">${mode === "add" ? "Добавить и применить" : `Удалить${plan.groups.length + plan.cascade.length ? ` с группами (${plan.groups.length + plan.cascade.length})` : ""}`}</button></div>`;
      box.querySelector("#seBack")?.addEventListener("click", () => formAdd(o.form));
      box.querySelector("#seGo").onclick = () => apply(plan, text);
    }

    async function apply(plan, text){
      const st = (k, s, cls = "") => { const e = box.querySelector(`[data-st="${k}"]`); if(e){ e.className = "st " + cls; e.querySelector("i").textContent = s; } };
      box.innerHTML = `<ul class="steps">
          <li data-st="w" class="st"><i>…</i>Запись на роутер: проверка mihomo -t, резервная копия</li>
          <li data-st="r" class="st"><i>·</i>Перезапуск mihomo с новым конфигом</li>
          ${mode === "add" ? `<li data-st="n" class="st"><i>·</i>Загрузка узлов подписки</li>` : ""}
        </ul><div class="err small" id="seErr" style="white-space:pre-wrap"></div><div class="row end" id="seEnd"></div>`;
      let d;
      try{ d = await cmd(r.id, "profile.write", {kind:prof.kind, name:prof.name, content:text, expect:prof.content, activate:false, reload:true}); }
      catch(e){ d = {ok:false, error:e.message}; }
      const end = box.querySelector("#seEnd"), err = box.querySelector("#seErr");
      if(!d.ok){
        st("w", "✕", "bad");
        err.textContent = d.stage === "conflict" ? "Профиль на роутере изменился, пока открыт этот диалог (например, сохранили из конфигуратора). Ничего не записано — откройте диалог заново."
          : d.stage === "test" ? "mihomo не принял конфиг — на роутере ничего не изменено.\n" + String(d.output || "").split("\n").filter(Boolean).slice(-3).join("\n")
          : d.stage === "reload" ? "mihomo не запустился с новым конфигом — роутер вернул прежнюю версию сам."
          : (d.error || "Ошибка записи");
        end.innerHTML = `<button data-close>Закрыть</button>`; onDone?.(); return;
      }
      st("w", "✓", "ok"); st("r", d.reloaded === false ? "—" : "✓", "ok");
      if(mode === "add"){
        st("n", "…");
        let nodes = null;
        try{
          await cmd(r.id, "mihomo.api", {method:"PUT", path:`/providers/proxies/${encodeURIComponent(plan.name)}`});
          const x = await cmd(r.id, "mihomo.api", {method:"GET", path:`/providers/proxies/${encodeURIComponent(plan.name)}`});
          nodes = x.ok ? (x.data?.proxies || []).length : null;
        }catch(e){}
        if(nodes) st("n", "✓", "ok"), box.querySelector('[data-st="n"]').append(` — ${nodes}`);
        else { st("n", "!", "mid"); err.textContent = nodes === 0 ? "Подписка добавлена, но узлов не пришло: проверьте ссылку и заголовки устройства. Можно отменить добавление кнопкой ниже." : "Подписка добавлена; узлы подгрузятся при следующем обновлении."; }
      }
      end.innerHTML = `<button id="seUndo" title="Вернуть профиль, каким он был до этой правки">↶ Отменить</button><button class="primary" data-close>Готово</button>`;
      box.querySelector("#seUndo").onclick = async e => {
        const b = e.currentTarget; b.disabled = true; b.textContent = "возвращаю…";
        let u; try{ u = await cmd(r.id, "profile.write", {kind:prof.kind, name:prof.name, content:prof.content, expect:text, activate:false, reload:true}); }catch(x){ u = {ok:false, error:x.message}; }
        if(u.ok){ flash("Профиль возвращён"); dlg.close(); }
        else { b.disabled = false; b.textContent = "↶ Отменить"; err.textContent = u.stage === "conflict" ? "Профиль уже изменили ещё раз — верните нужную версию во вкладке «История»." : (u.error || "Не удалось вернуть"); }
        onDone?.();
      };
      flash(mode === "add" ? `Подписка «${plan.name}» добавлена` : `Подписка «${plan.name}» удалена`);
      onDone?.();
    }
  });
}
