// SPDX-License-Identifier: GPL-3.0-or-later
package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

const (
	pollHold       = 40 * time.Second
	statusInterval = 60
	onlineWindow   = 100 * time.Second
)

type enrollReq struct {
	Code string          `json:"code"`
	Info json.RawMessage `json:"info"`
}

func (a *App) agentEnroll(w http.ResponseWriter, r *http.Request) {
	ip := clientIP(r, a.cfg.TrustProxy)
	if !a.lim.allow("enroll:"+ip, 10, 10*time.Minute) {
		writeErr(w, http.StatusTooManyRequests, "too many attempts, try later")
		return
	}
	var req enrollReq
	if err := readJSON(r, &req, 64<<10); err != nil {
		writeErr(w, http.StatusBadRequest, "bad request")
		return
	}
	code := strings.ToUpper(strings.TrimSpace(req.Code))
	var info struct {
		Hostname string `json:"hostname"`
	}
	json.Unmarshal(req.Info, &info)

	token := randomHex(32)
	var router *Router
	err := a.store.UpdateNow(func(s *state) error {
		var ec *EnrollCode
		keep := s.Codes[:0]
		for _, c := range s.Codes {
			if time.Now().After(c.Expires) {
				continue
			}
			if c.Code == code && ec == nil {
				ec = c
				continue // consume
			}
			keep = append(keep, c)
		}
		s.Codes = keep
		if ec == nil {
			return fmt.Errorf("invalid or expired code")
		}
		name := ec.Name
		if name == "" {
			name = info.Hostname
		}
		if name == "" {
			name = "router"
		}
		router = &Router{ID: newID(), OwnerID: ec.OwnerID, Name: name, TokenHash: sha(token),
			Created: time.Now(), LastSeen: time.Now(), Info: req.Info}
		s.Routers = append(s.Routers, router)
		s.audit(ec.OwnerID, router.ID, "router.enrolled", ip)
		return nil
	})
	if err != nil {
		a.lim.fail("enroll:" + ip)
		writeErr(w, http.StatusForbidden, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"router_id": router.ID, "token": token})
}

type pollReq struct {
	AgentVersion string          `json:"agent_version"`
	Status       json.RawMessage `json:"status"`
	Results      []Result        `json:"results"`
	Events       []struct {
		Type    string `json:"type"`
		OK      bool   `json:"ok"`
		Message string `json:"message"`
		Profile string `json:"profile"`
	} `json:"events"`
}

func (a *App) agentPoll(w http.ResponseWriter, r *http.Request) {
	tok := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if tok == "" {
		writeErr(w, http.StatusUnauthorized, "no token")
		return
	}
	var req pollReq
	if err := readJSON(r, &req, 8<<20); err != nil {
		writeErr(w, http.StatusBadRequest, "bad request")
		return
	}
	h := sha(tok)
	var routerID string
	a.store.Update(func(s *state) error {
		rt := s.routerByToken(h)
		if rt == nil {
			return nil
		}
		routerID = rt.ID
		rt.LastSeen = time.Now()
		rt.AgentVersion = req.AgentVersion
		if len(req.Status) > 0 && string(req.Status) != "null" {
			rt.Status = req.Status
			rt.StatusAt = time.Now()
		}
		for _, e := range req.Events {
			s.audit("", rt.ID, "agent."+e.Type, strings.TrimSpace(e.Message+" "+e.Profile))
		}
		return nil
	})
	if routerID == "" {
		writeErr(w, http.StatusUnauthorized, "unknown router")
		return
	}
	cmds := a.hub.Poll(r.Context(), routerID, req.Results, pollHold)
	if cmds == nil {
		cmds = []Command{}
	}
	a.store.Update(func(s *state) error {
		if rt := s.router(routerID); rt != nil {
			rt.LastSeen = time.Now()
		}
		return nil
	})
	writeJSON(w, http.StatusOK, map[string]any{"commands": cmds, "status_interval": statusInterval})
}

func (a *App) online(rt *Router) bool {
	return a.hub.Polling(rt.ID) || time.Since(rt.LastSeen) < onlineWindow
}
