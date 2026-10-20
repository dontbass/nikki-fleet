// nikki-fleet panel: remote management for OpenWrt routers running Nikki + mihomo.
// SPDX-License-Identifier: GPL-3.0-or-later
package main

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

var version = "0.1.2"

//go:embed web
var webFS embed.FS

type Config struct {
	Listen       string
	DataDir      string
	PublicURL    string
	TrustProxy   bool
	Registration string
	Repo         string
}

type App struct {
	cfg   Config
	store *Store
	hub   *Hub
	lim   *limiter
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func main() {
	cfg := Config{}
	flag.StringVar(&cfg.Listen, "listen", env("NF_LISTEN", ":8080"), "listen address")
	flag.StringVar(&cfg.DataDir, "data", env("NF_DATA", "./data"), "data directory")
	flag.StringVar(&cfg.PublicURL, "public-url", env("NF_PUBLIC_URL", ""), "public URL of the panel, e.g. https://fleet.example.com")
	flag.BoolVar(&cfg.TrustProxy, "trust-proxy", env("NF_TRUST_PROXY", "0") == "1", "trust X-Forwarded-* headers from a reverse proxy")
	flag.StringVar(&cfg.Registration, "registration", env("NF_REGISTRATION", ""), "open | closed (default: closed after the first user)")
	flag.StringVar(&cfg.Repo, "repo", env("NF_REPO", "dontbass/nikki-fleet"), "GitHub repo with router packages")
	showVersion := flag.Bool("version", false, "print version")
	flag.Parse()
	if *showVersion {
		println(version)
		return
	}
	cfg.PublicURL = strings.TrimRight(cfg.PublicURL, "/")

	store, err := OpenStore(cfg.DataDir)
	if err != nil {
		log.Fatalf("open data: %v", err)
	}
	if cfg.Registration != "" {
		store.UpdateNow(func(s *state) error { s.Settings.Registration = cfg.Registration; return nil })
	}
	app := &App{cfg: cfg, store: store, hub: NewHub(), lim: newLimiter()}

	srv := &http.Server{
		Addr:              cfg.Listen,
		Handler:           app.routes(),
		ReadHeaderTimeout: 15 * time.Second,
		ReadTimeout:       60 * time.Second,
		WriteTimeout:      150 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	go func() {
		log.Printf("nikki-fleet panel %s listening on %s (data: %s)", version, cfg.Listen, cfg.DataDir)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatal(err)
		}
	}()
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	srv.Shutdown(ctx)
	store.Flush()
}

func (a *App) routes() http.Handler {
	mux := http.NewServeMux()

	// router agents
	mux.HandleFunc("POST /api/agent/v1/enroll", a.agentEnroll)
	mux.HandleFunc("POST /api/agent/v1/poll", a.agentPoll)
	mux.HandleFunc("GET /install.sh", a.installScript)

	// auth
	mux.HandleFunc("POST /api/auth/register", a.register)
	mux.HandleFunc("POST /api/auth/login", a.login)
	mux.HandleFunc("POST /api/auth/logout", a.logout)
	mux.HandleFunc("GET /api/info", a.info)
	mux.HandleFunc("GET /api/me", a.requireUser(a.me))
	mux.HandleFunc("POST /api/me/password", a.requireUser(a.changePassword))

	// routers
	mux.HandleFunc("GET /api/routers", a.requireUser(a.listRouters))
	mux.HandleFunc("POST /api/routers/enroll", a.requireUser(a.createEnrollCode))
	mux.HandleFunc("GET /api/routers/{id}", a.requireUser(a.getRouter))
	mux.HandleFunc("PATCH /api/routers/{id}", a.requireUser(a.patchRouter))
	mux.HandleFunc("DELETE /api/routers/{id}", a.requireUser(a.deleteRouter))
	mux.HandleFunc("POST /api/routers/{id}/cmd", a.requireUser(a.routerCmd))
	mux.HandleFunc("GET /api/routers/{id}/versions", a.requireUser(a.listVersions))
	mux.HandleFunc("GET /api/routers/{id}/versions/{vid}", a.requireUser(a.getVersion))
	mux.HandleFunc("GET /api/routers/{id}/shares", a.requireUser(a.listShares))
	mux.HandleFunc("POST /api/routers/{id}/shares", a.requireUser(a.addShare))
	mux.HandleFunc("DELETE /api/routers/{id}/shares/{uid}", a.requireUser(a.removeShare))
	mux.HandleFunc("GET /api/routers/{id}/audit", a.requireUser(a.routerAudit))

	// admin
	mux.HandleFunc("GET /api/admin/users", a.requireUser(a.adminUsers))
	mux.HandleFunc("POST /api/admin/users", a.requireUser(a.adminCreateUser))
	mux.HandleFunc("DELETE /api/admin/users/{id}", a.requireUser(a.adminDeleteUser))
	mux.HandleFunc("PATCH /api/admin/settings", a.requireUser(a.adminSettings))

	// web UI
	sub, _ := fs.Sub(webFS, "web")
	static := http.FileServer(http.FS(sub))
	mux.Handle("GET /", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "same-origin")
		w.Header().Set("X-Frame-Options", "SAMEORIGIN")
		if strings.HasPrefix(r.URL.Path, "/api/") {
			writeErr(w, http.StatusNotFound, "not found")
			return
		}
		static.ServeHTTP(w, r)
	}))
	return mux
}

/* ---------- JSON helpers ---------- */

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}

func readJSON(r *http.Request, v any, max int64) error {
	dec := json.NewDecoder(io.LimitReader(r.Body, max))
	return dec.Decode(v)
}

func (a *App) publicURL(r *http.Request) string {
	if a.cfg.PublicURL != "" {
		return a.cfg.PublicURL
	}
	scheme := "http"
	if a.isHTTPS(r) {
		scheme = "https"
	}
	host := r.Host
	if a.cfg.TrustProxy && r.Header.Get("X-Forwarded-Host") != "" {
		host = r.Header.Get("X-Forwarded-Host")
	}
	return scheme + "://" + host
}
