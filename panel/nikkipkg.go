// SPDX-License-Identifier: GPL-3.0-or-later
package main

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// Nikki package mirror for router updates. The Nikki release ships one ~38 MB
// tarball per architecture and OpenWrt branch, mostly the mihomo cores. The
// panel downloads it and hands routers only the small Nikki packages (nikki,
// luci-app-nikki, translations: a few hundred KB) with their SHA-256, so a
// router never needs GitHub, the Nikki feed or the RAM for the tarball.
//
//	GET /dl/nikki-pkg/{branch}/{arch}/index.json   {"tag","packages":{name:{file,version,sha256,size}}}
//	GET /dl/nikki-pkg/{branch}/{arch}/{file}       one of those packages

const nikkiRepo = "nikkinikki-org/OpenWrt-nikki"

var (
	reNikkiBranch = regexp.MustCompile(`^(openwrt-24\.10|openwrt-25\.12|SNAPSHOT)$`)
	reNikkiArch   = regexp.MustCompile(`^[a-z0-9_-]{2,40}$`)
	reNikkiPkg    = regexp.MustCompile(`^(nikki|luci-app-nikki|luci-i18n-nikki-[a-z-]+)[-_][A-Za-z0-9.~+_-]+\.(ipk|apk)$`)
)

type nikkiPkg struct {
	File    string `json:"file"`
	Version string `json:"version"`
	SHA256  string `json:"sha256"`
	Size    int64  `json:"size"`
}

type nikkiIndex struct {
	Tag      string              `json:"tag"`
	Arch     string              `json:"arch"`
	Branch   string              `json:"branch"`
	Packages map[string]nikkiPkg `json:"packages"`
}

// nikkiPackages makes sure the small packages of the latest release are
// extracted for this branch/arch and returns their index.
func (m *mirror) nikkiPackages(ctx context.Context, branch, arch string) (*nikkiIndex, string, error) {
	tag, err := m.latestTag(ctx, nikkiRepo)
	if err != nil {
		return nil, "", err
	}
	dir := filepath.Join(m.dir, "nikki-pkg", tag, branch, arch)
	idxPath := filepath.Join(dir, "index.json")
	if b, err := os.ReadFile(idxPath); err == nil {
		var idx nikkiIndex
		if json.Unmarshal(b, &idx) == nil {
			return &idx, dir, nil
		}
	}
	tarName := "nikki_" + arch + "-" + branch + ".tar.gz"
	tarPath := filepath.Join(m.dir, "nikki-pkg", tag, tarName)
	if err := m.fetch(ctx, ghBase+"/"+nikkiRepo+"/releases/download/"+tag+"/"+tarName, tarPath, 0); err != nil {
		return nil, "", err
	}
	defer m.lock(idxPath)()
	if _, err := os.Stat(idxPath); err == nil {
		return m.nikkiPackages(ctx, branch, arch)
	}
	idx, err := extractNikki(tarPath, dir)
	if err != nil {
		return nil, "", err
	}
	idx.Tag, idx.Arch, idx.Branch = tag, arch, branch
	b, _ := json.MarshalIndent(idx, "", "  ")
	if err := os.WriteFile(idxPath+".part", b, 0o644); err != nil {
		return nil, "", err
	}
	if err := os.Rename(idxPath+".part", idxPath); err != nil {
		return nil, "", err
	}
	os.Remove(tarPath) // the big tarball is not needed any more
	go pruneOld(filepath.Join(m.dir, "nikki-pkg"), tag)
	return idx, dir, nil
}

// extractNikki copies the Nikki packages (not the mihomo cores) out of a
// release tarball and records name, version and checksum of each. Versions come
// from the tarball's index.json.
func extractNikki(tarPath, dir string) (*nikkiIndex, error) {
	f, err := os.Open(tarPath)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	var versions struct {
		Packages map[string]string `json:"packages"`
	}
	files := map[string]nikkiPkg{}
	tr := tar.NewReader(gz)
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, err
		}
		name := filepath.Base(h.Name)
		if h.Typeflag != tar.TypeReg {
			continue
		}
		if name == "index.json" {
			json.NewDecoder(io.LimitReader(tr, 1<<20)).Decode(&versions)
			continue
		}
		if !reNikkiPkg.MatchString(name) || h.Size > 16<<20 {
			continue
		}
		out, err := os.Create(filepath.Join(dir, name))
		if err != nil {
			return nil, err
		}
		sum := sha256.New()
		n, err := io.Copy(io.MultiWriter(out, sum), tr)
		if cerr := out.Close(); err == nil {
			err = cerr
		}
		if err != nil {
			return nil, err
		}
		files[name] = nikkiPkg{File: name, SHA256: hex.EncodeToString(sum.Sum(nil)), Size: n}
	}
	idx := &nikkiIndex{Packages: map[string]nikkiPkg{}}
	for pkg, ver := range versions.Packages {
		if strings.HasPrefix(pkg, "mihomo") {
			continue
		}
		for fn, p := range files {
			if strings.HasPrefix(fn, pkg+"_"+ver+"_") || fn == pkg+"-"+ver+".apk" {
				p.Version = ver
				idx.Packages[pkg] = p
			}
		}
	}
	if _, ok := idx.Packages["nikki"]; !ok {
		return nil, errors.New("nikki package not found in the release")
	}
	return idx, nil
}

func (a *App) nikkiPkgMirror(w http.ResponseWriter, r *http.Request) {
	branch, arch, file := r.PathValue("branch"), r.PathValue("arch"), r.PathValue("file")
	if !reNikkiBranch.MatchString(branch) || !reNikkiArch.MatchString(arch) {
		writeErr(w, http.StatusNotFound, "not found")
		return
	}
	if !a.dlAllowed(w, r) {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	idx, dir, err := a.mirror.nikkiPackages(ctx, branch, arch)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	if file == "index.json" {
		writeJSON(w, http.StatusOK, idx)
		return
	}
	for _, p := range idx.Packages {
		if p.File == file {
			http.ServeFile(w, r, filepath.Join(dir, file))
			return
		}
	}
	writeErr(w, http.StatusNotFound, "not found")
}
