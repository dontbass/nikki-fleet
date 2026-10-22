// SPDX-License-Identifier: GPL-3.0-or-later
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

// Package mirror for routers that cannot reach GitHub or nikkinikki.pages.dev
// directly (common behind national filtering). The panel usually runs on a VPS
// with an unrestricted uplink, so it downloads the files itself and serves
// them from a disk cache. Only a fixed set of file names is allowed, so this is
// not an open proxy.
//
//	GET /dl/nikki-fleet/assets.json      latest nikki-fleet release: tag + asset names
//	GET /dl/nikki-fleet/<package file>   nikki-fleet .ipk/.apk from the latest release
//	GET /dl/nikki/<tarball>              Nikki release tarball nikki_<arch>-<branch>.tar.gz

var (
	reFleetAsset = regexp.MustCompile(`^[A-Za-z0-9._~+-]+\.(ipk|apk)$`)
	reNikkiTar   = regexp.MustCompile(`^nikki_[a-z0-9_-]+-(openwrt-24\.10|openwrt-25\.12|SNAPSHOT)\.tar\.gz$`)
)

type mirror struct {
	dir      string
	repo     string
	client   *http.Client
	mu       sync.Mutex
	inflight map[string]*sync.Mutex
	rel      struct {
		at     time.Time
		tag    string
		assets []string
	}
}

func newMirror(dataDir, repo string) *mirror {
	return &mirror{
		dir:      filepath.Join(dataDir, "mirror"),
		repo:     repo,
		client:   &http.Client{Timeout: 10 * time.Minute},
		inflight: map[string]*sync.Mutex{},
	}
}

func (m *mirror) lock(key string) func() {
	m.mu.Lock()
	l := m.inflight[key]
	if l == nil {
		l = &sync.Mutex{}
		m.inflight[key] = l
	}
	m.mu.Unlock()
	l.Lock()
	return l.Unlock
}

func (m *mirror) latest(ctx context.Context) (string, []string, error) {
	defer m.lock("release")()
	if time.Since(m.rel.at) < 10*time.Minute && m.rel.tag != "" {
		return m.rel.tag, m.rel.assets, nil
	}
	req, _ := http.NewRequestWithContext(ctx, "GET", "https://api.github.com/repos/"+m.repo+"/releases/latest", nil)
	req.Header.Set("Accept", "application/vnd.github+json")
	resp, err := m.client.Do(req)
	if err != nil {
		return "", nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return "", nil, fmt.Errorf("github: HTTP %d", resp.StatusCode)
	}
	var rel struct {
		TagName string `json:"tag_name"`
		Assets  []struct {
			Name string `json:"name"`
		} `json:"assets"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&rel); err != nil {
		return "", nil, err
	}
	var names []string
	for _, a := range rel.Assets {
		if reFleetAsset.MatchString(a.Name) {
			names = append(names, a.Name)
		}
	}
	m.rel.at, m.rel.tag, m.rel.assets = time.Now(), rel.TagName, names
	return rel.TagName, names, nil
}

// fetch downloads url into the cache file path (atomically) unless a fresh copy exists.
func (m *mirror) fetch(ctx context.Context, url, path string, ttl time.Duration) error {
	defer m.lock(path)()
	if st, err := os.Stat(path); err == nil && (ttl == 0 || time.Since(st.ModTime()) < ttl) {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	req, _ := http.NewRequestWithContext(ctx, "GET", url, nil)
	resp, err := m.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("upstream HTTP %d", resp.StatusCode)
	}
	tmp := path + ".part"
	f, err := os.Create(tmp)
	if err != nil {
		return err
	}
	_, err = io.Copy(f, io.LimitReader(resp.Body, 200<<20))
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, path)
}

func (a *App) mirrorHandler(w http.ResponseWriter, r *http.Request) {
	src, file := r.PathValue("src"), r.PathValue("file")
	if !a.dlAllowed(w, r) {
		return
	}
	if a.componentMirror(w, r, src, file) {
		return
	}
	// downloads may take a while on first request; detach from the client's
	// context so a dropped connection does not leave a half-filled cache
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	m := a.mirror

	switch {
	case src == "nikki-fleet" && file == "assets.json":
		tag, names, err := m.latest(ctx)
		if err != nil {
			writeErr(w, http.StatusBadGateway, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"tag": tag, "assets": names})
		return

	case src == "nikki-fleet" && reFleetAsset.MatchString(file):
		tag, names, err := m.latest(ctx)
		if err != nil {
			writeErr(w, http.StatusBadGateway, err.Error())
			return
		}
		found := false
		for _, n := range names {
			found = found || n == file
		}
		if !found {
			writeErr(w, http.StatusNotFound, "no such file in the latest release")
			return
		}
		path := filepath.Join(m.dir, "nikki-fleet", tag, file)
		url := "https://github.com/" + m.repo + "/releases/download/" + tag + "/" + file
		if err := m.fetch(ctx, url, path, 0); err != nil {
			writeErr(w, http.StatusBadGateway, err.Error())
			return
		}
		http.ServeFile(w, r, path)
		return

	case src == "nikki" && reNikkiTar.MatchString(file):
		path := filepath.Join(m.dir, "nikki", file)
		url := "https://github.com/nikkinikki-org/OpenWrt-nikki/releases/latest/download/" + file
		if err := m.fetch(ctx, url, path, 6*time.Hour); err != nil {
			// serve a stale copy rather than nothing
			if _, serr := os.Stat(path); errors.Is(serr, os.ErrNotExist) {
				writeErr(w, http.StatusBadGateway, err.Error())
				return
			}
		}
		http.ServeFile(w, r, path)
		return
	}
	writeErr(w, http.StatusNotFound, "not found")
}

// fleetLatest tells the UI which nikki-fleet version routers can upgrade to.
func (a *App) fleetLatest(w http.ResponseWriter, r *http.Request, u *User) {
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	tag, names, err := a.mirror.latest(ctx)
	if err != nil {
		writeErr(w, http.StatusBadGateway, "не удалось узнать последнюю версию: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"tag": tag, "version": strings.TrimPrefix(tag, "v"), "assets": len(names)})
}

// dlAllowed limits mirror downloads per client IP.
func (a *App) dlAllowed(w http.ResponseWriter, r *http.Request) bool {
	ip := clientIP(r, a.cfg.TrustProxy)
	if !a.lim.allow("dl:"+ip, 60, 10*time.Minute) {
		writeErr(w, http.StatusTooManyRequests, "too many downloads, try later")
		return false
	}
	a.lim.fail("dl:" + ip)
	return true
}
