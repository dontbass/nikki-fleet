// SPDX-License-Identifier: GPL-3.0-or-later
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Login page background: Bing "image of the day" (like the Argon LuCI theme).
// The panel downloads the picture itself and serves it from a disk cache, so
// browsers never contact Bing and the image still shows if Bing is unreachable.
//
//	GET /api/wallpaper   {"enabled":true,"url":"/wallpaper.jpg?d=…","title":"…","copyright":"…"}
//	GET /wallpaper.jpg   the cached picture

// bingBase is a variable so tests can point it at a fake server.
var bingBase = "https://www.bing.com"

type wallpaper struct {
	dir    string
	client *http.Client
	mu     sync.Mutex
	meta   wallpaperMeta
}

type wallpaperMeta struct {
	Date      string    `json:"date"`
	Title     string    `json:"title"`
	Copyright string    `json:"copyright"`
	Link      string    `json:"link"`
	Checked   time.Time `json:"checked"`
}

func newWallpaper(dataDir string) *wallpaper {
	w := &wallpaper{dir: filepath.Join(dataDir, "wallpaper"), client: &http.Client{Timeout: 30 * time.Second}}
	if b, err := os.ReadFile(filepath.Join(w.dir, "meta.json")); err == nil {
		json.Unmarshal(b, &w.meta)
	}
	return w
}

func (w *wallpaper) file() string { return filepath.Join(w.dir, "bing.jpg") }

// refresh checks Bing at most every 3 hours and downloads a new picture when the day changes.
func (w *wallpaper) refresh(ctx context.Context) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if time.Since(w.meta.Checked) < 3*time.Hour {
		if _, err := os.Stat(w.file()); err == nil {
			return
		}
	}
	w.meta.Checked = time.Now()
	req, _ := http.NewRequestWithContext(ctx, "GET", bingBase+"/HPImageArchive.aspx?format=js&idx=0&n=1&mkt=ru-RU", nil)
	resp, err := w.client.Do(req)
	if err != nil {
		return
	}
	var d struct {
		Images []struct {
			URL       string `json:"url"`
			URLBase   string `json:"urlbase"`
			StartDate string `json:"startdate"`
			Title     string `json:"title"`
			Copyright string `json:"copyright"`
			Link      string `json:"copyrightlink"`
		} `json:"images"`
	}
	err = json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&d)
	resp.Body.Close()
	if err != nil || len(d.Images) == 0 {
		return
	}
	img := d.Images[0]
	if _, err := os.Stat(w.file()); err == nil && img.StartDate == w.meta.Date {
		w.save()
		return
	}
	u := img.URL
	if img.URLBase != "" {
		u = img.URLBase + "_1920x1080.jpg"
	}
	if !strings.HasPrefix(u, "/") {
		return
	}
	if err := w.download(ctx, bingBase+u); err != nil {
		return
	}
	w.meta.Date, w.meta.Title, w.meta.Copyright = img.StartDate, img.Title, img.Copyright
	if strings.HasPrefix(img.Link, "https://") {
		w.meta.Link = img.Link
	} else {
		w.meta.Link = ""
	}
	w.save()
}

func (w *wallpaper) download(ctx context.Context, url string) error {
	req, _ := http.NewRequestWithContext(ctx, "GET", url, nil)
	resp, err := w.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 || !strings.HasPrefix(resp.Header.Get("Content-Type"), "image/") {
		return fmt.Errorf("bing: HTTP %d %s", resp.StatusCode, resp.Header.Get("Content-Type"))
	}
	if err := os.MkdirAll(w.dir, 0o755); err != nil {
		return err
	}
	tmp := w.file() + ".part"
	f, err := os.Create(tmp)
	if err != nil {
		return err
	}
	_, err = io.Copy(f, io.LimitReader(resp.Body, 10<<20))
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, w.file())
}

func (w *wallpaper) save() {
	os.MkdirAll(w.dir, 0o755)
	b, _ := json.Marshal(w.meta)
	os.WriteFile(filepath.Join(w.dir, "meta.json"), b, 0o644)
}

func (a *App) wallpaperEnabled() bool {
	var v string
	a.store.View(func(s *state) { v = s.Settings.Wallpaper })
	return v != "off"
}

func (a *App) wallpaperInfo(rw http.ResponseWriter, r *http.Request) {
	if !a.wallpaperEnabled() {
		writeJSON(rw, http.StatusOK, map[string]any{"enabled": false})
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()
	a.wall.refresh(ctx)
	if _, err := os.Stat(a.wall.file()); err != nil {
		writeJSON(rw, http.StatusOK, map[string]any{"enabled": true, "available": false})
		return
	}
	a.wall.mu.Lock()
	m := a.wall.meta
	a.wall.mu.Unlock()
	writeJSON(rw, http.StatusOK, map[string]any{"enabled": true, "available": true, "url": "/wallpaper.jpg?d=" + m.Date,
		"title": m.Title, "copyright": m.Copyright, "link": m.Link})
}

func (a *App) wallpaperImage(rw http.ResponseWriter, r *http.Request) {
	if !a.wallpaperEnabled() {
		http.NotFound(rw, r)
		return
	}
	rw.Header().Set("Cache-Control", "public, max-age=86400")
	http.ServeFile(rw, r, a.wall.file())
}
