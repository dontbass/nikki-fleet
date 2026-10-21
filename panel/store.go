// SPDX-License-Identifier: GPL-3.0-or-later
package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"sync"
	"time"
)

type User struct {
	ID       string    `json:"id"`
	Username string    `json:"username"`
	PassHash string    `json:"pass_hash"`
	Salt     string    `json:"salt"`
	IsAdmin  bool      `json:"is_admin"`
	Created  time.Time `json:"created"`
}

type Session struct {
	TokenHash string    `json:"token_hash"`
	UserID    string    `json:"user_id"`
	Expires   time.Time `json:"expires"`
}

type Router struct {
	ID           string          `json:"id"`
	OwnerID      string          `json:"owner_id"`
	Name         string          `json:"name"`
	Notes        string          `json:"notes"`
	TokenHash    string          `json:"token_hash"`
	Created      time.Time       `json:"created"`
	LastSeen     time.Time       `json:"last_seen"`
	AgentVersion string          `json:"agent_version"`
	Info         json.RawMessage `json:"info,omitempty"`
	Status       json.RawMessage `json:"status,omitempty"`
	StatusAt     time.Time       `json:"status_at"`
}

type Share struct {
	RouterID string `json:"router_id"`
	UserID   string `json:"user_id"`
	Role     string `json:"role"` // viewer | editor
}

type EnrollCode struct {
	Code    string    `json:"code"`
	OwnerID string    `json:"owner_id"`
	Name    string    `json:"name"`
	Expires time.Time `json:"expires"`
}

type AuditEntry struct {
	Time     time.Time `json:"time"`
	UserID   string    `json:"user_id,omitempty"`
	RouterID string    `json:"router_id,omitempty"`
	Action   string    `json:"action"`
	Detail   string    `json:"detail,omitempty"`
}

type ConfigVersion struct {
	ID       string    `json:"id"`
	RouterID string    `json:"router_id"`
	Kind     string    `json:"kind"`
	Name     string    `json:"name"`
	UserID   string    `json:"user_id"`
	Time     time.Time `json:"time"`
	Size     int       `json:"size"`
	Result   string    `json:"result"`
}

type Settings struct {
	Registration string `json:"registration"` // open | closed
	Wallpaper    string `json:"wallpaper"`    // "" = Bing picture of the day on the login page, "off"
}

type state struct {
	Users    []*User          `json:"users"`
	Sessions []*Session       `json:"sessions"`
	Routers  []*Router        `json:"routers"`
	Shares   []*Share         `json:"shares"`
	Codes    []*EnrollCode    `json:"codes"`
	Audit    []*AuditEntry    `json:"audit"`
	Versions []*ConfigVersion `json:"versions"`
	Settings Settings         `json:"settings"`
}

// Store keeps all panel state in one JSON file (atomic writes) and config
// history in data/configs/<router>/<version>.yaml. It is meant for small and
// medium fleets; the access methods are the seam for a SQL backend later.
type Store struct {
	mu   sync.RWMutex
	dir  string
	s    state
	dirt bool
}

const maxAudit = 5000

func OpenStore(dir string) (*Store, error) {
	if err := os.MkdirAll(filepath.Join(dir, "configs"), 0o700); err != nil {
		return nil, err
	}
	st := &Store{dir: dir}
	b, err := os.ReadFile(filepath.Join(dir, "state.json"))
	if err == nil {
		if err := json.Unmarshal(b, &st.s); err != nil {
			return nil, err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	go st.flusher()
	return st, nil
}

func (st *Store) flusher() {
	t := time.NewTicker(2 * time.Second)
	for range t.C {
		st.Flush()
	}
}

// Flush writes state to disk if something changed.
func (st *Store) Flush() error {
	st.mu.Lock()
	if !st.dirt {
		st.mu.Unlock()
		return nil
	}
	b, err := json.MarshalIndent(&st.s, "", " ")
	st.dirt = false
	st.mu.Unlock()
	if err != nil {
		return err
	}
	tmp := filepath.Join(st.dir, "state.json.tmp")
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(st.dir, "state.json"))
}

// Update runs fn under the write lock and marks state dirty.
func (st *Store) Update(fn func(s *state) error) error {
	st.mu.Lock()
	defer st.mu.Unlock()
	err := fn(&st.s)
	st.dirt = true
	return err
}

// UpdateNow is Update followed by an immediate flush (for important changes).
func (st *Store) UpdateNow(fn func(s *state) error) error {
	if err := st.Update(fn); err != nil {
		return err
	}
	return st.Flush()
}

func (st *Store) View(fn func(s *state)) {
	st.mu.RLock()
	defer st.mu.RUnlock()
	fn(&st.s)
}

/* ---------- lookups (call with lock held) ---------- */

func (s *state) userByID(id string) *User {
	for _, u := range s.Users {
		if u.ID == id {
			return u
		}
	}
	return nil
}

func (s *state) userByName(name string) *User {
	for _, u := range s.Users {
		if u.Username == name {
			return u
		}
	}
	return nil
}

func (s *state) router(id string) *Router {
	for _, r := range s.Routers {
		if r.ID == id {
			return r
		}
	}
	return nil
}

func (s *state) routerByToken(hash string) *Router {
	for _, r := range s.Routers {
		if r.TokenHash != "" && r.TokenHash == hash {
			return r
		}
	}
	return nil
}

// role returns owner | editor | viewer | "" for a user on a router.
func (s *state) role(u *User, r *Router) string {
	if u == nil || r == nil {
		return ""
	}
	if r.OwnerID == u.ID {
		return "owner"
	}
	for _, sh := range s.Shares {
		if sh.RouterID == r.ID && sh.UserID == u.ID {
			return sh.Role
		}
	}
	return ""
}

func (s *state) audit(userID, routerID, action, detail string) {
	s.Audit = append(s.Audit, &AuditEntry{Time: time.Now(), UserID: userID, RouterID: routerID, Action: action, Detail: detail})
	if len(s.Audit) > maxAudit {
		s.Audit = s.Audit[len(s.Audit)-maxAudit:]
	}
}

func (s *state) deleteRouter(id string) {
	rs := s.Routers[:0]
	for _, r := range s.Routers {
		if r.ID != id {
			rs = append(rs, r)
		}
	}
	s.Routers = rs
	sh := s.Shares[:0]
	for _, x := range s.Shares {
		if x.RouterID != id {
			sh = append(sh, x)
		}
	}
	s.Shares = sh
	vs := s.Versions[:0]
	for _, v := range s.Versions {
		if v.RouterID != id {
			vs = append(vs, v)
		}
	}
	s.Versions = vs
}

/* ---------- config history files ---------- */

var safeID = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

func (st *Store) SaveConfig(routerID, versionID string, content []byte) error {
	if !safeID.MatchString(routerID) || !safeID.MatchString(versionID) {
		return errors.New("bad id")
	}
	d := filepath.Join(st.dir, "configs", routerID)
	if err := os.MkdirAll(d, 0o700); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(d, versionID+".yaml"), content, 0o600)
}

func (st *Store) LoadConfig(routerID, versionID string) ([]byte, error) {
	if !safeID.MatchString(routerID) || !safeID.MatchString(versionID) {
		return nil, errors.New("bad id")
	}
	return os.ReadFile(filepath.Join(st.dir, "configs", routerID, versionID+".yaml"))
}

func (st *Store) DeleteConfigs(routerID string) {
	if safeID.MatchString(routerID) {
		os.RemoveAll(filepath.Join(st.dir, "configs", routerID))
	}
}

// PruneVersions keeps the newest n versions per router and removes older files.
func (st *Store) PruneVersions(routerID string, n int) {
	var drop []string
	st.Update(func(s *state) error {
		var mine, rest []*ConfigVersion
		for _, v := range s.Versions {
			if v.RouterID == routerID {
				mine = append(mine, v)
			} else {
				rest = append(rest, v)
			}
		}
		sort.Slice(mine, func(i, j int) bool { return mine[i].Time.After(mine[j].Time) })
		if len(mine) > n {
			for _, v := range mine[n:] {
				drop = append(drop, v.ID)
			}
			mine = mine[:n]
		}
		s.Versions = append(rest, mine...)
		return nil
	})
	for _, id := range drop {
		os.Remove(filepath.Join(st.dir, "configs", routerID, id+".yaml"))
	}
}
