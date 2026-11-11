// nikki-fleet panel: copy a subscription (proxy-provider) to other routers.
// The provider is copied 1:1 (link, device headers, health check, filters…);
// on the target it is built in like the configurator's one-click subscription:
// groups by the target's own pattern ("<name>-Best", "<name>-Manual", …), placed
// next to their siblings in parent groups; nothing else in the target changes.
// SPDX-License-Identifier: GPL-3.0-or-later
"use strict";

const SC_BUILTIN = ["DIRECT", "REJECT", "REJECT-DROP", "PASS", "COMPATIBLE", "GLOBAL"];
const scClone = x => JSON.parse(JSON.stringify(x));
const scUUID = () => crypto.randomUUID ? crypto.randomUUID() : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, c => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));
function scSplitRule(s){
  const out = []; let d = 0, cur = "";
  for(const ch of String(s)){ if(ch === "(") d++; else if(ch === ")") d--; if(ch === "," && d === 0){ out.push(cur); cur = ""; } else cur += ch; }
  out.push(cur); return out.map(x => x.trim());
}
// rule target: MATCH,<t> / TYPE,value,<t>[,opts]
const scRuleTarget = r => { const p = scSplitRule(r); return (p[0]||"").toUpperCase() === "MATCH" ? p[1] : p[2]; };
const scRuleKey = r => { const p = scSplitRule(r); return (p[0]||"").toUpperCase() === "MATCH" ? "MATCH" : [p[0], p[1], ...p.slice(3)].join("\u0001"); };
const scRetarget = (r, t) => { const p = scSplitRule(r); if((p[0]||"").toUpperCase() === "MATCH") p[1] = t; else p[2] = t; return p.join(","); };

// Merge provider `prov` named `name` into config object `doc` (changed in place).
// Returns a summary of what changed.
function scMerge(doc, name, prov, opts){
  const out = {mode:"", name, groups:[], parents:[], rules:0};
  const pp = doc["proxy-providers"] = doc["proxy-providers"] || {};
  const groups = doc["proxy-groups"] = doc["proxy-groups"] || [];
  const rules = doc.rules = doc.rules || [];
  const p = scClone(prov);
  if(opts?.newHwid && p.header && p.header["x-hwid"]) p.header["x-hwid"] = [scUUID()];

  // already there (same name or same link): only its parameters are replaced
  const same = Object.keys(pp).find(k => k === name) || Object.keys(pp).find(k => pp[k]?.url && pp[k].url === p.url);
  if(same){
    const keep = pp[same];
    pp[same] = p;
    if(keep?.path && !opts?.copyPath) p.path = keep.path; // keep the target's cache file
    out.same = JSON.stringify(keep) === JSON.stringify(p);
    out.mode = "updated"; out.name = same;
    return out;
  }

  const taken = n => n in pp || groups.some(g => g.name === n) || SC_BUILTIN.includes(n);
  let n = name, i = 2; while(taken(n)) n = name + (i++);
  out.name = n; out.mode = "added";
  // path: unique cache file in the target
  const paths = new Set(Object.values(pp).map(x => x?.path));
  if(!p.path || paths.has(p.path)){
    // follow the target's own naming: "./abra.yaml" for Abra → "./nova.yaml"
    let tpl = null;
    for(const [k, v] of Object.entries(pp)){ const i = String(v?.path || "").toLowerCase().lastIndexOf(k.toLowerCase()); if(i >= 0) tpl = [v.path, i, k.length]; }
    const mk = (sfx) => tpl ? tpl[0].slice(0, tpl[1]) + n.toLowerCase() + sfx + tpl[0].slice(tpl[1] + tpl[2]) : `./providers/${n.toLowerCase()}${sfx}.yaml`;
    let j = 1; p.path = mk(""); while(paths.has(p.path)) p.path = mk("-" + (++j));
  }
  pp[n] = p;

  // per-subscription groups of the target: group name contains its provider name and uses it
  const pats = new Map();
  for(const pn of Object.keys(pp)){
    if(pn === n) continue;
    for(const g of groups){
      const gn = String(g.name), use = Array.isArray(g.use) ? g.use : [];
      const at = gn.toLowerCase().indexOf(pn.toLowerCase());
      if(at < 0 || !use.includes(pn)) continue;
      const key = gn.slice(0, at) + "{N}" + gn.slice(at + pn.length);
      if(key === "{N}") continue;
      // the longest provider name wins (SilVPN vs VPN)
      let dup = null; for(const [k, v] of pats){ const x = v.find(y => y.group === g); if(x) dup = [k, x]; }
      if(dup){ if(dup[1].prov.length >= pn.length) continue; const arr = pats.get(dup[0]); arr.splice(arr.indexOf(dup[1]), 1); }
      if(!pats.has(key)) pats.set(key, []);
      pats.get(key).push({prov:pn, group:g});
    }
  }
  for(const [k, v] of pats) if(!v.length) pats.delete(k);

  const parents = new Set();
  if(pats.size){
    for(const [key, inst] of pats){
      const gname = key.replace("{N}", n);
      if(groups.some(g => g.name === gname)) continue;
      const rep = inst[inst.length - 1].group;
      const data = scClone(rep); data.name = gname;
      // providers present in every group of the pattern besides their own (e.g. a backup subscription)
      const owners = inst.map(x => x.prov);
      const shared = (Array.isArray(rep.use) ? rep.use : []).filter(u => !owners.includes(u) && inst.every(x => (x.group.use||[]).includes(u)));
      data.use = [n, ...shared];
      if(Array.isArray(data.proxies)) data.proxies = data.proxies.filter(x => SC_BUILTIN.includes(x) || groups.some(g => g.name === x));
      if(Array.isArray(data.proxies) && !data.proxies.length) delete data.proxies;
      const last = Math.max(...inst.map(x => groups.indexOf(x.group)));
      groups.splice(last + 1, 0, data);
      out.groups.push(gname);
      const names = inst.map(x => x.group.name);
      for(const g of groups){
        if(!Array.isArray(g.proxies) || g.name === gname) continue;
        const idx = g.proxies.reduce((m, x, j) => names.includes(x) ? j : m, -1);
        if(idx >= 0 && !g.proxies.includes(gname)){ g.proxies.splice(idx + 1, 0, gname); parents.add(g.name); }
      }
      // rules repeated for every subscription of the pattern are repeated for the new one
      const byKey = new Map();
      rules.forEach((r, j) => { if(names.includes(scRuleTarget(r))){ const k = scRuleKey(r); if(!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(j); } });
      for(const [, idxs] of [...byKey].reverse()){
        if(idxs.length < names.length) continue;
        const at = idxs[idxs.length - 1];
        rules.splice(at + 1, 0, scRetarget(rules[at], gname)); out.rules++;
      }
    }
  } else {
    const hc = p["health-check"]?.url || "http://www.gstatic.com/generate_204";
    for(const d of [{name:`${n}-Best`, type:"url-test", url:hc, interval:300, tolerance:50, use:[n]}, {name:`${n}-Manual`, type:"select", use:[n]}]){
      if(groups.some(g => g.name === d.name)) continue;
      groups.push(d); out.groups.push(d.name);
    }
    const cnt = {}; rules.forEach(r => { const t = scRuleTarget(r); cnt[t] = (cnt[t]||0) + 1; });
    const sel = groups.filter(g => g.type === "select" && !out.groups.includes(g.name));
    const main = sel.find(g => /^proxy$/i.test(g.name)) || sel.sort((a, b) => (cnt[b.name]||0) - (cnt[a.name]||0))[0];
    if(main){
      main.proxies = Array.isArray(main.proxies) ? main.proxies : [];
      const di = main.proxies.indexOf("DIRECT");
      main.proxies.splice(di >= 0 ? di : main.proxies.length, 0, ...out.groups.filter(x => !main.proxies.includes(x)));
      parents.add(main.name);
    }
  }
  out.parents = [...parents];
  return out;
}

// YAML in the same style as the configurator (flow lists, inline headers, blank lines)
function scDump(obj){
  let y = jsyaml.dump(obj, {lineWidth:-1, noRefs:true, quotingType:'"'});
  y = y.replace(/^(\s+)(User-Agent|x-[\w-]+):\n\1  - (.+)$(?!\n\1  - )/gm, (m, ind, k, v) => {
    const val = /^["']/.test(v) ? jsyaml.load(v) : v;
    return `${ind}${k}: [${JSON.stringify(String(val))}]`;
  });
  y = y.replace(/^(\s+)(proxies|use):\n((?:\1  - [^\n]*(?:\n|$))+)/gm, (m, ind, k, body) => {
    const items = body.replace(/\n$/, "").split("\n").map(l => l.replace(/^\s+- /, ""));
    const fl = items.map(v => /^["']/.test(v) || !/[,\[\]{}#&*!|>%@`]/.test(v) ? v : JSON.stringify(v));
    return `${ind}${k}: [${fl.join(", ")}]` + (body.endsWith("\n") ? "\n" : "");
  });
  { const L = y.split("\n"), o = [];
    L.forEach((l, i) => { if(i > 0 && /^[A-Za-z]/.test(l) && (/:\s*$/.test(l) || /^\s/.test(L[i-1]))) o.push(""); o.push(l); });
    y = o.join("\n"); }
  for(const sec of ["proxy-providers", "rule-providers"])
    y = y.replace(new RegExp(`(^${sec}:\\n)([\\s\\S]*?)(?=\\n\\n\\S|(?![\\s\\S]))`, "m"), (m, h, b) => h + b.replace(/\n(?=  [^\s-][^\n]*:\n)/g, "\n\n"));
  y = y.replace(/(^proxy-groups:\n)([\s\S]*?)(?=\n\n\S|(?![\s\S]))/m, (m, h, b) => h + b.replace(/\n(?=  - name: )/g, "\n\n"));
  return y;
}

async function scActiveProfile(rid){
  const pl = await cmd(rid, "profiles.list"), act = pl.active || {};
  if(!act.name) throw new Error("на роутере не выбран активный профиль");
  const d = await cmd(rid, "profile.read", {kind:act.kind, name:act.name});
  if(d.ok === false || typeof d.content !== "string") throw new Error(d.error || "не удалось прочитать профиль");
  return {kind:act.kind, name:act.name, content:d.content};
}

async function subCopyDialog(src, provName){
  await stLoadYaml().catch(e => { flash(e.message, true); throw e; });
  let routers = [];
  try{ routers = await get("/api/routers"); }catch(e){ return flash(e.message, true); }
  const targets = routers.filter(x => x.id !== src.id);
  openDialog(`<h2>Копировать подписку «${esc(provName)}»</h2>
    <div class="small muted">Подписка переносится один в один: ссылка, заголовки устройства (клиент, ОС, версия, модель, x-hwid), проверка узлов, фильтры. На целевом роутере появятся её группы по его же образцу и место в его главной группе; остальные группы, правила, DNS и подписки не меняются. Сохранение — с проверкой mihomo -t, резервной копией и автооткатом.</div>
    <div class="sclist">${targets.length ? targets.map(t => {
      const can = t.online && (t.role === "owner" || t.role === "editor");
      return `<label class="scitem${can ? "" : " off"}"><input type="checkbox" value="${esc(t.id)}"${can ? "" : " disabled"}><b>${esc(t.name)}</b><span class="small muted">${!t.online ? "не в сети" : !can ? "только просмотр" : ""}</span><span class="scres small" data-res="${esc(t.id)}"></span></label>`;
    }).join("") : `<div class="note">Других роутеров в панели нет.</div>`}</div>
    <label class="row small"><input type="checkbox" id="scHwid" style="width:auto"> новый x-hwid для каждого целевого роутера (по умолчанию — тот же, что у источника)</label>
    <div class="err small" id="scErr"></div>
    <div class="row end"><button data-close>Закрыть</button><button id="scPrev">Показать изменения</button><button class="primary" id="scGo">Копировать</button></div>`, body => {
    let plan = null;
    const chosen = () => [...body.querySelectorAll(".sclist input:checked")].map(x => x.value);
    const res = (id, html, cls) => { const e = body.querySelector(`[data-res="${CSS.escape(id)}"]`); if(e){ e.innerHTML = html; e.className = "scres small " + (cls||""); } };
    body.addEventListener("change", e => { if(e.target.matches(".sclist input, #scHwid")){ plan = null; } });

    async function prepare(){
      $("#scErr").textContent = "";
      const ids = chosen(); if(!ids.length){ $("#scErr").textContent = "Выберите хотя бы один роутер"; return null; }
      const s = await scActiveProfile(src.id);
      const sdoc = jsyaml.load(s.content) || {};
      const prov = sdoc["proxy-providers"]?.[provName];
      if(!prov) throw new Error(`в активном профиле источника (${s.name}) нет подписки «${provName}» — возможно, она приходит из настроек Nikki, а не из профиля`);
      const out = [];
      for(const id of ids){
        res(id, "читаю профиль…");
        try{
          const t = await scActiveProfile(id);
          const doc = jsyaml.load(t.content) || {};
          const sum = scMerge(doc, provName, prov, {newHwid: $("#scHwid").checked});
          if(sum.same){ res(id, `подписка «${esc(sum.name)}» уже такая же — менять нечего`, "ok"); continue; }
          const txt = sum.mode === "updated"
            ? `обновятся параметры подписки «${esc(sum.name)}», группы не меняются`
            : `новая подписка «${esc(sum.name)}»; группы: ${sum.groups.map(esc).join(", ") || "—"}${sum.parents.length ? "; в " + sum.parents.map(esc).join(", ") : ""}${sum.rules ? `; правил: ${sum.rules}` : ""}`;
          const line = txt + (t.kind === "subscription" ? ` <span class="err">— активный профиль это подписка Nikki: при её обновлении изменения могут перезаписаться</span>` : "");
          res(id, line);
          out.push({id, kind:t.kind, name:t.name, content:scDump(doc), line});
        }catch(e){ res(id, esc(e.message), "err"); }
      }
      return out;
    }
    $("#scPrev").onclick = async e => {
      const b = e.currentTarget; b.disabled = true;
      try{ plan = await prepare(); if(plan && !plan.length) $("#scErr").textContent = "Записывать нечего"; }
      catch(err){ $("#scErr").textContent = err.message; }
      b.disabled = false;
    };
    $("#scGo").onclick = async e => {
      const b = e.currentTarget;
      b.disabled = true; $("#scPrev").disabled = true;
      const done = () => { b.disabled = false; $("#scPrev").disabled = false; };
      // without a preview: prepare now (the summary is shown in the same rows)
      if(!plan){ try{ plan = await prepare(); }catch(err){ $("#scErr").textContent = err.message; return done(); } }
      if(!plan?.length){ if(plan) $("#scErr").textContent = "Записывать нечего"; plan = null; return done(); }
      let ok = 0;
      for(const p of plan){
        const st = (h, c) => res(p.id, p.line + "<br>" + h, c);
        st("сохраняю и проверяю…");
        try{
          const d = await cmd(p.id, "profile.write", {kind:p.kind, name:p.name, content:p.content, activate:false, reload:true});
          if(d.ok){ ok++; st(d.nikki_disabled ? "сохранено ✓ (Nikki выключен — применится при включении)" : "готово ✓ — mihomo перезапущен", "ok"); }
          else st(esc(d.stage === "test" ? "mihomo не принял конфиг, ничего не изменено: " + String(d.output || "").split("\n").filter(Boolean).slice(-2).join(" ")
            : d.stage === "reload" ? "mihomo не запустился с новым конфигом — возвращена прежняя версия" : (d.error || "ошибка")), "err");
        }catch(err){ st(esc(err.message), "err"); }
      }
      flash(`Скопировано: ${ok} из ${plan.length}`, ok !== plan.length);
      plan = null; done();
    };
  });
}
