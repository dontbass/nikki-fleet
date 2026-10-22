// SPDX-License-Identifier: GPL-3.0-or-later
package main

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

// Mirrors for components the routers update from the panel (GitHub is often
// blocked on the router side):
//
//	GET /dl/mihomo/latest.json            {"tag":"v1.19.33"}  MetaCubeX/mihomo stable release
//	GET /dl/mihomo/{tag}/{file}           mihomo-linux-<arch>-<tag>.gz from that release (cached)
//	GET /dl/zashboard/latest.json         {"tag":"v3.29.1"}
//	GET /dl/zashboard/dist.tar.gz         latest zashboard (dist-no-fonts.zip) repacked as .tar.gz,
//	                                      because busybox on routers usually has tar but no unzip
//	GET /api/latest                       latest versions of nikki-fleet, mihomo and zashboard (for the UI)

var (
	ghBase       = "https://github.com" // tests point it at a fake server
	reMihomoTag  = regexp.MustCompile(`^v[0-9]+\.[0-9]+\.[0-9]+$`)
	reMihomoFile = regexp.MustCompile(`^mihomo-linux-[a-z0-9-]+-v[0-9]+\.[0-9]+\.[0-9]+\.gz$`)
)

const (
	mihomoRepo    = "MetaCubeX/mihomo"
	zashboardRepo = "Zephyruso/zashboard"
	zashboardZip  = "dist-no-fonts.zip"
)

type tagCache struct {
	mu   sync.Mutex
	tags map[string]struct {
		tag string
		at  time.Time
	}
}

var latestTags = &tagCache{tags: map[string]struct {
	tag string
	at  time.Time
}{}}

// latestTag reads the tag of a repo's latest release from the /releases/latest
// redirect (no API rate limit), cached for 30 minutes.
func (m *mirror) latestTag(ctx context.Context, repo string) (string, error) {
	latestTags.mu.Lock()
	c, ok := latestTags.tags[repo]
	latestTags.mu.Unlock()
	if ok && time.Since(c.at) < 30*time.Minute {
		return c.tag, nil
	}
	defer m.lock("tag:" + repo)()
	cl := &http.Client{Timeout: 20 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	req, _ := http.NewRequestWithContext(ctx, "HEAD", ghBase+"/"+repo+"/releases/latest", nil)
	resp, err := cl.Do(req)
	if err != nil {
		if ok {
			return c.tag, nil // stale is better than nothing
		}
		return "", err
	}
	resp.Body.Close()
	loc := resp.Header.Get("Location")
	i := strings.LastIndex(loc, "/tag/")
	if i < 0 {
		if ok {
			return c.tag, nil
		}
		return "", fmt.Errorf("github: no latest release for %s (HTTP %d)", repo, resp.StatusCode)
	}
	tag := path.Base(loc[i+4:])
	latestTags.mu.Lock()
	latestTags.tags[repo] = struct {
		tag string
		at  time.Time
	}{tag, time.Now()}
	latestTags.mu.Unlock()
	return tag, nil
}

// pruneOld removes cached release directories not used for two weeks.
func pruneOld(dir, keep string) {
	ents, _ := os.ReadDir(dir)
	for _, e := range ents {
		if !e.IsDir() || e.Name() == keep {
			continue
		}
		if fi, err := e.Info(); err == nil && time.Since(fi.ModTime()) > 14*24*time.Hour {
			os.RemoveAll(filepath.Join(dir, e.Name()))
		}
	}
}

func (a *App) mihomoMirror(w http.ResponseWriter, r *http.Request) {
	tag, file := r.PathValue("tag"), r.PathValue("file")
	if !reMihomoTag.MatchString(tag) || !reMihomoFile.MatchString(file) || !strings.HasSuffix(file, "-"+tag+".gz") {
		writeErr(w, http.StatusNotFound, "not found")
		return
	}
	if !a.dlAllowed(w, r) {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	m := a.mirror
	base := filepath.Join(m.dir, "mihomo")
	p := filepath.Join(base, tag, file)
	if err := m.fetch(ctx, ghBase+"/"+mihomoRepo+"/releases/download/"+tag+"/"+file, p, 0); err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	now := time.Now()
	os.Chtimes(filepath.Join(base, tag), now, now)
	go pruneOld(base, tag)
	http.ServeFile(w, r, p)
}

// zashboardTarGz downloads the release zip and repacks it as .tar.gz with the
// "dist/" prefix stripped.
func (m *mirror) zashboardTarGz(ctx context.Context, tag string) (string, error) {
	base := filepath.Join(m.dir, "zashboard")
	out := filepath.Join(base, tag, "dist.tar.gz")
	if _, err := os.Stat(out); err == nil {
		return out, nil
	}
	zp := filepath.Join(base, tag, zashboardZip)
	if err := m.fetch(ctx, ghBase+"/"+zashboardRepo+"/releases/download/"+tag+"/"+zashboardZip, zp, 0); err != nil {
		return "", err
	}
	defer m.lock(out)()
	if _, err := os.Stat(out); err == nil {
		return out, nil
	}
	if err := repackZip(zp, out); err != nil {
		return "", err
	}
	os.Remove(zp)
	go pruneOld(base, tag)
	return out, nil
}

func repackZip(src, dst string) error {
	zr, err := zip.OpenReader(src)
	if err != nil {
		return err
	}
	defer zr.Close()
	tmp := dst + ".part"
	f, err := os.Create(tmp)
	if err != nil {
		return err
	}
	gz := gzip.NewWriter(f)
	tw := tar.NewWriter(gz)
	var total int64
	err = func() error {
		for _, zf := range zr.File {
			name := strings.TrimPrefix(zf.Name, "dist/")
			if name == "" || strings.HasPrefix(name, "/") || strings.Contains(name, "..") {
				continue
			}
			hdr := &tar.Header{Name: name, ModTime: zf.Modified, Mode: 0o644, Typeflag: tar.TypeReg, Size: int64(zf.UncompressedSize64)}
			if zf.FileInfo().IsDir() {
				hdr.Typeflag, hdr.Mode, hdr.Size = tar.TypeDir, 0o755, 0
			}
			total += hdr.Size
			if total > 200<<20 {
				return errors.New("zashboard archive is unexpectedly large")
			}
			if err := tw.WriteHeader(hdr); err != nil {
				return err
			}
			if hdr.Typeflag == tar.TypeReg {
				rc, err := zf.Open()
				if err != nil {
					return err
				}
				_, err = io.CopyN(tw, rc, hdr.Size)
				rc.Close()
				if err != nil {
					return err
				}
			}
		}
		if err := tw.Close(); err != nil {
			return err
		}
		return gz.Close()
	}()
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, dst)
}

func (a *App) componentMirror(w http.ResponseWriter, r *http.Request, src, file string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	switch {
	case src == "mihomo" && file == "latest.json":
		tag, err := a.mirror.latestTag(ctx, mihomoRepo)
		if err != nil {
			writeErr(w, http.StatusBadGateway, err.Error())
			return true
		}
		writeJSON(w, http.StatusOK, map[string]string{"tag": tag})
		return true
	case src == "zashboard" && file == "latest.json":
		tag, err := a.mirror.latestTag(ctx, zashboardRepo)
		if err != nil {
			writeErr(w, http.StatusBadGateway, err.Error())
			return true
		}
		writeJSON(w, http.StatusOK, map[string]string{"tag": tag})
		return true
	case src == "zashboard" && file == "dist.tar.gz":
		tag, err := a.mirror.latestTag(ctx, zashboardRepo)
		if err == nil {
			var p string
			if p, err = a.mirror.zashboardTarGz(ctx, tag); err == nil {
				w.Header().Set("X-Zashboard-Version", tag)
				http.ServeFile(w, r, p)
				return true
			}
		}
		writeErr(w, http.StatusBadGateway, err.Error())
		return true
	}
	return false
}

// latestVersions is for the UI: what routers can update to.
func (a *App) latestVersions(w http.ResponseWriter, r *http.Request, u *User) {
	ctx, cancel := context.WithTimeout(r.Context(), 25*time.Second)
	defer cancel()
	out := map[string]string{}
	if tag, _, err := a.mirror.latest(ctx); err == nil {
		out["fleet"] = strings.TrimPrefix(tag, "v")
	}
	if tag, err := a.mirror.latestTag(ctx, mihomoRepo); err == nil {
		out["mihomo"] = tag
	}
	if tag, err := a.mirror.latestTag(ctx, zashboardRepo); err == nil {
		out["zashboard"] = tag
	}
	writeJSON(w, http.StatusOK, out)
}
