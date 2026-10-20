// SPDX-License-Identifier: GPL-3.0-or-later
package main

import (
	"context"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

const (
	pbkdf2Iter    = 210000
	sessionCookie = "nf_session"
	sessionTTL    = 30 * 24 * time.Hour
)

func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

func newID() string { return randomHex(8) }

// enrollment code like K7QD-M2XA (no 0/1/O/I to avoid confusion)
func newEnrollCode() string {
	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	b := make([]byte, 8)
	rand.Read(b)
	out := make([]byte, 0, 9)
	for i, c := range b {
		if i == 4 {
			out = append(out, '-')
		}
		out = append(out, alphabet[int(c)%len(alphabet)])
	}
	return string(out)
}

func sha(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}

func hashPassword(pw, salt string) string {
	k, err := pbkdf2.Key(sha256.New, pw, []byte(salt), pbkdf2Iter, 32)
	if err != nil {
		panic(err)
	}
	return hex.EncodeToString(k)
}

func checkPassword(u *User, pw string) bool {
	return subtle.ConstantTimeCompare([]byte(hashPassword(pw, u.Salt)), []byte(u.PassHash)) == 1
}

/* ---------- login rate limiting ---------- */

type limiter struct {
	mu   sync.Mutex
	hits map[string][]time.Time
}

func newLimiter() *limiter { return &limiter{hits: map[string][]time.Time{}} }

// allow returns false when key had >= max failures within window.
func (l *limiter) allow(key string, max int, window time.Duration) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	var keep []time.Time
	for _, t := range l.hits[key] {
		if now.Sub(t) < window {
			keep = append(keep, t)
		}
	}
	l.hits[key] = keep
	return len(keep) < max
}

func (l *limiter) fail(key string) {
	l.mu.Lock()
	l.hits[key] = append(l.hits[key], time.Now())
	l.mu.Unlock()
}

func clientIP(r *http.Request, trustProxy bool) string {
	if trustProxy {
		if xf := r.Header.Get("X-Forwarded-For"); xf != "" {
			return strings.TrimSpace(strings.Split(xf, ",")[0])
		}
		if xr := r.Header.Get("X-Real-IP"); xr != "" {
			return xr
		}
	}
	h, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return h
}

/* ---------- sessions ---------- */

type ctxKey int

const userKey ctxKey = 1

func (a *App) createSession(w http.ResponseWriter, r *http.Request, u *User) {
	tok := randomHex(32)
	a.store.UpdateNow(func(s *state) error {
		// drop expired sessions
		keep := s.Sessions[:0]
		for _, x := range s.Sessions {
			if time.Now().Before(x.Expires) {
				keep = append(keep, x)
			}
		}
		s.Sessions = append(keep, &Session{TokenHash: sha(tok), UserID: u.ID, Expires: time.Now().Add(sessionTTL)})
		return nil
	})
	http.SetCookie(w, &http.Cookie{
		Name: sessionCookie, Value: tok, Path: "/", HttpOnly: true,
		SameSite: http.SameSiteLaxMode, Secure: a.isHTTPS(r), Expires: time.Now().Add(sessionTTL),
	})
}

func (a *App) destroySession(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(sessionCookie); err == nil {
		h := sha(c.Value)
		a.store.UpdateNow(func(s *state) error {
			keep := s.Sessions[:0]
			for _, x := range s.Sessions {
				if x.TokenHash != h {
					keep = append(keep, x)
				}
			}
			s.Sessions = keep
			return nil
		})
	}
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: "", Path: "/", MaxAge: -1, HttpOnly: true})
}

func (a *App) currentUser(r *http.Request) *User {
	c, err := r.Cookie(sessionCookie)
	if err != nil || c.Value == "" {
		return nil
	}
	h := sha(c.Value)
	var u *User
	a.store.View(func(s *state) {
		for _, x := range s.Sessions {
			if x.TokenHash == h && time.Now().Before(x.Expires) {
				if found := s.userByID(x.UserID); found != nil {
					cp := *found
					u = &cp
				}
				return
			}
		}
	})
	return u
}

func (a *App) isHTTPS(r *http.Request) bool {
	return r.TLS != nil || (a.cfg.TrustProxy && r.Header.Get("X-Forwarded-Proto") == "https") || strings.HasPrefix(a.cfg.PublicURL, "https://")
}

// requireUser wraps API handlers: session required, and a custom header on
// state-changing requests (blocks cross-site form posts / CSRF).
func (a *App) requireUser(h func(w http.ResponseWriter, r *http.Request, u *User)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Header.Get("X-NF") != "1" {
			writeErr(w, http.StatusForbidden, "missing X-NF header")
			return
		}
		u := a.currentUser(r)
		if u == nil {
			writeErr(w, http.StatusUnauthorized, "not logged in")
			return
		}
		h(w, r.WithContext(context.WithValue(r.Context(), userKey, u)), u)
	}
}
