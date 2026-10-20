// SPDX-License-Identifier: GPL-3.0-or-later
package main

import (
	_ "embed"
	"net/http"
	"strings"
)

// install.sh.tmpl is a copy of /install.sh from the repository root
// (scripts/sync-configurator.sh keeps it in sync). Served at /install.sh with
// the panel address filled in:
//
//	wget -qO- https://panel.example.com/install.sh | sh -s -- CODE
//
//go:embed install.sh.tmpl
var installScriptTmpl string

func (a *App) installScript(w http.ResponseWriter, r *http.Request) {
	s := strings.Replace(installScriptTmpl, "PANEL='__PANEL__'", "PANEL='"+a.publicURL(r)+"'", 1)
	s = strings.Replace(s, "REPO='__REPO__'", "REPO='"+a.cfg.Repo+"'", 1)
	w.Header().Set("Content-Type", "text/x-shellscript; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Write([]byte(s))
}
