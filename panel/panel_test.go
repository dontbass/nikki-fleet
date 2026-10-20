// SPDX-License-Identifier: GPL-3.0-or-later
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"testing"
	"time"
)

type client struct {
	t   *testing.T
	srv *httptest.Server
	c   *http.Client
}

func newClient(t *testing.T, srv *httptest.Server) *client {
	jar, _ := cookiejar.New(nil)
	return &client{t: t, srv: srv, c: &http.Client{Jar: jar, Timeout: 30 * time.Second}}
}

func (c *client) do(method, path string, body any, out any) int {
	var rd *bytes.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	} else {
		rd = bytes.NewReader(nil)
	}
	req, _ := http.NewRequest(method, c.srv.URL+path, rd)
	req.Header.Set("X-NF", "1")
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.c.Do(req)
	if err != nil {
		c.t.Fatalf("%s %s: %v", method, path, err)
	}
	defer resp.Body.Close()
	if out != nil {
		json.NewDecoder(resp.Body).Decode(out)
	}
	return resp.StatusCode
}

func testApp(t *testing.T) (*App, *httptest.Server) {
	st, err := OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	app := &App{cfg: Config{Repo: "x/y"}, store: st, hub: NewHub(), lim: newLimiter(), mirror: newMirror(t.TempDir(), "x/y")}
	srv := httptest.NewServer(app.routes())
	t.Cleanup(srv.Close)
	return app, srv
}

// fakeAgent long-polls the panel and answers commands like the real agent.
func fakeAgent(ctx context.Context, url, token string) {
	results := []Result{}
	for ctx.Err() == nil {
		b, _ := json.Marshal(map[string]any{"agent_version": "test", "results": results,
			"status": map[string]any{"hostname": "test-router"}})
		req, _ := http.NewRequestWithContext(ctx, "POST", url+"/api/agent/v1/poll", bytes.NewReader(b))
		req.Header.Set("Authorization", "Bearer "+token)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return
		}
		var pr struct{ Commands []Command }
		json.NewDecoder(resp.Body).Decode(&pr)
		resp.Body.Close()
		results = results[:0]
		for _, c := range pr.Commands {
			var args map[string]any
			json.Unmarshal(c.Args, &args)
			data, _ := json.Marshal(map[string]any{"ok": true, "echo": c.Type, "args": args})
			results = append(results, Result{ID: c.ID, OK: true, Data: data})
		}
	}
}

func TestFullFlow(t *testing.T) {
	_, srv := testApp(t)
	owner := newClient(t, srv)

	var info map[string]any
	owner.do("GET", "/api/info", nil, &info)
	if info["first_user"] != true {
		t.Fatal("expected first user registration")
	}
	if code := owner.do("POST", "/api/auth/register", credentials{"alice", "password123"}, nil); code != 200 {
		t.Fatalf("register: %d", code)
	}
	// second registration is closed by default
	other := newClient(t, srv)
	if code := other.do("POST", "/api/auth/register", credentials{"bob", "password123"}, nil); code != 400 {
		t.Fatalf("registration should be closed, got %d", code)
	}
	// admin creates bob
	if code := owner.do("POST", "/api/admin/users", credentials{"bob", "password123"}, nil); code != 200 {
		t.Fatalf("admin create: %d", code)
	}
	if code := other.do("POST", "/api/auth/login", credentials{"bob", "password123"}, nil); code != 200 {
		t.Fatalf("bob login: %d", code)
	}

	// enrollment
	var ec struct{ Code, Command string }
	owner.do("POST", "/api/routers/enroll", map[string]string{"name": "Дача"}, &ec)
	if ec.Code == "" {
		t.Fatal("no enroll code")
	}
	var en struct {
		RouterID string `json:"router_id"`
		Token    string `json:"token"`
	}
	if code := newClient(t, srv).do("POST", "/api/agent/v1/enroll", map[string]any{"code": ec.Code, "info": map[string]string{"hostname": "OpenWrt"}}, &en); code != 200 {
		t.Fatalf("enroll: %d", code)
	}
	// code is single use
	if code := newClient(t, srv).do("POST", "/api/agent/v1/enroll", map[string]any{"code": ec.Code}, nil); code != 403 {
		t.Fatalf("code reuse should fail, got %d", code)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go fakeAgent(ctx, srv.URL, en.Token)
	time.Sleep(200 * time.Millisecond)

	var list []routerView
	owner.do("GET", "/api/routers", nil, &list)
	if len(list) != 1 || list[0].Name != "Дача" || !list[0].Online || list[0].Role != "owner" {
		t.Fatalf("router list: %+v", list)
	}

	// bob cannot see it yet
	var blist []routerView
	other.do("GET", "/api/routers", nil, &blist)
	if len(blist) != 0 {
		t.Fatal("bob must not see alice's router")
	}
	if code := other.do("POST", "/api/routers/"+en.RouterID+"/cmd", map[string]any{"type": "status"}, nil); code != 404 {
		t.Fatalf("bob cmd should be 404, got %d", code)
	}

	// owner runs a command through the agent
	var res Result
	start := time.Now()
	if code := owner.do("POST", "/api/routers/"+en.RouterID+"/cmd", map[string]any{"type": "profile.write",
		"args": map[string]any{"name": "main.yaml", "content": "mode: rule\n"}}, &res); code != 200 || !res.OK {
		t.Fatalf("cmd: %d %+v", code, res)
	}
	if time.Since(start) > 3*time.Second {
		t.Fatal("command delivery is too slow (long-poll wake failed)")
	}
	var versions []map[string]any
	owner.do("GET", "/api/routers/"+en.RouterID+"/versions", nil, &versions)
	if len(versions) != 1 {
		t.Fatalf("expected 1 config version, got %d", len(versions))
	}

	// share as viewer: GET api allowed, write denied
	if code := owner.do("POST", "/api/routers/"+en.RouterID+"/shares", map[string]string{"username": "bob", "role": "viewer"}, nil); code != 200 {
		t.Fatalf("share: %d", code)
	}
	if code := other.do("POST", "/api/routers/"+en.RouterID+"/cmd", map[string]any{"type": "mihomo.api", "args": map[string]any{"method": "GET", "path": "/version"}}, &res); code != 200 {
		t.Fatalf("viewer GET api: %d", code)
	}
	if code := other.do("POST", "/api/routers/"+en.RouterID+"/cmd", map[string]any{"type": "mihomo.api", "args": map[string]any{"method": "PUT", "path": "/proxies/x"}}, nil); code != 403 {
		t.Fatalf("viewer PUT api should be 403, got %d", code)
	}
	if code := other.do("POST", "/api/routers/"+en.RouterID+"/cmd", map[string]any{"type": "profile.write"}, nil); code != 403 {
		t.Fatalf("viewer write should be 403, got %d", code)
	}
	if code := other.do("POST", "/api/routers/"+en.RouterID+"/cmd", map[string]any{"type": "rm -rf"}, nil); code != 400 {
		t.Fatalf("unknown cmd should be 400, got %d", code)
	}

	// CSRF header required
	req, _ := http.NewRequest("POST", srv.URL+"/api/routers/enroll", nil)
	resp, _ := owner.c.Do(req)
	if resp.StatusCode != 403 {
		t.Fatalf("missing X-NF must be rejected, got %d", resp.StatusCode)
	}

	// deleting the router revokes the agent token
	if code := owner.do("DELETE", "/api/routers/"+en.RouterID, nil, nil); code != 200 {
		t.Fatalf("delete: %d", code)
	}
	b, _ := json.Marshal(map[string]any{})
	preq, _ := http.NewRequest("POST", srv.URL+"/api/agent/v1/poll", bytes.NewReader(b))
	preq.Header.Set("Authorization", "Bearer "+en.Token)
	presp, _ := http.DefaultClient.Do(preq)
	if presp.StatusCode != 401 {
		t.Fatalf("revoked token must get 401, got %d", presp.StatusCode)
	}
}

func TestOfflineRouter(t *testing.T) {
	app, srv := testApp(t)
	c := newClient(t, srv)
	c.do("POST", "/api/auth/register", credentials{"alice", "password123"}, nil)
	var ec struct{ Code string }
	c.do("POST", "/api/routers/enroll", nil, &ec)
	var en struct {
		RouterID string `json:"router_id"`
	}
	newClient(t, srv).do("POST", "/api/agent/v1/enroll", map[string]any{"code": ec.Code}, &en)
	app.store.Update(func(s *state) error { s.router(en.RouterID).LastSeen = time.Now().Add(-time.Hour); return nil })
	if code := c.do("POST", "/api/routers/"+en.RouterID+"/cmd", map[string]any{"type": "status"}, nil); code != 503 {
		t.Fatalf("offline router should return 503, got %d", code)
	}
}

func TestMirrorNames(t *testing.T) {
	ok := []string{"nikki_aarch64_cortex-a53-openwrt-24.10.tar.gz", "nikki_x86_64-openwrt-25.12.tar.gz", "nikki_mipsel_24kc-SNAPSHOT.tar.gz"}
	bad := []string{"../state.json", "nikki_x/../../etc-openwrt-24.10.tar.gz", "evil.tar.gz", "nikki_x86_64-openwrt-23.05.tar.gz"}
	for _, n := range ok {
		if !reNikkiTar.MatchString(n) {
			t.Errorf("should allow %s", n)
		}
	}
	for _, n := range bad {
		if reNikkiTar.MatchString(n) {
			t.Errorf("should reject %s", n)
		}
	}
	for _, n := range []string{"nikki-fleet_0.1.4-r1_all.ipk", "luci-i18n-nikki-fleet-ru-26.293.55828.c176122.apk"} {
		if !reFleetAsset.MatchString(n) {
			t.Errorf("should allow %s", n)
		}
	}
	for _, n := range []string{"../x.ipk", "a/b.apk", "x.sh"} {
		if reFleetAsset.MatchString(n) {
			t.Errorf("should reject %s", n)
		}
	}
}
