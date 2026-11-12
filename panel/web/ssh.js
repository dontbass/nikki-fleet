// nikki-fleet panel: SSH terminal to your servers (VPS), right in the browser.
// Passwords and keys are typed for each session and never stored by the panel.
// SPDX-License-Identifier: GPL-3.0-or-later
"use strict";

IC.key = '<circle cx="8" cy="15" r="4"/><path d="M10.8 12.2L20 3M16 7l3 3M14 9l2 2"/>';

let xtermP = null;
function sshLoadXterm(){
  if(window.Terminal && window.FitAddon) return Promise.resolve();
  if(xtermP) return xtermP;
  const css = document.createElement("link"); css.rel = "stylesheet"; css.href = "vendor/xterm.css"; document.head.append(css);
  const js = src => new Promise((ok, bad) => { const s = document.createElement("script"); s.src = src; s.onload = ok; s.onerror = () => bad(new Error("не загрузился " + src)); document.head.append(s); });
  xtermP = js("vendor/xterm.js").then(() => Promise.all([js("vendor/addon-fit.js"), js("vendor/addon-web-links.js")])).catch(e => { xtermP = null; throw e; });
  return xtermP;
}
const sshPref = (k, v) => { try{ if(v === undefined) return localStorage.getItem("nf.ssh." + k); localStorage.setItem("nf.ssh." + k, v); }catch(e){ return null; } };
const sshTarget = h => `${h.user}@${h.addr}${h.port !== 22 ? ":" + h.port : ""}`;

/* ---------- servers list ---------- */
async function renderHosts(){
  if(!S.me.is_admin){ app.innerHTML = `<div class="panel"><h2>Серверы</h2><div class="note">SSH-терминал доступен только администратору панели.</div></div>`; return; }
  app.innerHTML = `<div class="muted pad">Загрузка…</div>`;
  let hosts = [], log = [];
  try{ [hosts, log] = await Promise.all([get("/api/hosts"), get("/api/hosts/audit").catch(() => [])]); }catch(e){ return handleErr(e); }
  const ACT = {"ssh.connect":"подключение", "ssh.disconnect":"отключение", "ssh.failed":"ошибка входа", "ssh.hostkey_trusted":"ключ сервера закреплён",
    "ssh.hostkey_mismatch":"ключ сервера НЕ совпал", "ssh.hostkey_forgotten":"ключ сервера сброшен", "ssh.host_added":"сервер добавлен", "ssh.host_deleted":"сервер удалён"};
  app.innerHTML = `
    <div class="fleethero"><div><h1>Серверы</h1><div class="small">SSH-терминал к вашим VPS прямо из панели. Пароль или ключ вводится при каждом подключении и нигде не сохраняется.</div></div>
      <button class="primary" id="hAdd">+ Добавить сервер</button></div>
    ${hosts.length ? `<div class="hosts">${hosts.map(h => `
      <div class="hostcard">
        <span class="ic g-blue">${icon("term")}</span>
        <div class="hc-main"><b>${esc(h.name)}</b><span class="mono small">${esc(sshTarget(h))}</span>
          <span class="small muted">${h.fingerprint ? `${icon("key","ti")} ${esc(h.key_type)} ${esc(h.fingerprint.slice(0, 22))}…` : "ключ сервера ещё не закреплён"} · ${h.last_used ? "был " + ago(h.last_used) : "не подключались"}</span></div>
        <div class="row">
          <a class="btn primary" href="#/hosts/${esc(h.id)}">Подключить</a>
          <button data-hedit="${esc(h.id)}">Изменить</button>
          <button class="danger" data-hdel="${esc(h.id)}">Удалить</button>
        </div>
      </div>`).join("")}</div>`
    : `<div class="panel"><div class="note">Серверов пока нет. Добавьте VPS: имя, адрес, порт SSH и пользователя.</div></div>`}
    <div class="panel"><h3>Журнал SSH</h3>
      ${log.length ? `<div class="tbl"><table><thead><tr><th>Когда</th><th>Событие</th><th>Подробности</th></tr></thead><tbody>
        ${log.slice(0, 40).map(e => `<tr><td class="muted">${fmtDate(e.time)}</td><td${/mismatch|failed/.test(e.action) ? ' class="err"' : ""}>${esc(ACT[e.action] || e.action)}</td><td class="small">${esc(e.detail || "")}</td></tr>`).join("")}
      </tbody></table></div>` : `<div class="small muted">Подключений ещё не было.</div>`}
    </div>`;
  $("#hAdd").onclick = () => hostDialog();
  app.onclick = async e => {
    const ed = e.target.closest("[data-hedit]"); if(ed) return hostDialog(hosts.find(h => h.id === ed.dataset.hedit));
    const d = e.target.closest("[data-hdel]");
    if(d){
      if(!d.dataset.armed){ d.dataset.armed = "1"; d.textContent = "Точно удалить?"; setTimeout(() => { if(d.isConnected){ delete d.dataset.armed; d.textContent = "Удалить"; } }, 4000); return; }
      try{ await del("/api/hosts/" + d.dataset.hdel); flash("Сервер удалён"); renderHosts(); }catch(err){ flash(err.message, true); }
    }
  };
}

function hostDialog(h){
  openDialog(`<h2>${h ? "Сервер «" + esc(h.name) + "»" : "Новый сервер"}</h2>
    <form id="hForm">
      <label class="f"><span>Название</span><input id="hName" required maxlength="64" value="${esc(h?.name || "")}" placeholder="Финляндия VPS"></label>
      <div class="row" style="align-items:flex-end">
        <label class="f" style="flex:3 1 200px"><span>Адрес (домен или IP)</span><input id="hAddr" required value="${esc(h?.addr || "")}" placeholder="203.0.113.10" autocapitalize="off" spellcheck="false"></label>
        <label class="f" style="flex:1 1 80px"><span>Порт</span><input id="hPort" type="number" min="1" max="65535" value="${h?.port || 22}"></label>
      </div>
      <label class="f"><span>Пользователь</span><input id="hUser" required value="${esc(h?.user || "root")}" autocapitalize="off" spellcheck="false"></label>
      ${h?.fingerprint ? `<div class="note small">Закреплённый ключ сервера: <span class="mono">${esc(h.key_type)} ${esc(h.fingerprint)}</span>. Смена адреса или порта сбросит его.
        <button type="button" class="small" id="hForget">Сбросить ключ</button> — только если вы сами переустановили сервер или сменили его SSH-ключ.</div>` : ""}
      <div class="err small" id="hErr"></div>
      <div class="row end"><button type="button" data-close>Отмена</button><button class="primary">${h ? "Сохранить" : "Добавить"}</button></div>
    </form>`, body => {
    body.querySelector("#hForm").onsubmit = async e => {
      e.preventDefault();
      const b = {name: $("#hName").value.trim(), addr: $("#hAddr").value.trim(), port: +$("#hPort").value || 22, user: $("#hUser").value.trim()};
      try{ h ? await patch("/api/hosts/" + h.id, b) : await post("/api/hosts", b); dlg.close(); flash(h ? "Сохранено" : "Сервер добавлен"); renderHosts(); }
      catch(err){ $("#hErr").textContent = err.message; }
    };
    const f = body.querySelector("#hForget");
    if(f) f.onclick = async () => {
      if(!f.dataset.armed){ f.dataset.armed = "1"; f.textContent = "Точно сбросить?"; return; }
      try{ await post(`/api/hosts/${h.id}/forget-key`); dlg.close(); flash("Ключ сброшен — при подключении его нужно будет сверить заново"); renderHosts(); }catch(err){ flash(err.message, true); }
    };
  });
}

/* ---------- terminal ---------- */
let sshSess = null; // {ws, term, ...} of the open terminal
function sshClose(){ if(sshSess){ try{ sshSess.ws?.close(); }catch(e){} try{ sshSess.term?.dispose(); }catch(e){} window.removeEventListener("resize", sshSess.onResize); sshSess = null; } }
window.addEventListener("beforeunload", e => { if(sshSess?.connected){ e.preventDefault(); e.returnValue = ""; } });

async function renderTerm(id){
  if(!S.me.is_admin) return renderHosts();
  let h;
  try{ h = (await get("/api/hosts")).find(x => x.id === id); }catch(e){ return handleErr(e); }
  if(!h){ app.innerHTML = `<div class="panel"><h2>Сервер не найден</h2><a class="btn" href="#/hosts">К списку серверов</a></div>`; return; }
  const mode = sshPref("mode:" + id) || "password";
  app.innerHTML = `
    <div class="termhead">
      <a class="btn ghost" href="#/hosts" title="К серверам">←</a>
      <div class="th-title"><b>${esc(h.name)}</b><span class="mono small">${esc(sshTarget(h))}</span></div>
      <span class="pill" id="tState">не подключено</span>
      <div class="row th-tools" id="tTools" hidden>
        <button class="small" id="tPaste" title="Вставить из буфера (Ctrl+Shift+V)">Вставить</button>
        <button class="small" id="tFontM" title="Мельче">A−</button><button class="small" id="tFontP" title="Крупнее">A+</button>
        <button class="small" id="tFull" title="Во весь экран">⛶</button>
        <button class="small danger" id="tStop">Отключить</button>
      </div>
    </div>
    <form class="panel termlogin" id="tLogin" autocomplete="on">
      <h3>Вход на ${esc(h.name)}</h3>
      <input type="text" name="username" autocomplete="username" value="${esc(sshTarget(h))}" hidden readonly>
      <div class="seg" role="tablist">
        <button type="button" data-mode="password" aria-selected="${mode === "password"}">Пароль</button>
        <button type="button" data-mode="key" aria-selected="${mode === "key"}">Ключ</button>
      </div>
      <div data-pane="password"${mode === "password" ? "" : " hidden"}>
        <label class="f"><span>Пароль пользователя ${esc(h.user)}</span><input id="tPw" type="password" autocomplete="current-password"></label>
      </div>
      <div data-pane="key"${mode === "key" ? "" : " hidden"}>
        <label class="f"><span>Приватный ключ (OpenSSH / PEM)</span><textarea id="tKey" rows="5" spellcheck="false" autocomplete="off" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"></textarea></label>
        <div class="row"><label class="btn small">Выбрать файл ключа<input type="file" id="tKeyFile" hidden></label><span class="small muted">файл читается в браузере и уходит только на сервер панели для этого входа</span></div>
        <label class="f"><span>Пароль ключа (если есть)</span><input id="tPass" type="password" autocomplete="off"></label>
      </div>
      <div class="small muted">Пароль и ключ используются один раз для входа и нигде не сохраняются: ни в панели, ни в журнале.</div>
      <div class="err small" id="tErr"></div>
      <div class="row end"><button class="primary" id="tGo">Подключиться</button></div>
    </form>
    <div class="termwrap" id="tWrap" hidden><div id="tBox"></div>
      <div class="xkeys" id="xKeys">${["Esc","Tab","Ctrl","Alt","↑","↓","←","→","|","~","/","-"].map(k => `<button type="button" data-k="${k}">${k}</button>`).join("")}</div>
    </div>`;

  const form = $("#tLogin");
  let curMode = mode;
  form.querySelectorAll("[data-mode]").forEach(b => b.onclick = () => {
    curMode = b.dataset.mode; sshPref("mode:" + id, curMode);
    form.querySelectorAll("[data-mode]").forEach(x => x.setAttribute("aria-selected", x === b));
    form.querySelectorAll("[data-pane]").forEach(p => p.hidden = p.dataset.pane !== curMode);
    (curMode === "password" ? $("#tPw") : $("#tKey")).focus();
  });
  $("#tKeyFile").onchange = async e => { const f = e.target.files[0]; if(f){ if(f.size > 64*1024) return flash("Файл слишком большой для ключа", true); $("#tKey").value = await f.text(); } };
  (curMode === "password" ? $("#tPw") : $("#tKey")).focus();

  form.onsubmit = async e => {
    e.preventDefault();
    $("#tErr").textContent = "";
    const cred = curMode === "password" ? {password: $("#tPw").value} : {key: $("#tKey").value.trim(), passphrase: $("#tPass").value};
    if(curMode === "password" ? !cred.password : !cred.key){ $("#tErr").textContent = curMode === "password" ? "Введите пароль" : "Вставьте ключ или выберите файл"; return; }
    $("#tGo").disabled = true;
    try{ await sshLoadXterm(); }catch(err){ $("#tErr").textContent = err.message; $("#tGo").disabled = false; return; }
    sshConnect(h, cred, () => {
      // wipe what was typed as soon as it is sent
      $("#tPw") && ($("#tPw").value = ""); $("#tKey") && ($("#tKey").value = ""); $("#tPass") && ($("#tPass").value = "");
    });
  };
}

function sshConnect(h, cred, sent){
  sshClose();
  const state = (t, cls) => { const s = $("#tState"); if(s){ s.textContent = t; s.className = "pill " + (cls || ""); } };
  const fontSize = +sshPref("font") || (matchMedia("(max-width: 640px)").matches ? 12 : 14);
  const term = new Terminal({
    cursorBlink: true, fontSize, scrollback: 5000, allowProposedApi: false, macOptionIsMeta: true,
    fontFamily: '"JetBrains Mono","Cascadia Mono",Menlo,Consolas,"DejaVu Sans Mono",monospace',
    theme: {background:"#0b1426", foreground:"#dbe4f3", cursor:"#5ab0ff", selectionBackground:"#2b4f86",
      black:"#1b2333", red:"#f26d6d", green:"#49d17d", yellow:"#f5c451", blue:"#5a9cff", magenta:"#c58cff", cyan:"#3fd0d6", white:"#dbe4f3",
      brightBlack:"#5c6b85", brightRed:"#ff8a8a", brightGreen:"#6ee79a", brightYellow:"#ffd978", brightBlue:"#86b8ff", brightMagenta:"#d9adff", brightCyan:"#74e6ea", brightWhite:"#ffffff"},
  });
  const fit = new FitAddon.FitAddon(); term.loadAddon(fit);
  try{ term.loadAddon(new WebLinksAddon.WebLinksAddon()); }catch(e){}
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/api/hosts/${encodeURIComponent(h.id)}/term`);
  ws.binaryType = "arraybuffer";
  const sess = sshSess = {ws, term, fit, connected:false, ctrl:false, alt:false, onResize:null};
  const enc = new TextEncoder();
  const sendKeys = s => { if(sess.connected && ws.readyState === 1) ws.send(enc.encode(s)); };
  const sendCtl = o => { if(ws.readyState === 1) ws.send(JSON.stringify(o)); };

  ws.onopen = () => {
    state("вход…");
    $("#tWrap").hidden = false;
    term.open($("#tBox")); fit.fit();
    sendCtl({type:"auth", ...cred, cols: term.cols, rows: term.rows});
    cred.password = cred.key = cred.passphrase = "";
    sent && sent();
  };
  ws.onmessage = ev => {
    if(typeof ev.data !== "string"){ term.write(new Uint8Array(ev.data)); return; }
    let m; try{ m = JSON.parse(ev.data); }catch(e){ return; }
    if(m.type === "connected"){
      sess.connected = true; state("подключено", "on");
      $("#tLogin").hidden = true; $("#tTools").hidden = false;
      fit.fit(); sendCtl({type:"resize", cols: term.cols, rows: term.rows}); term.focus();
    } else if(m.type === "hostkey"){
      sshHostKeyDialog(h, m, ok => { if(ok) sendCtl({type:"trust"}); else if(!m.changed) sendCtl({type:"distrust"}); });
    } else if(m.type === "error"){
      if(!sess.connected){ $("#tErr").textContent = m.message; $("#tWrap").hidden = true; }
      else term.write(`\r\n\x1b[31m${m.message}\x1b[0m\r\n`);
      state("ошибка", "bad");
    } else if(m.type === "exit"){
      term.write(`\r\n\x1b[90m[сессия завершена${m.code ? ", код " + m.code : ""}]\x1b[0m\r\n`);
    }
  };
  ws.onclose = () => {
    const was = sess.connected; sess.connected = false;
    if(sshSess !== sess) return;
    state(was ? "отключено" : "не подключено", was ? "" : "bad");
    $("#tGo") && ($("#tGo").disabled = false);
    if(!was){ $("#tWrap").hidden = true; try{ term.dispose(); }catch(e){} if(!$("#tErr").textContent) $("#tErr").textContent = "Соединение закрыто"; }
    else { $("#tTools").hidden = true; $("#tLogin").hidden = false; $("#tGo").textContent = "Подключиться снова"; }
  };

  // keyboard → server (with the on-screen Ctrl/Alt modifiers)
  term.onData(d => {
    if(sess.ctrl && d.length === 1){ const c = d.toUpperCase().charCodeAt(0); if(c >= 64 && c <= 95) d = String.fromCharCode(c - 64); sess.ctrl = false; markMods(); }
    if(sess.alt){ d = "\x1b" + d; sess.alt = false; markMods(); }
    sendKeys(d);
  });
  term.onBinary(d => { if(sess.connected) ws.send(Uint8Array.from(d, c => c.charCodeAt(0) & 255)); });
  // Ctrl+Shift+C / Ctrl+Shift+V: copy / paste like in desktop terminals
  term.attachCustomKeyEventHandler(ev => {
    if(ev.type === "keydown" && ev.ctrlKey && ev.shiftKey && ev.code === "KeyC"){ const s = term.getSelection(); if(s) navigator.clipboard?.writeText(s); return false; }
    if(ev.type === "keydown" && ev.ctrlKey && ev.shiftKey && ev.code === "KeyV"){ navigator.clipboard?.readText().then(t => t && term.paste(t)).catch(() => {}); return false; }
    return true;
  });
  term.onSelectionChange(() => { const s = term.getSelection(); if(s && s.length > 1) navigator.clipboard?.writeText(s).catch(() => {}); });

  let rt;
  sess.onResize = () => { clearTimeout(rt); rt = setTimeout(() => { try{ fit.fit(); if(sess.connected) sendCtl({type:"resize", cols: term.cols, rows: term.rows}); }catch(e){} }, 120); };
  window.addEventListener("resize", sess.onResize);
  new ResizeObserver(sess.onResize).observe($("#tBox"));

  const markMods = () => document.querySelectorAll("#xKeys [data-k]").forEach(b => b.classList.toggle("on", (b.dataset.k === "Ctrl" && sess.ctrl) || (b.dataset.k === "Alt" && sess.alt)));
  const KEYS = {"Esc":"\x1b", "Tab":"\t", "↑":"\x1b[A", "↓":"\x1b[B", "→":"\x1b[C", "←":"\x1b[D"};
  $("#xKeys").onclick = e => {
    const b = e.target.closest("[data-k]"); if(!b) return;
    const k = b.dataset.k;
    if(k === "Ctrl"){ sess.ctrl = !sess.ctrl; markMods(); }
    else if(k === "Alt"){ sess.alt = !sess.alt; markMods(); }
    else sendKeys(KEYS[k] || k);
    term.focus();
  };
  $("#tStop").onclick = () => { ws.close(); };
  $("#tPaste").onclick = async () => { try{ const t = await navigator.clipboard.readText(); if(t) term.paste(t); term.focus(); }catch(e){ flash("Браузер не дал доступ к буферу — используйте Ctrl+Shift+V", true); } };
  const setFont = d => { term.options.fontSize = Math.max(9, Math.min(24, term.options.fontSize + d)); sshPref("font", term.options.fontSize); sess.onResize(); };
  $("#tFontM").onclick = () => setFont(-1); $("#tFontP").onclick = () => setFont(1);
  $("#tFull").onclick = () => { const w = $("#tWrap"); (document.fullscreenElement ? document.exitFullscreen() : w.requestFullscreen?.())?.catch?.(() => {}); setTimeout(sess.onResize, 200); };
}

function sshHostKeyDialog(h, m, cb){
  let answered = false;
  const done = ok => { if(answered) return; answered = true; dlg.close(); cb(ok); };
  if(m.changed){
    openDialog(`<h2 class="err">Ключ сервера изменился</h2>
      <p>Сервер <b>${esc(h.name)}</b> (${esc(h.addr)}) представился другим ключом, чем при прошлых подключениях. Подключение отменено.</p>
      <div class="note small">Было: <span class="mono">${esc(m.old || "—")}</span><br>Сейчас: <span class="mono">${esc(m.key_type)} ${esc(m.fingerprint)}</span></div>
      <p class="small">Так бывает, если сервер переустановили или пересоздали его SSH-ключи. Если вы этого не делали — кто-то может перехватывать соединение: не вводите пароль. Если делали — откройте «Изменить» у сервера и нажмите «Сбросить ключ».</p>
      <div class="row end"><button class="primary" data-close>Понятно</button></div>`);
    dlg.addEventListener("close", () => done(false), {once:true});
    return;
  }
  openDialog(`<h2>Первое подключение к ${esc(h.name)}</h2>
    <p>Сервер представился ключом:</p>
    <div class="note"><span class="mono">${esc(m.key_type)}</span><br><b class="mono" style="word-break:break-all">${esc(m.fingerprint)}</b></div>
    <p class="small">Сверьте отпечаток с самим сервером, например в консоли хостера:<br><span class="mono">ssh-keygen -lf /etc/ssh/ssh_host_${esc(String(m.key_type).replace(/^ssh-|^ecdsa-sha2-nistp\d+$/, x => x.startsWith("ecdsa") ? "ecdsa" : ""))}_key.pub</span></p>
    <p class="small muted">После подтверждения ключ закрепится: если он когда-нибудь изменится, панель откажется подключаться.</p>
    <div class="row end"><button id="hkNo">Отмена</button><button class="primary" id="hkYes">Ключ верный — подключиться</button></div>`, body => {
    body.querySelector("#hkYes").onclick = () => done(true);
    body.querySelector("#hkNo").onclick = () => done(false);
  });
  dlg.addEventListener("close", () => done(false), {once:true});
}
