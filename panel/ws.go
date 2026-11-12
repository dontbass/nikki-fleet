// SPDX-License-Identifier: GPL-3.0-or-later
package main

import (
	"bufio"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// Minimal RFC 6455 WebSocket server (no extensions, no subprotocols): enough for
// the browser terminal and keeps the panel free of extra dependencies.

const (
	wsText   = 1
	wsBinary = 2
	wsClose  = 8
	wsPing   = 9
	wsPong   = 10

	wsMaxMessage = 1 << 20
)

type wsConn struct {
	c  net.Conn
	br *bufio.Reader
	wm sync.Mutex
}

// sameOrigin: a browser always sends Origin on WebSocket requests; only pages of
// the panel itself may open a terminal (blocks cross-site WebSocket hijacking,
// since cookies are sent along with the upgrade).
func (a *App) sameOrigin(r *http.Request) bool {
	o := r.Header.Get("Origin")
	if o == "" {
		return false
	}
	u, err := url.Parse(o)
	if err != nil {
		return false
	}
	if strings.EqualFold(u.Host, r.Host) {
		return true
	}
	if a.cfg.TrustProxy && strings.EqualFold(u.Host, r.Header.Get("X-Forwarded-Host")) {
		return true
	}
	if p, err := url.Parse(a.cfg.PublicURL); err == nil && a.cfg.PublicURL != "" && strings.EqualFold(u.Host, p.Host) {
		return true
	}
	return false
}

func wsUpgrade(w http.ResponseWriter, r *http.Request) (*wsConn, error) {
	if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") || !strings.Contains(strings.ToLower(r.Header.Get("Connection")), "upgrade") {
		return nil, errors.New("not a websocket request")
	}
	if r.Header.Get("Sec-WebSocket-Version") != "13" {
		return nil, errors.New("unsupported websocket version")
	}
	key := r.Header.Get("Sec-WebSocket-Key")
	if key == "" {
		return nil, errors.New("missing Sec-WebSocket-Key")
	}
	hj, ok := w.(http.Hijacker)
	if !ok {
		return nil, errors.New("hijacking not supported")
	}
	c, brw, err := hj.Hijack()
	if err != nil {
		return nil, err
	}
	c.SetDeadline(time.Time{}) // the server's read/write timeouts do not apply to a terminal
	h := sha1.Sum([]byte(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
	resp := "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
		"Sec-WebSocket-Accept: " + base64.StdEncoding.EncodeToString(h[:]) + "\r\n\r\n"
	if _, err := c.Write([]byte(resp)); err != nil {
		c.Close()
		return nil, err
	}
	return &wsConn{c: c, br: brw.Reader}, nil
}

// Read returns the next data message (text or binary), answering pings itself.
func (ws *wsConn) Read() (int, []byte, error) {
	var msg []byte
	op := 0
	for {
		var h [2]byte
		if _, err := io.ReadFull(ws.br, h[:]); err != nil {
			return 0, nil, err
		}
		fin, code := h[0]&0x80 != 0, int(h[0]&0x0f)
		if h[1]&0x80 == 0 {
			return 0, nil, errors.New("unmasked client frame")
		}
		n := uint64(h[1] & 0x7f)
		switch n {
		case 126:
			var b [2]byte
			if _, err := io.ReadFull(ws.br, b[:]); err != nil {
				return 0, nil, err
			}
			n = uint64(binary.BigEndian.Uint16(b[:]))
		case 127:
			var b [8]byte
			if _, err := io.ReadFull(ws.br, b[:]); err != nil {
				return 0, nil, err
			}
			n = binary.BigEndian.Uint64(b[:])
		}
		if n > wsMaxMessage || uint64(len(msg))+n > wsMaxMessage {
			return 0, nil, errors.New("websocket message too large")
		}
		var mask [4]byte
		if _, err := io.ReadFull(ws.br, mask[:]); err != nil {
			return 0, nil, err
		}
		p := make([]byte, n)
		if _, err := io.ReadFull(ws.br, p); err != nil {
			return 0, nil, err
		}
		for i := range p {
			p[i] ^= mask[i%4]
		}
		switch code {
		case wsPing:
			ws.write(wsPong, p)
			continue
		case wsPong:
			continue
		case wsClose:
			ws.write(wsClose, nil)
			return 0, nil, io.EOF
		case 0: // continuation
			if op == 0 {
				return 0, nil, errors.New("unexpected continuation frame")
			}
		case wsText, wsBinary:
			if op != 0 {
				return 0, nil, errors.New("interleaved data frames")
			}
			op = code
		default:
			return 0, nil, errors.New("unknown websocket opcode")
		}
		msg = append(msg, p...)
		if fin {
			return op, msg, nil
		}
	}
}

func (ws *wsConn) write(op int, p []byte) error {
	ws.wm.Lock()
	defer ws.wm.Unlock()
	hdr := []byte{0x80 | byte(op)}
	switch n := len(p); {
	case n < 126:
		hdr = append(hdr, byte(n))
	case n <= 0xffff:
		hdr = append(hdr, 126, byte(n>>8), byte(n))
	default:
		hdr = append(hdr, 127)
		hdr = binary.BigEndian.AppendUint64(hdr, uint64(n))
	}
	ws.c.SetWriteDeadline(time.Now().Add(30 * time.Second))
	if _, err := ws.c.Write(append(hdr, p...)); err != nil {
		return err
	}
	return nil
}

func (ws *wsConn) Text(p []byte) error   { return ws.write(wsText, p) }
func (ws *wsConn) Binary(p []byte) error { return ws.write(wsBinary, p) }
func (ws *wsConn) Ping() error           { return ws.write(wsPing, nil) }
func (ws *wsConn) Close() error {
	ws.write(wsClose, nil)
	return ws.c.Close()
}
