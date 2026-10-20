// SPDX-License-Identifier: GPL-3.0-or-later
package main

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"
)

// Command is sent to a router agent.
type Command struct {
	ID   string          `json:"id"`
	Type string          `json:"type"`
	Args json.RawMessage `json:"args,omitempty"`
}

// Result comes back from the agent.
type Result struct {
	ID    string          `json:"id"`
	OK    bool            `json:"ok"`
	Data  json.RawMessage `json:"data,omitempty"`
	Error string          `json:"error,omitempty"`
}

type routerQueue struct {
	queue   []Command
	waiters map[string]chan Result
	wake    chan struct{}
	polling int
}

// Hub delivers commands to long-polling agents and routes results back.
type Hub struct {
	mu sync.Mutex
	q  map[string]*routerQueue
}

func NewHub() *Hub { return &Hub{q: map[string]*routerQueue{}} }

func (h *Hub) get(routerID string) *routerQueue {
	rq := h.q[routerID]
	if rq == nil {
		rq = &routerQueue{waiters: map[string]chan Result{}, wake: make(chan struct{}, 1)}
		h.q[routerID] = rq
	}
	return rq
}

var ErrTimeout = errors.New("router did not answer in time")

// Call queues a command and waits for its result (or ctx/timeout). A command
// that was never picked up by the agent is withdrawn, so stale changes are
// not applied later when the router comes back online.
func (h *Hub) Call(ctx context.Context, routerID, typ string, args any, timeout time.Duration) (Result, error) {
	raw, _ := json.Marshal(args)
	cmd := Command{ID: newID(), Type: typ, Args: raw}
	ch := make(chan Result, 1)

	h.mu.Lock()
	rq := h.get(routerID)
	rq.queue = append(rq.queue, cmd)
	rq.waiters[cmd.ID] = ch
	select {
	case rq.wake <- struct{}{}:
	default:
	}
	h.mu.Unlock()

	t := time.NewTimer(timeout)
	defer t.Stop()
	select {
	case res := <-ch:
		return res, nil
	case <-t.C:
	case <-ctx.Done():
	}
	h.mu.Lock()
	delete(rq.waiters, cmd.ID)
	for i, c := range rq.queue {
		if c.ID == cmd.ID {
			rq.queue = append(rq.queue[:i], rq.queue[i+1:]...)
			break
		}
	}
	h.mu.Unlock()
	return Result{}, ErrTimeout
}

// Poll is called by the agent handler: deliver results, then return queued
// commands, waiting up to hold for new ones.
func (h *Hub) Poll(ctx context.Context, routerID string, results []Result, hold time.Duration) []Command {
	h.mu.Lock()
	rq := h.get(routerID)
	for _, r := range results {
		if ch, ok := rq.waiters[r.ID]; ok {
			ch <- r
			delete(rq.waiters, r.ID)
		}
	}
	rq.polling++
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		rq.polling--
		h.mu.Unlock()
	}()

	t := time.NewTimer(hold)
	defer t.Stop()
	for {
		h.mu.Lock()
		if len(rq.queue) > 0 {
			cmds := rq.queue
			rq.queue = nil
			h.mu.Unlock()
			return cmds
		}
		h.mu.Unlock()
		select {
		case <-rq.wake:
		case <-t.C:
			return nil
		case <-ctx.Done():
			return nil
		}
	}
}

// Polling reports whether an agent is currently connected (long-poll open).
func (h *Hub) Polling(routerID string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	rq := h.q[routerID]
	return rq != nil && rq.polling > 0
}

// Forget drops queue state for a removed router.
func (h *Hub) Forget(routerID string) {
	h.mu.Lock()
	delete(h.q, routerID)
	h.mu.Unlock()
}
