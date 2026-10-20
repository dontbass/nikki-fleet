// SPDX-License-Identifier: GPL-3.0-or-later
package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"
)

/* ---------- auth ---------- */

var reUsername = regexp.MustCompile(`^[A-Za-z0-9_.@-]{3,64}$`)

type credentials struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

func (a *App) info(w http.ResponseWriter, r *http.Request) {
	var users int
	var reg string
	a.store.View(func(s *state) { users = len(s.Users); reg = s.Settings.Registration })
	writeJSON(w, http.StatusOK, map[string]any{
		"version":      version,
		"registration": users == 0 || reg == "open",
		"first_user":   users == 0,
	})
}

func (a *App) register(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("X-NF") != "1" {
		writeErr(w, http.StatusForbidden, "missing X-NF header")
		return
	}
	var c credentials
	if err := readJSON(r, &c, 4096); err != nil {
		writeErr(w, http.StatusBadRequest, "bad request")
		return
	}
	c.Username = strings.TrimSpace(c.Username)
	if !reUsername.MatchString(c.Username) {
		writeErr(w, http.StatusBadRequest, "имя: 3–64 символа, латиница, цифры, _ . @ -")
		return
	}
	if len(c.Password) < 8 {
		writeErr(w, http.StatusBadRequest, "пароль должен быть не короче 8 символов")
		return
	}
	ip := clientIP(r, a.cfg.TrustProxy)
	if !a.lim.allow("reg:"+ip, 5, time.Hour) {
		writeErr(w, http.StatusTooManyRequests, "слишком много регистраций, попробуйте позже")
		return
	}
	salt := randomHex(16)
	u := &User{ID: newID(), Username: c.Username, Salt: salt, PassHash: hashPassword(c.Password, salt), Created: time.Now()}
	err := a.store.UpdateNow(func(s *state) error {
		if len(s.Users) > 0 && s.Settings.Registration != "open" {
			return errors.New("регистрация закрыта, попросите администратора создать учётную запись")
		}
		if s.userByName(u.Username) != nil {
			return errors.New("такое имя уже занято")
		}
		u.IsAdmin = len(s.Users) == 0
		s.Users = append(s.Users, u)
		s.audit(u.ID, "", "user.registered", ip)
		return nil
	})
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	a.lim.fail("reg:" + ip)
	a.createSession(w, r, u)
	writeJSON(w, http.StatusOK, userView(u))
}

func (a *App) login(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("X-NF") != "1" {
		writeErr(w, http.StatusForbidden, "missing X-NF header")
		return
	}
	var c credentials
	if err := readJSON(r, &c, 4096); err != nil {
		writeErr(w, http.StatusBadRequest, "bad request")
		return
	}
	key := "login:" + clientIP(r, a.cfg.TrustProxy) + ":" + strings.ToLower(c.Username)
	if !a.lim.allow(key, 8, 15*time.Minute) {
		writeErr(w, http.StatusTooManyRequests, "слишком много попыток, подождите 15 минут")
		return
	}
	var u *User
	a.store.View(func(s *state) {
		if x := s.userByName(strings.TrimSpace(c.Username)); x != nil {
			cp := *x
			u = &cp
		}
	})
	if u == nil || !checkPassword(u, c.Password) {
		a.lim.fail(key)
		writeErr(w, http.StatusUnauthorized, "неверное имя или пароль")
		return
	}
	a.createSession(w, r, u)
	writeJSON(w, http.StatusOK, userView(u))
}

func (a *App) logout(w http.ResponseWriter, r *http.Request) {
	a.destroySession(w, r)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func userView(u *User) map[string]any {
	return map[string]any{"id": u.ID, "username": u.Username, "is_admin": u.IsAdmin}
}

func (a *App) me(w http.ResponseWriter, r *http.Request, u *User) {
	writeJSON(w, http.StatusOK, userView(u))
}

func (a *App) changePassword(w http.ResponseWriter, r *http.Request, u *User) {
	var req struct {
		Old string `json:"old"`
		New string `json:"new"`
	}
	if err := readJSON(r, &req, 4096); err != nil || len(req.New) < 8 {
		writeErr(w, http.StatusBadRequest, "новый пароль должен быть не короче 8 символов")
		return
	}
	if !checkPassword(u, req.Old) {
		writeErr(w, http.StatusForbidden, "текущий пароль неверен")
		return
	}
	a.store.UpdateNow(func(s *state) error {
		x := s.userByID(u.ID)
		x.Salt = randomHex(16)
		x.PassHash = hashPassword(req.New, x.Salt)
		// log out other sessions
		keep := s.Sessions[:0]
		for _, se := range s.Sessions {
			if se.UserID != u.ID {
				keep = append(keep, se)
			}
		}
		s.Sessions = keep
		return nil
	})
	a.createSession(w, r, u)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

/* ---------- routers ---------- */

type routerView struct {
	ID           string          `json:"id"`
	Name         string          `json:"name"`
	Notes        string          `json:"notes"`
	Role         string          `json:"role"`
	Owner        string          `json:"owner"`
	Online       bool            `json:"online"`
	LastSeen     time.Time       `json:"last_seen"`
	Created      time.Time       `json:"created"`
	AgentVersion string          `json:"agent_version"`
	Status       json.RawMessage `json:"status,omitempty"`
	StatusAt     time.Time       `json:"status_at"`
	Info         json.RawMessage `json:"info,omitempty"`
}

func (a *App) view(s *state, rt *Router, role string) routerView {
	owner := ""
	if o := s.userByID(rt.OwnerID); o != nil {
		owner = o.Username
	}
	return routerView{ID: rt.ID, Name: rt.Name, Notes: rt.Notes, Role: role, Owner: owner, Online: a.online(rt),
		LastSeen: rt.LastSeen, Created: rt.Created, AgentVersion: rt.AgentVersion, Status: rt.Status,
		StatusAt: rt.StatusAt, Info: rt.Info}
}

func (a *App) listRouters(w http.ResponseWriter, r *http.Request, u *User) {
	out := []routerView{}
	a.store.View(func(s *state) {
		for _, rt := range s.Routers {
			if role := s.role(u, rt); role != "" {
				out = append(out, a.view(s, rt, role))
			}
		}
	})
	sort.Slice(out, func(i, j int) bool { return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name) })
	writeJSON(w, http.StatusOK, out)
}

// access returns the router and the user's role, or writes an error.
func (a *App) access(w http.ResponseWriter, r *http.Request, u *User, need string) (*Router, string, bool) {
	id := r.PathValue("id")
	var rt *Router
	var role string
	a.store.View(func(s *state) {
		if x := s.router(id); x != nil {
			role = s.role(u, x)
			if role != "" {
				cp := *x
				rt = &cp
			}
		}
	})
	if rt == nil {
		writeErr(w, http.StatusNotFound, "роутер не найден")
		return nil, "", false
	}
	if rank(role) < rank(need) {
		writeErr(w, http.StatusForbidden, "недостаточно прав")
		return nil, "", false
	}
	return rt, role, true
}

func rank(role string) int {
	switch role {
	case "owner":
		return 3
	case "editor":
		return 2
	case "viewer":
		return 1
	}
	return 0
}

func (a *App) getRouter(w http.ResponseWriter, r *http.Request, u *User) {
	rt, role, ok := a.access(w, r, u, "viewer")
	if !ok {
		return
	}
	var v routerView
	a.store.View(func(s *state) { v = a.view(s, rt, role) })
	writeJSON(w, http.StatusOK, v)
}

func (a *App) patchRouter(w http.ResponseWriter, r *http.Request, u *User) {
	rt, _, ok := a.access(w, r, u, "editor")
	if !ok {
		return
	}
	var req struct {
		Name  *string `json:"name"`
		Notes *string `json:"notes"`
	}
	if err := readJSON(r, &req, 16<<10); err != nil {
		writeErr(w, http.StatusBadRequest, "bad request")
		return
	}
	a.store.UpdateNow(func(s *state) error {
		x := s.router(rt.ID)
		if req.Name != nil && strings.TrimSpace(*req.Name) != "" {
			x.Name = strings.TrimSpace(*req.Name)
			if len(x.Name) > 80 {
				x.Name = x.Name[:80]
			}
		}
		if req.Notes != nil {
			x.Notes = *req.Notes
		}
		return nil
	})
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (a *App) deleteRouter(w http.ResponseWriter, r *http.Request, u *User) {
	rt, _, ok := a.access(w, r, u, "owner")
	if !ok {
		return
	}
	a.store.UpdateNow(func(s *state) error {
		s.deleteRouter(rt.ID)
		s.audit(u.ID, rt.ID, "router.deleted", rt.Name)
		return nil
	})
	a.store.DeleteConfigs(rt.ID)
	a.hub.Forget(rt.ID)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (a *App) createEnrollCode(w http.ResponseWriter, r *http.Request, u *User) {
	var req struct {
		Name string `json:"name"`
	}
	readJSON(r, &req, 4096)
	code := newEnrollCode()
	exp := time.Now().Add(30 * time.Minute)
	a.store.UpdateNow(func(s *state) error {
		n := 0
		keep := s.Codes[:0]
		for _, c := range s.Codes {
			if time.Now().Before(c.Expires) {
				keep = append(keep, c)
				if c.OwnerID == u.ID {
					n++
				}
			}
		}
		s.Codes = keep
		if n >= 20 {
			s.Codes = s.Codes[1:]
		}
		s.Codes = append(s.Codes, &EnrollCode{Code: code, OwnerID: u.ID, Name: strings.TrimSpace(req.Name), Expires: exp})
		return nil
	})
	base := a.publicURL(r)
	writeJSON(w, http.StatusOK, map[string]any{
		"code":    code,
		"expires": exp,
		"command": "curl -fsSL " + base + "/install.sh | sh -s -- " + code,
		"manual":  "nikki-fleet enroll " + base + " " + code,
	})
}

/* ---------- commands ---------- */

var cmdNeed = map[string]string{
	"agent.ping":          "viewer",
	"status":              "viewer",
	"profiles.list":       "viewer",
	"profile.read":        "viewer",
	"profile.test":        "viewer",
	"backups.list":        "viewer",
	"logs.tail":           "viewer",
	"mihomo.api":          "viewer", // non-GET requires editor, checked below
	"profile.write":       "editor",
	"backup.restore":      "editor",
	"nikki.reload":        "editor",
	"subscription.update": "editor",
}

var slowCmds = map[string]bool{"profile.write": true, "backup.restore": true, "nikki.reload": true, "subscription.update": true}

func (a *App) routerCmd(w http.ResponseWriter, r *http.Request, u *User) {
	var req struct {
		Type string          `json:"type"`
		Args json.RawMessage `json:"args"`
	}
	if err := readJSON(r, &req, 8<<20); err != nil {
		writeErr(w, http.StatusBadRequest, "bad request")
		return
	}
	need, known := cmdNeed[req.Type]
	if !known {
		writeErr(w, http.StatusBadRequest, "неизвестная команда")
		return
	}
	var args map[string]any
	json.Unmarshal(req.Args, &args)
	if req.Type == "mihomo.api" {
		if m, _ := args["method"].(string); m != "" && strings.ToUpper(m) != "GET" {
			need = "editor"
		}
	}
	rt, _, ok := a.access(w, r, u, need)
	if !ok {
		return
	}
	if !a.online(rt) {
		writeErr(w, http.StatusServiceUnavailable, "роутер не на связи")
		return
	}
	timeout := 45 * time.Second
	if slowCmds[req.Type] {
		timeout = 120 * time.Second
	}
	res, err := a.hub.Call(r.Context(), rt.ID, req.Type, req.Args, timeout)
	if err != nil {
		writeErr(w, http.StatusGatewayTimeout, "роутер не ответил вовремя")
		return
	}
	if need == "editor" {
		a.recordChange(u, rt, req.Type, args, res)
	}
	writeJSON(w, http.StatusOK, res)
}

func (a *App) recordChange(u *User, rt *Router, typ string, args map[string]any, res Result) {
	detail := typ
	if n, _ := args["name"].(string); n != "" {
		detail += " " + n
	}
	if typ == "mihomo.api" {
		m, _ := args["method"].(string)
		p, _ := args["path"].(string)
		detail = "mihomo " + strings.ToUpper(m) + " " + p
	}
	result := "ok"
	if !res.OK {
		result = "error"
		var d struct {
			Error      string `json:"error"`
			RolledBack bool   `json:"rolled_back"`
		}
		json.Unmarshal(res.Data, &d)
		if d.RolledBack {
			result = "rolled_back"
		}
	}
	vid := ""
	if typ == "profile.write" {
		if content, _ := args["content"].(string); content != "" {
			vid = time.Now().UTC().Format("20060102-150405") + "-" + randomHex(3)
			if err := a.store.SaveConfig(rt.ID, vid, []byte(content)); err != nil {
				vid = ""
			}
		}
	}
	a.store.UpdateNow(func(s *state) error {
		if vid != "" {
			kind, _ := args["kind"].(string)
			if kind == "" {
				kind = "file"
			}
			name, _ := args["name"].(string)
			content, _ := args["content"].(string)
			s.Versions = append(s.Versions, &ConfigVersion{ID: vid, RouterID: rt.ID, Kind: kind, Name: name,
				UserID: u.ID, Time: time.Now(), Size: len(content), Result: result})
		}
		s.audit(u.ID, rt.ID, "cmd."+result, detail)
		return nil
	})
	if vid != "" {
		a.store.PruneVersions(rt.ID, 50)
	}
}

func (a *App) listVersions(w http.ResponseWriter, r *http.Request, u *User) {
	rt, _, ok := a.access(w, r, u, "viewer")
	if !ok {
		return
	}
	type vv struct {
		*ConfigVersion
		User string `json:"user"`
	}
	out := []vv{}
	a.store.View(func(s *state) {
		for _, v := range s.Versions {
			if v.RouterID == rt.ID {
				name := ""
				if x := s.userByID(v.UserID); x != nil {
					name = x.Username
				}
				out = append(out, vv{v, name})
			}
		}
	})
	sort.Slice(out, func(i, j int) bool { return out[i].Time.After(out[j].Time) })
	writeJSON(w, http.StatusOK, out)
}

func (a *App) getVersion(w http.ResponseWriter, r *http.Request, u *User) {
	rt, _, ok := a.access(w, r, u, "viewer")
	if !ok {
		return
	}
	b, err := a.store.LoadConfig(rt.ID, r.PathValue("vid"))
	if err != nil {
		writeErr(w, http.StatusNotFound, "версия не найдена")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"content": string(b)})
}

/* ---------- sharing ---------- */

func (a *App) listShares(w http.ResponseWriter, r *http.Request, u *User) {
	rt, _, ok := a.access(w, r, u, "viewer")
	if !ok {
		return
	}
	type sv struct {
		UserID   string `json:"user_id"`
		Username string `json:"username"`
		Role     string `json:"role"`
	}
	out := []sv{}
	a.store.View(func(s *state) {
		if o := s.userByID(rt.OwnerID); o != nil {
			out = append(out, sv{o.ID, o.Username, "owner"})
		}
		for _, sh := range s.Shares {
			if sh.RouterID == rt.ID {
				if x := s.userByID(sh.UserID); x != nil {
					out = append(out, sv{x.ID, x.Username, sh.Role})
				}
			}
		}
	})
	writeJSON(w, http.StatusOK, out)
}

func (a *App) addShare(w http.ResponseWriter, r *http.Request, u *User) {
	rt, _, ok := a.access(w, r, u, "owner")
	if !ok {
		return
	}
	var req struct {
		Username string `json:"username"`
		Role     string `json:"role"`
	}
	if err := readJSON(r, &req, 4096); err != nil || (req.Role != "viewer" && req.Role != "editor") {
		writeErr(w, http.StatusBadRequest, "роль: viewer или editor")
		return
	}
	err := a.store.UpdateNow(func(s *state) error {
		x := s.userByName(strings.TrimSpace(req.Username))
		if x == nil {
			return errors.New("пользователь не найден")
		}
		if x.ID == rt.OwnerID {
			return errors.New("это владелец роутера")
		}
		for _, sh := range s.Shares {
			if sh.RouterID == rt.ID && sh.UserID == x.ID {
				sh.Role = req.Role
				return nil
			}
		}
		s.Shares = append(s.Shares, &Share{RouterID: rt.ID, UserID: x.ID, Role: req.Role})
		s.audit(u.ID, rt.ID, "share.added", x.Username+" "+req.Role)
		return nil
	})
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (a *App) removeShare(w http.ResponseWriter, r *http.Request, u *User) {
	uid := r.PathValue("uid")
	// owners can remove anyone; a user can remove their own access
	need := "owner"
	if uid == u.ID {
		need = "viewer"
	}
	rt, _, ok := a.access(w, r, u, need)
	if !ok {
		return
	}
	a.store.UpdateNow(func(s *state) error {
		keep := s.Shares[:0]
		for _, sh := range s.Shares {
			if !(sh.RouterID == rt.ID && sh.UserID == uid) {
				keep = append(keep, sh)
			}
		}
		s.Shares = keep
		s.audit(u.ID, rt.ID, "share.removed", uid)
		return nil
	})
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (a *App) routerAudit(w http.ResponseWriter, r *http.Request, u *User) {
	rt, _, ok := a.access(w, r, u, "viewer")
	if !ok {
		return
	}
	type av struct {
		Time   time.Time `json:"time"`
		User   string    `json:"user"`
		Action string    `json:"action"`
		Detail string    `json:"detail"`
	}
	out := []av{}
	a.store.View(func(s *state) {
		for i := len(s.Audit) - 1; i >= 0 && len(out) < 200; i-- {
			e := s.Audit[i]
			if e.RouterID != rt.ID {
				continue
			}
			name := ""
			if x := s.userByID(e.UserID); x != nil {
				name = x.Username
			}
			out = append(out, av{e.Time, name, e.Action, e.Detail})
		}
	})
	writeJSON(w, http.StatusOK, out)
}

/* ---------- admin ---------- */

func (a *App) adminUsers(w http.ResponseWriter, r *http.Request, u *User) {
	if !u.IsAdmin {
		writeErr(w, http.StatusForbidden, "только для администратора")
		return
	}
	type uv struct {
		ID       string    `json:"id"`
		Username string    `json:"username"`
		IsAdmin  bool      `json:"is_admin"`
		Created  time.Time `json:"created"`
		Routers  int       `json:"routers"`
	}
	out := []uv{}
	var reg string
	a.store.View(func(s *state) {
		reg = s.Settings.Registration
		for _, x := range s.Users {
			n := 0
			for _, rt := range s.Routers {
				if rt.OwnerID == x.ID {
					n++
				}
			}
			out = append(out, uv{x.ID, x.Username, x.IsAdmin, x.Created, n})
		}
	})
	if reg == "" {
		reg = "closed"
	}
	writeJSON(w, http.StatusOK, map[string]any{"users": out, "registration": reg})
}

func (a *App) adminCreateUser(w http.ResponseWriter, r *http.Request, u *User) {
	if !u.IsAdmin {
		writeErr(w, http.StatusForbidden, "только для администратора")
		return
	}
	var c credentials
	if err := readJSON(r, &c, 4096); err != nil || !reUsername.MatchString(c.Username) || len(c.Password) < 8 {
		writeErr(w, http.StatusBadRequest, "имя 3–64 символа, пароль от 8 символов")
		return
	}
	salt := randomHex(16)
	err := a.store.UpdateNow(func(s *state) error {
		if s.userByName(c.Username) != nil {
			return errors.New("такое имя уже занято")
		}
		s.Users = append(s.Users, &User{ID: newID(), Username: c.Username, Salt: salt, PassHash: hashPassword(c.Password, salt), Created: time.Now()})
		s.audit(u.ID, "", "user.created", c.Username)
		return nil
	})
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (a *App) adminDeleteUser(w http.ResponseWriter, r *http.Request, u *User) {
	if !u.IsAdmin {
		writeErr(w, http.StatusForbidden, "только для администратора")
		return
	}
	id := r.PathValue("id")
	if id == u.ID {
		writeErr(w, http.StatusBadRequest, "нельзя удалить себя")
		return
	}
	var removed []string
	a.store.UpdateNow(func(s *state) error {
		us := s.Users[:0]
		for _, x := range s.Users {
			if x.ID != id {
				us = append(us, x)
			}
		}
		s.Users = us
		for _, rt := range append([]*Router(nil), s.Routers...) {
			if rt.OwnerID == id {
				removed = append(removed, rt.ID)
				s.deleteRouter(rt.ID)
			}
		}
		sh := s.Shares[:0]
		for _, x := range s.Shares {
			if x.UserID != id {
				sh = append(sh, x)
			}
		}
		s.Shares = sh
		ss := s.Sessions[:0]
		for _, x := range s.Sessions {
			if x.UserID != id {
				ss = append(ss, x)
			}
		}
		s.Sessions = ss
		s.audit(u.ID, "", "user.deleted", id)
		return nil
	})
	for _, rid := range removed {
		a.store.DeleteConfigs(rid)
		a.hub.Forget(rid)
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (a *App) adminSettings(w http.ResponseWriter, r *http.Request, u *User) {
	if !u.IsAdmin {
		writeErr(w, http.StatusForbidden, "только для администратора")
		return
	}
	var req struct {
		Registration string `json:"registration"`
	}
	if err := readJSON(r, &req, 4096); err != nil || (req.Registration != "open" && req.Registration != "closed") {
		writeErr(w, http.StatusBadRequest, "registration: open или closed")
		return
	}
	a.store.UpdateNow(func(s *state) error { s.Settings.Registration = req.Registration; return nil })
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
