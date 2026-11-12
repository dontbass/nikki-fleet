// SPDX-License-Identifier: GPL-3.0-or-later
package main

import (
	"bufio"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

// testSSHServer: password "pw" for user "root"; the shell echoes input as "echo:<line>".
func testSSHServer(t *testing.T) (addr string, fp string) {
	_, pk, _ := ed25519.GenerateKey(rand.Reader)
	signer, _ := ssh.NewSignerFromKey(pk)
	cfg := &ssh.ServerConfig{PasswordCallback: func(c ssh.ConnMetadata, pw []byte) (*ssh.Permissions, error) {
		if c.User() == "root" && string(pw) == "pw" {
			return nil, nil
		}
		return nil, fmt.Errorf("denied")
	}}
	cfg.AddHostKey(signer)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				_, chans, reqs, err := ssh.NewServerConn(c, cfg)
				if err != nil {
					return
				}
				go ssh.DiscardRequests(reqs)
				for nc := range chans {
					ch, creqs, _ := nc.Accept()
					go func() {
						for r := range creqs {
							r.Reply(r.Type == "pty-req" || r.Type == "shell" || r.Type == "window-change", nil)
						}
					}()
					go func() {
						sc := bufio.NewScanner(ch)
						for sc.Scan() {
							if sc.Text() == "exit" {
								ch.SendRequest("exit-status", false, ssh.Marshal(struct{ C uint32 }{3}))
								ch.Close()
								return
							}
							fmt.Fprintf(ch, "echo:%s\n", sc.Text())
						}
					}()
				}
			}(c)
		}
	}()
	return ln.Addr().String(), ssh.FingerprintSHA256(signer.PublicKey())
}

// tiny WebSocket client for tests
type wsTestConn struct {
	c  net.Conn
	br *bufio.Reader
}

func wsDial(t *testing.T, base, path, origin, cookie string) (*wsTestConn, int) {
	host := strings.TrimPrefix(base, "http://")
	c, err := net.Dial("tcp", host)
	if err != nil {
		t.Fatal(err)
	}
	fmt.Fprintf(c, "GET %s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nOrigin: %s\r\nCookie: %s\r\n\r\n", path, host, origin, cookie)
	br := bufio.NewReader(c)
	resp, err := http.ReadResponse(br, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != 101 {
		c.Close()
		return nil, resp.StatusCode
	}
	return &wsTestConn{c: c, br: br}, 101
}

func (w *wsTestConn) send(op byte, p []byte) {
	h := []byte{0x80 | op}
	if len(p) < 126 {
		h = append(h, 0x80|byte(len(p)))
	} else {
		h = append(h, 0x80|126, byte(len(p)>>8), byte(len(p)))
	}
	mask := []byte{1, 2, 3, 4}
	h = append(h, mask...)
	m := make([]byte, len(p))
	for i := range p {
		m[i] = p[i] ^ mask[i%4]
	}
	w.c.Write(append(h, m...))
}

func (w *wsTestConn) json(v any) { b, _ := json.Marshal(v); w.send(1, b) }

func (w *wsTestConn) read(t *testing.T) (byte, []byte) {
	w.c.SetReadDeadline(time.Now().Add(10 * time.Second))
	var h [2]byte
	if _, err := io.ReadFull(w.br, h[:]); err != nil {
		t.Fatalf("ws read: %v", err)
	}
	n := int(h[1] & 0x7f)
	if n == 126 {
		var b [2]byte
		io.ReadFull(w.br, b[:])
		n = int(binary.BigEndian.Uint16(b[:]))
	} else if n == 127 {
		var b [8]byte
		io.ReadFull(w.br, b[:])
		n = int(binary.BigEndian.Uint64(b[:]))
	}
	p := make([]byte, n)
	io.ReadFull(w.br, p)
	return h[0] & 0x0f, p
}

// readUntil returns control messages of the given type, collecting terminal output on the way.
func (w *wsTestConn) readUntil(t *testing.T, typ string, out *strings.Builder) map[string]any {
	for {
		op, p := w.read(t)
		if op == 2 {
			out.Write(p)
			continue
		}
		if op != 1 {
			continue
		}
		var m map[string]any
		json.Unmarshal(p, &m)
		if m["type"] == typ {
			return m
		}
		if m["type"] == "error" && typ != "error" {
			t.Fatalf("server error: %v", m["message"])
		}
	}
}

func TestSSHTerminal(t *testing.T) {
	app, srv := testApp(t)
	addr, fp := testSSHServer(t)
	host, port, _ := net.SplitHostPort(addr)
	var p int
	fmt.Sscan(port, &p)

	admin := newClient(t, srv)
	admin.do("POST", "/api/auth/register", credentials{"alice", "password123"}, nil)
	var h hostView
	if code := admin.do("POST", "/api/hosts", map[string]any{"name": "VPS 1", "addr": host, "port": p, "user": "root"}, &h); code != 200 {
		t.Fatalf("create host: %d", code)
	}
	if code := admin.do("POST", "/api/hosts", map[string]any{"name": "bad", "addr": "a b;rm", "user": "root"}, nil); code != 400 {
		t.Fatalf("bad address accepted: %d", code)
	}
	cookie := ""
	for _, c := range admin.c.Jar.Cookies(mustURL(srv.URL)) {
		cookie += c.Name + "=" + c.Value + "; "
	}
	path := "/api/hosts/" + h.ID + "/term"

	// foreign page: refused
	if _, code := wsDial(t, srv.URL, path, "http://evil.example", cookie); code != 403 {
		t.Fatalf("cross-origin websocket: %d", code)
	}
	// non-admin: refused
	admin.do("POST", "/api/admin/users", credentials{"bob", "password123"}, nil)
	bob := newClient(t, srv)
	bob.do("POST", "/api/auth/login", credentials{"bob", "password123"}, nil)
	if code := bob.do("GET", "/api/hosts", nil, nil); code != 403 {
		t.Fatalf("non-admin hosts list: %d", code)
	}

	// first connect: host key shown, trusted, shell works
	ws, code := wsDial(t, srv.URL, path, srv.URL, cookie)
	if code != 101 {
		t.Fatalf("upgrade: %d", code)
	}
	var out strings.Builder
	ws.json(map[string]any{"type": "auth", "password": "pw", "cols": 100, "rows": 30})
	hk := ws.readUntil(t, "hostkey", &out)
	if hk["fingerprint"] != fp {
		t.Fatalf("fingerprint %v, want %s", hk["fingerprint"], fp)
	}
	ws.json(map[string]any{"type": "resize", "cols": 90, "rows": 20}) // must not count as an answer
	ws.json(map[string]any{"type": "trust"})
	ws.readUntil(t, "connected", &out)
	ws.send(2, []byte("hello\n"))
	deadline := time.Now().Add(5 * time.Second)
	for !strings.Contains(out.String(), "echo:hello") && time.Now().Before(deadline) {
		if op, p := ws.read(t); op == 2 {
			out.Write(p)
		}
	}
	if !strings.Contains(out.String(), "echo:hello") {
		t.Fatalf("no echo, got %q", out.String())
	}
	ws.send(2, []byte("exit\n"))
	ex := ws.readUntil(t, "exit", &out)
	if ex["code"] != float64(3) {
		t.Fatalf("exit code %v", ex["code"])
	}
	ws.c.Close()

	// the key is pinned; nothing secret was stored
	var hs []hostView
	admin.do("GET", "/api/hosts", nil, &hs)
	if hs[0].Fingerprint != fp {
		t.Fatalf("host key not pinned: %+v", hs[0])
	}
	app.store.Flush()
	app.store.View(func(s *state) {
		b, _ := json.Marshal(s)
		if strings.Contains(string(b), `"pw"`) {
			t.Fatal("password leaked into the state")
		}
	})

	// wrong password
	ws, _ = wsDial(t, srv.URL, path, srv.URL, cookie)
	ws.json(map[string]any{"type": "auth", "password": "nope"})
	if m := ws.readUntil(t, "error", &out); !strings.Contains(m["message"].(string), "не принял") {
		t.Fatalf("wrong password: %v", m["message"])
	}
	ws.c.Close()

	// a different host key on the same address is refused
	app.store.UpdateNow(func(s *state) error {
		_, pk, _ := ed25519.GenerateKey(rand.Reader)
		sg, _ := ssh.NewSignerFromKey(pk)
		s.Hosts[0].HostKey = strings.TrimSpace(string(ssh.MarshalAuthorizedKey(sg.PublicKey())))
		return nil
	})
	ws, _ = wsDial(t, srv.URL, path, srv.URL, cookie)
	ws.json(map[string]any{"type": "auth", "password": "pw"})
	if m := ws.readUntil(t, "hostkey", &out); m["changed"] != true {
		t.Fatalf("changed key not reported: %v", m)
	}
	if m := ws.readUntil(t, "error", &out); !strings.Contains(m["message"].(string), "изменился") {
		t.Fatalf("changed key: %v", m["message"])
	}
	ws.c.Close()
}

func mustURL(s string) *url.URL { u, _ := url.Parse(s); return u }
