// SPDX-License-Identifier: GPL-3.0-or-later
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/crypto/ssh"
)

// SSH terminal to the owner's servers (VPS), right in the panel.
//
// Security model:
//   - only panel administrators (the panel owner) can use it; every server entry
//     is private to the user who added it;
//   - no password or private key is stored anywhere: they are typed for each
//     session, sent over the (TLS) WebSocket once, used for the SSH handshake and
//     dropped; they never reach logs or the audit;
//   - the server's host key is pinned on first connect after the user compares
//     the fingerprint; a changed key refuses the connection;
//   - the WebSocket only accepts pages of the panel itself (Origin check);
//   - limits: 4 sessions per user, 30 min without input, 12 h per session,
//     10 failed logins per 10 min; every connect/disconnect is audited.
//
//	GET    /api/hosts               list
//	POST   /api/hosts               {name, addr, port, user}
//	PATCH  /api/hosts/{id}          same fields
//	DELETE /api/hosts/{id}
//	POST   /api/hosts/{id}/forget-key
//	GET    /api/hosts/audit         recent sessions
//	GET    /api/hosts/{id}/term     WebSocket terminal (see sshTerm)

const (
	sshMaxSessions = 4
	sshIdle        = 30 * time.Minute
	sshMaxLife     = 12 * time.Hour
	sshDialTimeout = 15 * time.Second
)

var (
	reHostName = regexp.MustCompile(`^[\p{L}\p{N} ._()\-]{1,64}$`)
	reHostAddr = regexp.MustCompile(`^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$|^[0-9.]+$|^\[?[0-9A-Fa-f:]+\]?$`)
	reSSHUser  = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_.-]{0,31}$`)
	sshActive  sync.Map // user ID -> *int32
)

func requireAdmin(w http.ResponseWriter, u *User) bool {
	if !u.IsAdmin {
		writeErr(w, http.StatusForbidden, "SSH-терминал доступен только администратору панели")
		return false
	}
	return true
}

type hostView struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Addr        string    `json:"addr"`
	Port        int       `json:"port"`
	User        string    `json:"user"`
	Fingerprint string    `json:"fingerprint,omitempty"`
	KeyType     string    `json:"key_type,omitempty"`
	Created     time.Time `json:"created"`
	LastUsed    time.Time `json:"last_used,omitempty"`
}

func viewHost(h *Host) hostView {
	v := hostView{ID: h.ID, Name: h.Name, Addr: h.Addr, Port: h.Port, User: h.User, Created: h.Created, LastUsed: h.LastUsed}
	if k, _, _, _, err := ssh.ParseAuthorizedKey([]byte(h.HostKey)); err == nil {
		v.Fingerprint, v.KeyType = ssh.FingerprintSHA256(k), k.Type()
	}
	return v
}

func (s *state) host(owner, id string) *Host {
	for _, h := range s.Hosts {
		if h.ID == id && h.OwnerID == owner {
			return h
		}
	}
	return nil
}

type hostReq struct {
	Name *string `json:"name"`
	Addr *string `json:"addr"`
	Port *int    `json:"port"`
	User *string `json:"user"`
}

// apply validates and copies the request onto h; addr/port/user changes drop the pinned key.
func (q hostReq) apply(h *Host) error {
	if q.Name != nil {
		n := strings.TrimSpace(*q.Name)
		if !reHostName.MatchString(n) {
			return errors.New("имя: 1–64 символа, буквы, цифры, пробел, . _ - ( )")
		}
		h.Name = n
	}
	moved := false
	if q.Addr != nil {
		a := strings.Trim(strings.TrimSpace(*q.Addr), "[]")
		if a == "" || len(a) > 253 || !reHostAddr.MatchString(a) {
			return errors.New("адрес: доменное имя или IP")
		}
		moved = moved || a != h.Addr
		h.Addr = a
	}
	if q.Port != nil {
		if *q.Port < 1 || *q.Port > 65535 {
			return errors.New("порт: 1–65535")
		}
		moved = moved || *q.Port != h.Port
		h.Port = *q.Port
	}
	if q.User != nil {
		u := strings.TrimSpace(*q.User)
		if !reSSHUser.MatchString(u) {
			return errors.New("пользователь: латиница, цифры, _ . -")
		}
		h.User = u
	}
	if moved {
		h.HostKey = ""
	}
	return nil
}

func (a *App) listHosts(w http.ResponseWriter, r *http.Request, u *User) {
	if !requireAdmin(w, u) {
		return
	}
	out := []hostView{}
	a.store.View(func(s *state) {
		for _, h := range s.Hosts {
			if h.OwnerID == u.ID {
				out = append(out, viewHost(h))
			}
		}
	})
	writeJSON(w, http.StatusOK, out)
}

func (a *App) createHost(w http.ResponseWriter, r *http.Request, u *User) {
	if !requireAdmin(w, u) {
		return
	}
	var q hostReq
	if err := readJSON(r, &q, 4096); err != nil || q.Name == nil || q.Addr == nil || q.User == nil {
		writeErr(w, http.StatusBadRequest, "нужны имя, адрес и пользователь")
		return
	}
	h := &Host{ID: newID(), OwnerID: u.ID, Port: 22, Created: time.Now()}
	if err := q.apply(h); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	err := a.store.UpdateNow(func(s *state) error {
		n := 0
		for _, x := range s.Hosts {
			if x.OwnerID == u.ID {
				n++
			}
		}
		if n >= 100 {
			return errors.New("не больше 100 серверов")
		}
		s.Hosts = append(s.Hosts, h)
		s.audit(u.ID, "", "ssh.host_added", fmt.Sprintf("%s (%s@%s:%d)", h.Name, h.User, h.Addr, h.Port))
		return nil
	})
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, viewHost(h))
}

func (a *App) patchHost(w http.ResponseWriter, r *http.Request, u *User) {
	if !requireAdmin(w, u) {
		return
	}
	var q hostReq
	if err := readJSON(r, &q, 4096); err != nil {
		writeErr(w, http.StatusBadRequest, "bad request")
		return
	}
	var out hostView
	err := a.store.UpdateNow(func(s *state) error {
		h := s.host(u.ID, r.PathValue("id"))
		if h == nil {
			return errNotFound
		}
		c := *h
		if err := q.apply(&c); err != nil {
			return err
		}
		*h = c
		out = viewHost(h)
		return nil
	})
	if err != nil {
		code := http.StatusBadRequest
		if errors.Is(err, errNotFound) {
			code = http.StatusNotFound
		}
		writeErr(w, code, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (a *App) deleteHost(w http.ResponseWriter, r *http.Request, u *User) {
	if !requireAdmin(w, u) {
		return
	}
	id := r.PathValue("id")
	found := false
	a.store.UpdateNow(func(s *state) error {
		keep := s.Hosts[:0]
		for _, h := range s.Hosts {
			if h.ID == id && h.OwnerID == u.ID {
				found = true
				s.audit(u.ID, "", "ssh.host_deleted", h.Name)
				continue
			}
			keep = append(keep, h)
		}
		s.Hosts = keep
		return nil
	})
	if !found {
		writeErr(w, http.StatusNotFound, "not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (a *App) forgetHostKey(w http.ResponseWriter, r *http.Request, u *User) {
	if !requireAdmin(w, u) {
		return
	}
	err := a.store.UpdateNow(func(s *state) error {
		h := s.host(u.ID, r.PathValue("id"))
		if h == nil {
			return errNotFound
		}
		h.HostKey = ""
		s.audit(u.ID, "", "ssh.hostkey_forgotten", h.Name)
		return nil
	})
	if err != nil {
		writeErr(w, http.StatusNotFound, "not found")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (a *App) hostAudit(w http.ResponseWriter, r *http.Request, u *User) {
	if !requireAdmin(w, u) {
		return
	}
	out := []*AuditEntry{}
	a.store.View(func(s *state) {
		for i := len(s.Audit) - 1; i >= 0 && len(out) < 100; i-- {
			e := s.Audit[i]
			if e.UserID == u.ID && strings.HasPrefix(e.Action, "ssh.") {
				out = append(out, e)
			}
		}
	})
	writeJSON(w, http.StatusOK, out)
}

var errNotFound = errors.New("not found")

/* ---------- the terminal ---------- */

// Protocol (WebSocket):
//
//	client → {"type":"auth","password":"…"} or {"type":"auth","key":"-----BEGIN…","passphrase":"…"}, plus "cols","rows"
//	server → {"type":"hostkey","fingerprint":"SHA256:…","key_type":"ssh-ed25519","changed":false}   first connect only
//	client → {"type":"trust"}                    (or closes the socket)
//	server → {"type":"connected"}                then terminal output as binary frames
//	client → binary frames = keyboard input; {"type":"resize","cols":…,"rows":…}
//	server → {"type":"error","message":"…"} / {"type":"exit","code":0}
type termMsg struct {
	Type       string `json:"type"`
	Password   string `json:"password,omitempty"`
	Key        string `json:"key,omitempty"`
	Passphrase string `json:"passphrase,omitempty"`
	Cols       int    `json:"cols,omitempty"`
	Rows       int    `json:"rows,omitempty"`
}

func (a *App) sshTerm(w http.ResponseWriter, r *http.Request, u *User) {
	if !requireAdmin(w, u) {
		return
	}
	if !a.sameOrigin(r) {
		writeErr(w, http.StatusForbidden, "bad origin")
		return
	}
	var h Host
	a.store.View(func(s *state) {
		if x := s.host(u.ID, r.PathValue("id")); x != nil {
			h = *x
		}
	})
	if h.ID == "" {
		writeErr(w, http.StatusNotFound, "not found")
		return
	}
	cnt, _ := sshActive.LoadOrStore(u.ID, new(int32))
	if atomic.AddInt32(cnt.(*int32), 1) > sshMaxSessions {
		atomic.AddInt32(cnt.(*int32), -1)
		writeErr(w, http.StatusTooManyRequests, fmt.Sprintf("открыто уже %d сессий — закройте лишние", sshMaxSessions))
		return
	}
	defer atomic.AddInt32(cnt.(*int32), -1)

	ws, err := wsUpgrade(w, r)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	defer ws.Close()
	ip := clientIP(r, a.cfg.TrustProxy)
	send := func(v any) { b, _ := json.Marshal(v); ws.Text(b) }
	fail := func(msg string) { send(map[string]string{"type": "error", "message": msg}) }

	// reader: control messages to ctl, keyboard input to in
	ctl := make(chan termMsg, 4)
	in := make(chan []byte, 64)
	done := make(chan struct{})
	var lastInput atomic.Int64
	lastInput.Store(time.Now().UnixNano())
	go func() {
		defer close(done)
		for {
			op, p, err := ws.Read()
			if err != nil {
				return
			}
			if op == wsBinary {
				lastInput.Store(time.Now().UnixNano())
				select {
				case in <- p:
				case <-time.After(2 * time.Minute): // ssh side stuck: drop the session
					return
				}
				continue
			}
			var m termMsg
			if json.Unmarshal(p, &m) == nil {
				select {
				case ctl <- m:
				default:
				}
			}
		}
	}()

	// 1) credentials
	var auth termMsg
	authWait := time.After(2 * time.Minute)
	for auth.Type != "auth" {
		select {
		case auth = <-ctl:
		case <-done:
			return
		case <-authWait:
			fail("не дождались данных для входа")
			return
		}
	}
	if auth.Type != "auth" || (auth.Password == "" && auth.Key == "") {
		fail("нужен пароль или ключ")
		return
	}
	limKey := "ssh:" + u.ID
	if !a.lim.allow(limKey, 10, 10*time.Minute) {
		fail("слишком много неудачных входов — подождите 10 минут")
		return
	}
	var methods []ssh.AuthMethod
	if auth.Key != "" {
		var signer ssh.Signer
		if auth.Passphrase != "" {
			signer, err = ssh.ParsePrivateKeyWithPassphrase([]byte(auth.Key), []byte(auth.Passphrase))
		} else {
			signer, err = ssh.ParsePrivateKey([]byte(auth.Key))
		}
		if err != nil {
			var pm *ssh.PassphraseMissingError
			if errors.As(err, &pm) {
				fail("ключ защищён паролем — введите его")
			} else {
				fail("не удалось прочитать ключ: " + err.Error())
			}
			return
		}
		methods = append(methods, ssh.PublicKeys(signer))
	}
	if auth.Password != "" {
		pw := auth.Password
		methods = append(methods, ssh.Password(pw), ssh.KeyboardInteractive(func(_, _ string, qs []string, _ []bool) ([]string, error) {
			ans := make([]string, len(qs))
			for i := range qs {
				ans[i] = pw
			}
			return ans, nil
		}))
	}
	auth.Password, auth.Key, auth.Passphrase = "", "", ""

	// 2) host key: pinned → must match; not pinned → the user compares and trusts it
	var newKey string
	hostKeyCB := func(_ string, _ net.Addr, key ssh.PublicKey) error {
		got := strings.TrimSpace(string(ssh.MarshalAuthorizedKey(key)))
		if h.HostKey != "" {
			pk, _, _, _, err := ssh.ParseAuthorizedKey([]byte(h.HostKey))
			if err == nil && bytes.Equal(pk.Marshal(), key.Marshal()) {
				return nil
			}
			old := ""
			if err == nil {
				old = ssh.FingerprintSHA256(pk)
			}
			a.store.Update(func(s *state) error {
				s.audit(u.ID, "", "ssh.hostkey_mismatch", fmt.Sprintf("%s: %s → %s, %s", h.Name, old, ssh.FingerprintSHA256(key), ip))
				return nil
			})
			send(map[string]any{"type": "hostkey", "fingerprint": ssh.FingerprintSHA256(key), "key_type": key.Type(), "changed": true, "old": old})
			return errors.New("ключ сервера изменился — подключение отменено")
		}
		send(map[string]any{"type": "hostkey", "fingerprint": ssh.FingerprintSHA256(key), "key_type": key.Type()})
		deadline := time.After(3 * time.Minute)
		for {
			select {
			case m := <-ctl:
				switch m.Type {
				case "trust":
					newKey = got
					return nil
				case "distrust":
					return errors.New("ключ сервера не подтверждён")
				}
				// resize etc. while the dialog is open: ignore
			case <-done:
				return errors.New("ключ сервера не подтверждён")
			case <-deadline:
				return errors.New("ключ сервера не подтверждён")
			}
		}
	}

	addr := net.JoinHostPort(h.Addr, strconv.Itoa(h.Port))
	ctx, cancel := context.WithTimeout(r.Context(), sshDialTimeout)
	conn, err := (&net.Dialer{}).DialContext(ctx, "tcp", addr)
	cancel()
	if err != nil {
		fail("не удалось подключиться к " + addr + ": " + shortNetErr(err))
		a.sshAudit(u, "ssh.failed", h, ip, "tcp: "+shortNetErr(err))
		return
	}
	conn.SetDeadline(time.Now().Add(4 * time.Minute)) // handshake incl. the user checking the fingerprint
	cc, chans, reqs, err := ssh.NewClientConn(conn, addr, &ssh.ClientConfig{
		User:            h.User,
		Auth:            methods,
		HostKeyCallback: hostKeyCB,
		Timeout:         sshDialTimeout,
		ClientVersion:   "SSH-2.0-nikki-fleet-panel",
	})
	methods = nil
	if err != nil {
		conn.Close()
		msg := err.Error()
		if strings.Contains(msg, "unable to authenticate") {
			msg = "сервер не принял пароль или ключ"
			a.lim.fail(limKey)
		}
		fail(msg)
		a.sshAudit(u, "ssh.failed", h, ip, msg)
		return
	}
	conn.SetDeadline(time.Time{})
	client := ssh.NewClient(cc, chans, reqs)
	defer client.Close()
	if newKey != "" {
		a.store.UpdateNow(func(s *state) error {
			if x := s.host(u.ID, h.ID); x != nil {
				x.HostKey = newKey
			}
			return nil
		})
		pk, _, _, _, _ := ssh.ParseAuthorizedKey([]byte(newKey))
		a.sshAudit(u, "ssh.hostkey_trusted", h, ip, ssh.FingerprintSHA256(pk))
	}

	// 3) shell with a PTY
	sess, err := client.NewSession()
	if err != nil {
		fail("сервер не открыл сессию: " + err.Error())
		return
	}
	defer sess.Close()
	cols, rows := clamp(auth.Cols, 20, 500, 80), clamp(auth.Rows, 5, 200, 24)
	if err := sess.RequestPty("xterm-256color", rows, cols, ssh.TerminalModes{ssh.ECHO: 1, ssh.TTY_OP_ISPEED: 14400, ssh.TTY_OP_OSPEED: 14400}); err != nil {
		fail("сервер не выдал терминал: " + err.Error())
		return
	}
	stdin, _ := sess.StdinPipe()
	stdout, _ := sess.StdoutPipe()
	stderr, _ := sess.StderrPipe()
	if err := sess.Shell(); err != nil {
		fail("не удалось запустить оболочку: " + err.Error())
		return
	}
	start := time.Now()
	a.store.Update(func(s *state) error {
		if x := s.host(u.ID, h.ID); x != nil {
			x.LastUsed = start
		}
		return nil
	})
	a.sshAudit(u, "ssh.connect", h, ip, "")
	send(map[string]string{"type": "connected"})

	pump := func(rd io.Reader) {
		buf := make([]byte, 32<<10)
		for {
			n, err := rd.Read(buf)
			if n > 0 {
				if ws.Binary(buf[:n]) != nil {
					client.Close()
					return
				}
			}
			if err != nil {
				return
			}
		}
	}
	go pump(stdout)
	go pump(stderr)
	exited := make(chan error, 1)
	go func() { exited <- sess.Wait() }()

	tick := time.NewTicker(25 * time.Second)
	defer tick.Stop()
	life := time.NewTimer(sshMaxLife)
	defer life.Stop()
	reason := ""
loop:
	for {
		select {
		case p := <-in:
			if _, err := stdin.Write(p); err != nil {
				reason = "stdin closed"
				break loop
			}
		case m := <-ctl:
			if m.Type == "resize" {
				sess.WindowChange(clamp(m.Rows, 5, 200, 24), clamp(m.Cols, 20, 500, 80))
			}
		case err := <-exited:
			code := 0
			var ee *ssh.ExitError
			if errors.As(err, &ee) {
				code = ee.ExitStatus()
			}
			time.Sleep(150 * time.Millisecond) // let the last output through
			send(map[string]any{"type": "exit", "code": code})
			reason = "exit " + strconv.Itoa(code)
			break loop
		case <-done:
			reason = "closed by browser"
			break loop
		case <-tick.C:
			if time.Since(time.Unix(0, lastInput.Load())) > sshIdle {
				fail("сессия закрыта: 30 минут без ввода")
				reason = "idle"
				break loop
			}
			ws.Ping()
			if _, _, err := client.SendRequest("keepalive@openssh.com", true, nil); err != nil {
				fail("связь с сервером потеряна")
				reason = "keepalive failed"
				break loop
			}
		case <-life.C:
			fail("сессия закрыта: прошло 12 часов")
			reason = "max lifetime"
			break loop
		}
	}
	a.sshAudit(u, "ssh.disconnect", h, ip, fmt.Sprintf("%s, %s", time.Since(start).Round(time.Second), reason))
}

func (a *App) sshAudit(u *User, action string, h Host, ip, extra string) {
	d := fmt.Sprintf("%s (%s@%s:%d) from %s", h.Name, h.User, h.Addr, h.Port, ip)
	if extra != "" {
		d += ": " + extra
	}
	a.store.Update(func(s *state) error {
		s.audit(u.ID, "", action, d)
		return nil
	})
}

func clamp(v, lo, hi, def int) int {
	if v == 0 {
		return def
	}
	return max(lo, min(hi, v))
}

func shortNetErr(err error) string {
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		return "нет ответа (таймаут)"
	}
	s := err.Error()
	switch {
	case strings.Contains(s, "connection refused"):
		return "порт закрыт (connection refused)"
	case strings.Contains(s, "no such host"):
		return "адрес не найден (DNS)"
	case strings.Contains(s, "network is unreachable"), strings.Contains(s, "no route to host"):
		return "нет маршрута до сервера"
	}
	return s
}
