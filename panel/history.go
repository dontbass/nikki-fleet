// SPDX-License-Identifier: GPL-3.0-or-later
package main

import (
	"encoding/json"
	"sync"
	"time"
)

// Short in-memory history of each router's live numbers (one sample per status
// report, about a minute apart, last 90), for the sparklines on the fleet page.
// It is not persisted: after a panel restart the lines simply start again.

const sparkLen = 90

type sample struct {
	T     int64   `json:"t"`               // unix seconds
	Down  float64 `json:"down"`            // bytes/s since the previous sample
	Up    float64 `json:"up"`              // bytes/s
	Conns int     `json:"conns"`           // open connections
	Mem   float64 `json:"mem"`             // used share of RAM, 0..1
	Load  float64 `json:"load"`            // 1-minute load average
	Delay int     `json:"delay,omitempty"` // exit node latency, ms
	totUp float64
	totDn float64
}

type history struct {
	mu sync.Mutex
	m  map[string][]sample
}

var hist = &history{m: map[string][]sample{}}

func (h *history) record(routerID string, raw json.RawMessage) {
	var st struct {
		Load   []float64 `json:"load"`
		Memory struct {
			Total     float64 `json:"total"`
			Available float64 `json:"available"`
		} `json:"memory"`
		Traffic *struct {
			Up          float64 `json:"up"`
			Down        float64 `json:"down"`
			Connections int     `json:"connections"`
		} `json:"traffic"`
		Exit *struct {
			Delay int `json:"delay"`
		} `json:"exit"`
	}
	if json.Unmarshal(raw, &st) != nil {
		return
	}
	s := sample{T: time.Now().Unix()}
	if len(st.Load) > 0 {
		s.Load = st.Load[0]
	}
	if st.Memory.Total > 0 {
		s.Mem = 1 - st.Memory.Available/st.Memory.Total
	}
	if st.Exit != nil {
		s.Delay = st.Exit.Delay
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	l := h.m[routerID]
	if st.Traffic != nil {
		s.Conns, s.totUp, s.totDn = st.Traffic.Connections, st.Traffic.Up, st.Traffic.Down
		if n := len(l); n > 0 {
			p := l[n-1]
			if dt := float64(s.T - p.T); dt >= 5 && s.totDn >= p.totDn && s.totUp >= p.totUp && p.totDn+p.totUp > 0 {
				s.Down, s.Up = (s.totDn-p.totDn)/dt, (s.totUp-p.totUp)/dt
			}
			if s.T-p.T < 5 { // two reports at once (e.g. after a command): keep the newer
				l = l[:n-1]
			}
		}
	}
	l = append(l, s)
	if len(l) > sparkLen {
		l = append([]sample(nil), l[len(l)-sparkLen:]...)
	}
	h.m[routerID] = l
}

func (h *history) get(routerID string) []sample {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]sample(nil), h.m[routerID]...)
}

func (h *history) drop(routerID string) {
	h.mu.Lock()
	delete(h.m, routerID)
	h.mu.Unlock()
}
