// nikki-fleet panel: quick setup — a working profile from the starter template
// (templates/starter.yaml) with the user's subscriptions filled in.
// SPDX-License-Identifier: GPL-3.0-or-later
"use strict";

const ST_HEADERS = {
  happ:  {label:"Happ (Android)", h:{"User-Agent":["Happ"], "x-device-os":["Android"], "x-ver-os":["14"], "x-device-model":["SM-S918B"]}},
  clash: {label:"Clash Meta", h:{"User-Agent":["clash.meta"]}},
  none:  {label:"без заголовков", h:null},
};
const ST_NAME = /^[A-Za-z0-9_-]{1,32}$/, ST_URL = /^https?:\/\/[^\s"'\\]+$/;

function stLoadYaml(){
  if(window.jsyaml) return Promise.resolve();
  return new Promise((ok, fail) => { const s = document.createElement("script"); s.src = "js-yaml.min.js"; s.onload = ok; s.onerror = () => fail(new Error("не удалось загрузить js-yaml")); document.head.append(s); });
}
const stUUID = () => crypto.randomUUID ? crypto.randomUUID() : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, c => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16));

// Build the profile: the template is written for one subscription (__NAME__);
// more subscriptions get their own provider and -Best/-Manual groups.
function stBuild(tpl, subs, headers, hwid){
  const first = subs[0];
  const text = tpl.split("__NAME__").join(first.name).split("__URL__").join(first.url).split("__HWID__").join(hwid);
  const head = text.match(/^(#[^\n]*\n)+\n?/)?.[0] || "";
  const doc = jsyaml.load(text);
  const pp = doc["proxy-providers"] || {}, base = pp[first.name];
  const setHeaders = p => { if(headers.h) p.header = {...headers.h, "x-hwid":[hwid]}; else delete p.header; };
  setHeaders(base);
  for(const s of subs.slice(1)){
    const p = JSON.parse(JSON.stringify(base)); p.url = s.url; p.path = `./providers/${s.name}.yaml`; setHeaders(p);
    pp[s.name] = p;
  }
  const groups = doc["proxy-groups"] || [];
  const best = groups.find(g => g.name === `${first.name}-Best`), manual = groups.find(g => g.name === `${first.name}-Manual`);
  const extra = [];
  for(const s of subs.slice(1)){
    if(best) extra.push({...JSON.parse(JSON.stringify(best)), name:`${s.name}-Best`, use:[s.name]});
    if(manual) extra.push({...JSON.parse(JSON.stringify(manual)), name:`${s.name}-Manual`, use:[s.name]});
  }
  groups.push(...extra);
  const main = groups.find(g => g.name === "Proxy");
  if(main) main.proxies = [...subs.map(s => `${s.name}-Manual`), ...subs.map(s => `${s.name}-Best`), "DIRECT"];
  return head.replace(/^# Placeholders[\s\S]*?them in\.\n/m, "") + jsyaml.dump(doc, {lineWidth:-1, noRefs:true, flowLevel:-1});
}

async function starterDialog(r, opts){
  let tpl;
  try{
    await stLoadYaml();
    const res = await fetch("starter.yaml", {cache:"no-store"}); if(!res.ok) throw new Error("HTTP " + res.status);
    tpl = await res.text();
  }catch(e){ return flash("Шаблон недоступен: " + e.message, true); }
  const hwid = stUUID();
  openDialog(`<h2>Быстрая настройка Nikki</h2>
    <div class="small muted">Готовый профиль: Telegram, YouTube, соцсети, OpenAI/Gemini/Claude, CDN и заблокированные сайты — через подписку; российские сайты и остальное — напрямую. Нужны только название и ссылка подписки.</div>
    <div id="stSubs" class="stsubs"></div>
    <div class="row"><button type="button" id="stAdd" class="ghost">+ ещё подписка</button></div>
    <div class="cols2">
      <label class="f"><span>Заголовки устройства</span><select id="stHdr">${Object.entries(ST_HEADERS).map(([k,v]) => `<option value="${k}">${esc(v.label)}</option>`).join("")}</select></label>
      <label class="f"><span>Имя профиля</span><input id="stProf" value="nikki-fleet.yaml" spellcheck="false"></label>
    </div>
    <label class="row small"><input type="checkbox" id="stAct" checked style="width:auto"> сделать активным и включить Nikki${opts?.hasProfile ? " (текущий активный профиль останется в списке)" : ""}</label>
    <details><summary class="small">Посмотреть YAML</summary><pre class="code" id="stYaml" style="margin-top:8px;max-height:40vh"></pre></details>
    <div class="err small" id="stErr"></div>
    <div class="row end"><button data-close>Отмена</button><button class="primary" id="stGo">Создать профиль</button></div>`, body => {
    const subs = [{name:"", url:""}];
    const drawSubs = () => {
      $("#stSubs").innerHTML = subs.map((s, i) => `<div class="stsub">
        <label class="f"><span>Название${subs.length > 1 ? " " + (i+1) : ""}</span><input data-st="name" data-i="${i}" value="${esc(s.name)}" placeholder="myvpn" spellcheck="false" autocomplete="off"></label>
        <label class="f grow"><span>Ссылка подписки</span><input data-st="url" data-i="${i}" value="${esc(s.url)}" placeholder="https://…" spellcheck="false" autocomplete="off" inputmode="url"></label>
        ${subs.length > 1 ? `<button type="button" class="ghost danger" data-strm="${i}" aria-label="Убрать подписку">✕</button>` : ""}</div>`).join("");
    };
    const check = () => {
      const errs = [], names = new Set();
      subs.forEach((s, i) => {
        if(!ST_NAME.test(s.name)) errs.push(`Название ${i+1}: латиница, цифры, «_» или «-», до 32 символов`);
        else if(names.has(s.name)) errs.push(`Название «${s.name}» повторяется`);
        names.add(s.name);
        if(!ST_URL.test(s.url)) errs.push(`Ссылка ${i+1}: нужен адрес вида https://…`);
      });
      const prof = $("#stProf").value.trim();
      if(!/^[A-Za-z0-9_.@-]+\.ya?ml$/.test(prof)) errs.push("Имя профиля: латиница, цифры, точка, «_», «-» и расширение .yaml");
      return errs;
    };
    const preview = () => {
      const errs = check();
      $("#stErr").textContent = "";
      try{ $("#stYaml").textContent = errs.length ? "Заполните название и ссылку подписки" : stBuild(tpl, subs, ST_HEADERS[$("#stHdr").value], hwid); }
      catch(e){ $("#stYaml").textContent = e.message; }
    };
    drawSubs(); preview();
    body.addEventListener("input", e => { const t = e.target; if(t.dataset.st){ subs[+t.dataset.i][t.dataset.st] = t.value.trim(); } preview(); });
    body.addEventListener("change", preview);
    body.addEventListener("click", e => {
      const rm = e.target.closest("[data-strm]"); if(rm){ subs.splice(+rm.dataset.strm, 1); drawSubs(); preview(); }
    });
    $("#stAdd").onclick = () => { subs.push({name:"", url:""}); drawSubs(); preview(); body.querySelectorAll('[data-st="name"]')[subs.length-1]?.focus(); };
    body.querySelector('[data-st="name"]')?.focus();
    $("#stGo").onclick = async e => {
      const errs = check(); if(errs.length){ $("#stErr").textContent = errs.join(". "); return; }
      const b = e.currentTarget, act = $("#stAct").checked; b.disabled = true; b.textContent = act ? "Проверяю и запускаю…" : "Сохраняю…";
      try{
        const content = stBuild(tpl, subs, ST_HEADERS[$("#stHdr").value], hwid);
        const d = await cmd(r.id, "profile.write", {kind:"file", name:$("#stProf").value.trim(), content, activate:act, reload:act});
        if(d.ok){
          dlg.close();
          flash(act ? (d.enabled ? "Профиль создан, Nikki включён" : "Профиль создан и применён") : "Профиль сохранён");
          const st2 = await cmd(r.id, "status", {full:true}).catch(() => null);
          if(st2 && S.router?.id === r.id){ S.router.status = st2; drawOverview(); }
        }else{
          $("#stErr").textContent = (d.stage === "test" ? "mihomo не принял конфиг: " : "") + (d.error || "ошибка") + (d.output ? " — " + String(d.output).slice(-400) : "");
          b.disabled = false; b.textContent = "Создать профиль";
        }
      }catch(err){ $("#stErr").textContent = err.message; b.disabled = false; b.textContent = "Создать профиль"; }
    };
  });
}
