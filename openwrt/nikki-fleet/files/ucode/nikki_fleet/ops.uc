// nikki-fleet: shared operations for Nikki + mihomo on OpenWrt.
// Used by the CLI/agent (/usr/bin/nikki-fleet) and the LuCI rpcd plugin.
// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

import { readfile, writefile, popen, stat, lsdir, mkdir, unlink, rename } from 'fs';

export const VERSION = '0.1.10';

// NF_ROOT lets tests run against a fake filesystem root.
const ROOT = getenv('NF_ROOT') ?? '';

export const P = {
	profiles: ROOT + '/etc/nikki/profiles',
	subs: ROOT + '/etc/nikki/subscriptions',
	run: ROOT + '/etc/nikki/run',
	runcfg: ROOT + '/etc/nikki/run/config.yaml',
	state: ROOT + '/etc/nikki-fleet',
	backups: ROOT + '/etc/nikki-fleet/backups',
	pending: ROOT + '/etc/nikki-fleet/pending.json',
	init: ROOT + '/etc/init.d/nikki',
	tmp: ROOT + '/tmp',
	logs: [ROOT + '/var/log/nikki', ROOT + '/tmp/log/nikki'],
	uci_conf: ROOT ? ROOT + '/etc/config' : null,
};

const MIHOMO = getenv('NF_MIHOMO') ?? 'mihomo';
const MAX_CONFIG = 4 * 1024 * 1024;
const BACKUPS_KEEP = 10;

/* ---------- helpers ---------- */

export function q(s) {
	return "'" + replace(`${s}`, "'", "'\\''") + "'";
};

export function sh(cmd) {
	const p = popen(cmd + ' 2>&1', 'r');
	if (!p)
		return { code: -1, out: '' };
	const out = p.read('all') ?? '';
	const code = p.close();
	return { code: code ?? 0, out: out };
};

function tail(s, n) {
	s = `${s ?? ''}`;
	return length(s) > n ? substr(s, length(s) - n) : s;
}

export function uid() {
	return trim(readfile('/proc/sys/kernel/random/uuid') ?? sprintf('%d', time()));
};

export function tmpname(tag) {
	mkdir(P.tmp);
	return sprintf('%s/nikki-fleet-%s-%s', P.tmp, tag, uid());
};

function uci_cmd() {
	return P.uci_conf ? 'uci -q -c ' + q(P.uci_conf) : 'uci -q';
}

export function uci_get(key) {
	const r = sh(uci_cmd() + ' get ' + q(key));
	return r.code == 0 ? trim(r.out) : null;
};

export function uci_set(key, val) {
	return sh(uci_cmd() + ' set ' + q(key + '=' + val)).code == 0;
};

export function uci_commit(pkg) {
	return sh(uci_cmd() + ' commit ' + q(pkg)).code == 0;
};

export function yaml_to_json(path) {
	const r = sh('yq -M -p yaml -o json ' + q(path));
	if (r.code != 0)
		return null;
	try { return json(r.out); } catch (e) { return null; }
};

function ts() {
	const t = localtime(time());
	return sprintf('%04d%02d%02d-%02d%02d%02d', t.year, t.mon, t.mday, t.hour, t.min, t.sec);
}

/* ---------- profiles ---------- */

const RE_FILE = /^[A-Za-z0-9_.@-]+\.ya?ml$/;
const RE_SECTION = /^[A-Za-z0-9_]+$/;

export function resolve(kind, name) {
	name = `${name ?? ''}`;
	if (kind == 'file' && match(name, RE_FILE))
		return P.profiles + '/' + name;
	if (kind == 'subscription' && match(name, RE_SECTION))
		return P.subs + '/' + name + '.yaml';
	return null;
};

export function active_profile() {
	const v = uci_get('nikki.config.profile') ?? '';
	const i = index(v, ':');
	if (i < 0)
		return { kind: '', name: '' };
	const kind = substr(v, 0, i), name = substr(v, i + 1);
	return { kind: kind, name: name, path: resolve(kind, name) };
};

export function list_profiles() {
	const act = active_profile(), out = [];
	for (let f in (lsdir(P.profiles) ?? [])) {
		if (!match(f, RE_FILE))
			continue;
		const st = stat(P.profiles + '/' + f);
		push(out, { kind: 'file', name: f, label: f, size: st?.size, mtime: st?.mtime,
			active: act.kind == 'file' && act.name == f });
	}
	for (let f in (lsdir(P.subs) ?? [])) {
		const m = match(f, /^([A-Za-z0-9_]+)\.ya?ml$/);
		if (!m)
			continue;
		const st = stat(P.subs + '/' + f);
		push(out, { kind: 'subscription', name: m[1], label: uci_get('nikki.' + m[1] + '.name') ?? m[1],
			size: st?.size, mtime: st?.mtime, active: act.kind == 'subscription' && act.name == m[1] });
	}
	return out;
};

export function read_profile(kind, name) {
	const path = resolve(kind, name);
	if (!path)
		return { ok: false, error: 'invalid profile name' };
	const content = readfile(path);
	if (content == null)
		return { ok: false, error: 'profile not found' };
	return { ok: true, kind: kind, name: name, content: content };
};

export function test_config(content) {
	if (type(content) != 'string' || !length(content))
		return { ok: false, output: 'empty config' };
	if (length(content) > MAX_CONFIG)
		return { ok: false, output: 'config is too large' };
	const f = tmpname('test') + '.yaml';
	writefile(f, content);
	mkdir(P.run);
	const r = sh(MIHOMO + ' -d ' + q(P.run) + ' -f ' + q(f) + ' -t');
	unlink(f);
	return { ok: r.code == 0, output: tail(r.out, 4000) };
};

/* ---------- backups ---------- */

function backup_prefix(kind, name) {
	return (kind == 'file' ? 'file_' : 'sub_') + replace(name, /[^A-Za-z0-9_.@-]/g, '_') + '__';
}

export function backup(kind, name) {
	const path = resolve(kind, name);
	const content = path ? readfile(path) : null;
	if (content == null)
		return null;
	mkdir(P.state);
	mkdir(P.backups);
	const pre = backup_prefix(kind, name);
	const id = pre + ts() + '.yaml';
	writefile(P.backups + '/' + id, content);
	const all = sort(filter(lsdir(P.backups) ?? [], f => index(f, pre) == 0));
	while (length(all) > BACKUPS_KEEP)
		unlink(P.backups + '/' + shift(all));
	return id;
};

export function list_backups(kind, name) {
	const pre = backup_prefix(kind, name), out = [];
	for (let f in reverse(sort(filter(lsdir(P.backups) ?? [], f => index(f, pre) == 0)))) {
		const st = stat(P.backups + '/' + f);
		push(out, { id: f, size: st?.size, mtime: st?.mtime });
	}
	return out;
};

/* ---------- mihomo API ---------- */

// Top-level scalar keys are read straight from the YAML text: it needs no
// extra process and works even when yq prints something that is not JSON.
function yaml_top_scalars(text, keys) {
	const out = {};
	for (let line in split(text ?? '', '\n')) {
		const m = match(line, /^([A-Za-z0-9_-]+):[ \t]*(.*)$/);
		if (!m || !(m[1] in keys))
			continue;
		let v = trim(m[2]);
		let qm = match(v, /^"((\\.|[^"\\])*)"/) ?? match(v, /^'([^']*)'/);
		if (qm)
			v = qm[1];
		else
			v = trim(replace(v, /[ \t]+#.*$/, ''));
		if (v != '' && v != '~' && v != 'null')
			out[m[1]] = v;
	}
	return out;
}

function controller_parse() {
	const keys = [ 'external-controller', 'external-controller-tls', 'secret' ];
	let cfg = yaml_top_scalars(readfile(P.runcfg), keys);
	if (!cfg['external-controller'] && !cfg['external-controller-tls'])
		cfg = yaml_to_json(P.runcfg) ?? {};
	if (type(cfg) != 'object')
		return null;
	let listen = cfg['external-controller-tls'] ?? cfg['external-controller'];
	if (!listen)
		return null;
	const tls = !!cfg['external-controller-tls'];
	listen = `${listen}`;
	let m = match(listen, /^\[?([^]]*)\]?:([0-9]+)$/);
	if (!m)
		return null;
	let host = m[1];
	if (host == '' || host == '0.0.0.0' || host == '::')
		host = '127.0.0.1';
	if (index(host, ':') >= 0)
		host = '[' + host + ']';
	return { url: (tls ? 'https://' : 'http://') + host + ':' + m[2], secret: cfg.secret ? `${cfg.secret}` : '' };
}

// Parsing the running config with yq costs a process and RAM, so the result is
// cached until the file changes (status() calls the API several times).
let ctl_cache = null;

function controller() {
	const st = stat(P.runcfg);
	const key = st ? sprintf('%d:%d', st.mtime, st.size) : '';
	if (ctl_cache && ctl_cache.key == key)
		return ctl_cache.value;
	const value = controller_parse();
	ctl_cache = { key: key, value: value };
	return value;
}

const API_METHODS = { GET: true, PUT: true, PATCH: true, POST: true, DELETE: true };

export function api(method, path, body, timeout) {
	method = uc(`${method ?? 'GET'}`);
	if (!API_METHODS[method])
		return { ok: false, code: 0, error: 'method not allowed' };
	path = `${path ?? ''}`;
	if (!match(path, /^\/[A-Za-z0-9_\/.%?=&:,+~-]*$/))
		return { ok: false, code: 0, error: 'invalid path' };
	const c = controller();
	if (!c)
		return { ok: false, code: 0, error: 'external-controller is not set in the running config' };

	let cmd = 'curl -sS -k -X ' + method + ' --max-time ' + int(timeout ?? 15) + " -w '\\n%{http_code}'";
	if (c.secret)
		cmd += ' -H ' + q('Authorization: Bearer ' + c.secret);
	let bodyfile = null;
	if (body != null) {
		bodyfile = tmpname('body');
		writefile(bodyfile, type(body) == 'string' ? body : sprintf('%J', body));
		cmd += " -H 'Content-Type: application/json' --data-binary @" + q(bodyfile);
	}
	const r = sh(cmd + ' ' + q(c.url + path));
	if (bodyfile)
		unlink(bodyfile);
	// ucode 24.10: rindex() returns -1 for a match at index 0 (empty body), hence the prefix
	const o = '.' + r.out, nl = rindex(o, '\n');
	const code = nl > 0 ? int(substr(o, nl + 1)) : 0;
	const text = nl > 0 ? substr(o, 1, nl - 1) : r.out;
	let data = null;
	if (length(text))
		try { data = json(text); } catch (e) { data = { raw: tail(text, 2000) }; }
	return { ok: code >= 200 && code < 300, code: code, data: data };
};

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
export const UPDATE_LOG = ROOT + '/tmp/nikki-fleet-update.log';

export function logs_tail(which, lines) {
	lines = clamp(int(lines ?? 100), 1, 1000);
	if (which == 'update') {
		if (!stat(UPDATE_LOG))
			return { ok: false, content: '' };
		return { ok: true, content: sh('tail -n ' + lines + ' ' + q(UPDATE_LOG)).out, running: update_running() };
	}
	const file = (which == 'app' ? 'app' : 'core') + '.log';
	for (let d in P.logs) {
		if (stat(d + '/' + file)) {
			const r = sh('tail -n ' + lines + ' ' + q(d + '/' + file));
			return { ok: true, content: r.out };
		}
	}
	return { ok: false, content: '' };
};

/* ---------- nikki service ---------- */

export function reload_nikki() {
	return sh(q(P.init) + ' reload');
};

export function nikki_running() {
	return sh('pidof ' + q(replace(MIHOMO, /.*\//, ''))).code == 0;
};

export function wait_api(seconds) {
	const until = time() + seconds;
	while (time() <= until) {
		const r = api('GET', '/version', null, 3);
		if (r.ok)
			return true;
		sleep(1000);
	}
	return false;
};

// Write a profile safely: test -> backup -> write -> (activate) -> reload -> check -> rollback on failure.
export function write_profile(opts) {
	const kind = opts.kind ?? 'file', name = opts.name, content = opts.content;
	const path = resolve(kind, name);
	if (!path)
		return { ok: false, stage: 'validate', error: 'invalid profile name' };
	if (type(content) != 'string' || !length(content))
		return { ok: false, stage: 'validate', error: 'empty config' };
	if (length(content) > MAX_CONFIG)
		return { ok: false, stage: 'validate', error: 'config is too large' };

	if (opts.test !== false) {
		const t = test_config(content);
		if (!t.ok)
			return { ok: false, stage: 'test', error: 'mihomo rejected the config', output: t.output };
	}

	const bk = backup(kind, name);
	mkdir(kind == 'file' ? P.profiles : P.subs);
	const tmp = path + '.nf-new';
	if (!writefile(tmp, content) || !rename(tmp, path))
		return { ok: false, stage: 'write', error: 'cannot write profile' };

	const act = active_profile();
	let activated = false;
	if (opts.activate && !(act.kind == kind && act.name == name)) {
		uci_set('nikki.config.profile', kind + ':' + name);
		uci_commit('nikki');
		activated = true;
	}
	const is_active = activated || (act.kind == kind && act.name == name);

	if (!opts.reload || !is_active)
		return { ok: true, stage: 'written', backup: bk, activated: activated, reloaded: false };

	// A freshly installed Nikki is disabled. Making a profile active turns it
	// on; plain edits of a disabled Nikki are saved without starting it.
	let turned_on = false;
	if (uci_get('nikki.config.enabled') != '1') {
		if (!(opts.enable ?? opts.activate))
			return { ok: true, stage: 'written', backup: bk, activated: activated, reloaded: false, nikki_disabled: true };
		uci_set('nikki.config.enabled', '1');
		uci_commit('nikki');
		turned_on = true;
	}

	reload_nikki();
	if (wait_api(opts.wait ?? 25))
		return { ok: true, stage: 'reloaded', backup: bk, activated: activated, reloaded: true, enabled: turned_on };

	// rollback
	if (bk)
		writefile(path, readfile(P.backups + '/' + bk));
	else if (activated)
		unlink(path);
	if (activated && act.kind) {
		uci_set('nikki.config.profile', act.kind + ':' + act.name);
		uci_commit('nikki');
	}
	if (turned_on) {
		uci_set('nikki.config.enabled', '0');
		uci_commit('nikki');
	}
	const log = logs_tail('core', 30).content;
	reload_nikki();
	const back = turned_on ? true : wait_api(opts.wait ?? 25);
	return { ok: false, stage: 'reload', error: 'mihomo did not start with the new config, previous version restored',
		rolled_back: true, recovered: back, backup: bk, log: log };
};

// Turn Nikki on (with a health check; turned back off if mihomo does not start) or off.
export function set_enabled(on) {
	if (!on) {
		uci_set('nikki.config.enabled', '0');
		uci_commit('nikki');
		sh(q(P.init) + ' stop');
		return { ok: true, enabled: false };
	}
	const act = active_profile();
	if (!act.kind || !act.path || !stat(act.path))
		return { ok: false, error: 'no active profile: save a profile first' };
	uci_set('nikki.config.enabled', '1');
	uci_commit('nikki');
	reload_nikki();
	if (wait_api(25))
		return { ok: true, enabled: true };
	const log = logs_tail('core', 30).content;
	uci_set('nikki.config.enabled', '0');
	uci_commit('nikki');
	sh(q(P.init) + ' stop');
	return { ok: false, error: 'mihomo did not start, Nikki turned off again', log: log };
};

export function restore_backup(kind, name, id, reload) {
	const pre = backup_prefix(kind, name);
	if (type(id) != 'string' || index(id, pre) != 0 || match(id, /[\/]/))
		return { ok: false, error: 'invalid backup id' };
	const content = readfile(P.backups + '/' + id);
	if (content == null)
		return { ok: false, error: 'backup not found' };
	return write_profile({ kind: kind, name: name, content: content, reload: reload, test: false });
};

export function update_subscription(section) {
	if (!match(`${section}`, RE_SECTION))
		return { ok: false, error: 'invalid section' };
	const r = sh(q(P.init) + ' update_subscription ' + q(section));
	return { ok: r.code == 0, output: tail(r.out, 2000) };
};



/* ---------- self-update ---------- */

const UPDATE_PID = ROOT + '/tmp/nikki-fleet-update.pid';

function update_running() {
	const pid = trim(readfile(UPDATE_PID) ?? '');
	return pid != '' && stat('/proc/' + pid) != null;
}

// Runs the panel's installer in the background: it fetches the latest
// nikki-fleet packages (from GitHub or through the panel) and upgrades them.
// The upgrade restarts the agent, so the command only starts the job and
// returns; progress is in logs.tail which=update.
export function self_update(server, insecure) {
	server = rtrim(`${server ?? ''}`, '/');
	if (!match(server, /^https?:\/\/[^]\/ '"`$\\[]+(\/[A-Za-z0-9._~\/-]*)?$/) && !match(server, /^https?:\/\/\[[0-9a-fA-F:]+\](:[0-9]+)?$/))
		return { ok: false, error: 'invalid panel URL' };
	if (update_running())
		return { ok: true, started: false, running: true, message: 'update is already running' };
	const k = insecure ? ' -k' : '', nk = insecure ? ' --no-check-certificate' : '';
	const script = ROOT + '/tmp/nikki-fleet-update.sh';
	writefile(script, `#!/bin/sh
echo "$$" > ${q(UPDATE_PID)}
echo "== nikki-fleet update $(date)"
url=${q(server + '/install.sh')}
if command -v curl >/dev/null 2>&1; then curl -fsSL${k} --connect-timeout 15 "$url"; else wget -q${nk} -T 30 -O- "$url"; fi > /tmp/nikki-fleet-install.sh || { echo "ERROR: cannot download $url"; rm -f ${q(UPDATE_PID)}; exit 1; }
NIKKI=0 sh /tmp/nikki-fleet-install.sh
rc=$?
rm -f /tmp/nikki-fleet-install.sh ${q(UPDATE_PID)}
echo "== done (exit $rc) $(date)"
`);
	// detach: own session if possible, output to the log, no inherited pipe
	const r = sh('S=; command -v setsid >/dev/null 2>&1 && S=setsid; ( $S sh ' + q(script) + ' </dev/null >' + q(UPDATE_LOG) + ' 2>&1 & )');
	return { ok: r.code == 0, started: r.code == 0, from_version: VERSION };
};

/* ---------- proxy groups ---------- */

// Compact view of /proxies for the panel's group manager: groups in config
// order (as listed in GLOBAL) and every proxy's type, UDP flag and last delay.
export function proxies() {
	const r = api('GET', '/proxies', null, 15);
	if (!r.ok)
		return { ok: false, error: r.error ?? ('mihomo API: HTTP ' + r.code) };
	const px = r.data?.proxies ?? {};
	const order = {};
	let i = 0;
	for (let n in (px.GLOBAL?.all ?? []))
		order[n] = i++;
	const nodes = {}, groups = [];
	for (let n, p in px) {
		const h = p.history;
		nodes[n] = { t: p.type, u: !!p.udp, d: type(h) == 'array' && length(h) ? h[length(h) - 1]?.delay : null,
			a: p.alive };
		if (type(p.all) == 'array' && n != 'GLOBAL')
			push(groups, { name: n, type: p.type, now: p.now ?? '', fixed: p.fixed ?? '', all: p.all,
				hidden: !!p.hidden, icon: p.icon ?? '', test_url: p.testUrl ?? '' });
	}
	sort(groups, (a, b) => (order[a.name] ?? 100000) - (order[b.name] ?? 100000));
	const providers = [];
	const pp = api('GET', '/providers/proxies', null, 15);
	for (let n, p in (pp.data?.providers ?? {})) {
		if (p.vehicleType == 'Compatible')
			continue;
		const names = [];
		for (let x in (p.proxies ?? [])) {
			push(names, x.name);
			if (!exists(nodes, x.name)) {
				const h = x.history;
				nodes[x.name] = { t: x.type, u: !!x.udp, d: type(h) == 'array' && length(h) ? h[length(h) - 1]?.delay : null, a: x.alive };
			}
		}
		push(providers, { name: n, vehicle: p.vehicleType, updated: p.updatedAt, sub: p.subscriptionInfo,
			test_url: p.testUrl ?? '', proxies: names });
	}
	const cf = api('GET', '/configs', null, 5);
	return { ok: true, mode: cf.data?.mode ?? '', groups: groups, nodes: nodes, providers: providers };
};

/* ---------- live traffic ---------- */

// DHCP leases → { ip: hostname } so the panel can show device names.
function leases() {
	const out = {};
	for (let line in split(readfile(ROOT + '/tmp/dhcp.leases') ?? '', '\n')) {
		const f = split(line, ' ');
		if (length(f) >= 4 && f[3] != '*' && f[3] != '')
			out[f[2]] = f[3];
	}
	for (let line in split(readfile(ROOT + '/tmp/hosts/odhcpd') ?? '', '\n')) {
		const m = match(line, /^([0-9a-fA-F:.]+)[ \t]+([^ \t]+)/);
		if (m && !exists(out, m[1]))
			out[m[1]] = m[2];
	}
	return out;
}

// Compact snapshot of mihomo connections: the busiest `limit` connections with
// only the fields the panel shows, plus totals. Keeps router → panel traffic small.
export function traffic(limit) {
	limit = int(limit ?? 300);
	if (limit < 1 || limit > 1000)
		limit = 300;
	const r = api('GET', '/connections', null, 8);
	if (!r.ok)
		return { ok: false, error: r.error ?? ('mihomo API: HTTP ' + r.code) };
	const all = r.data?.connections ?? [];
	sort(all, (a, b) => ((b.upload ?? 0) + (b.download ?? 0)) - ((a.upload ?? 0) + (a.download ?? 0)));
	const conns = [];
	for (let c in all) {
		if (length(conns) >= limit)
			break;
		const m = c.metadata ?? {};
		push(conns, {
			id: c.id,
			host: m.host || m.sniffHost || '',
			dst: m.destinationIP ?? '',
			port: m.destinationPort ?? '',
			src: m.sourceIP ?? '',
			net: m.network ?? '',
			type: m.type ?? '',
			proc: m.process ?? '',
			rule: c.rule ?? '',
			payload: c.rulePayload ?? '',
			chain: c.chains ?? [],
			up: c.upload ?? 0,
			down: c.download ?? 0,
			start: c.start ?? '',
		});
	}
	return { ok: true, time: time(), up_total: r.data?.uploadTotal ?? 0, down_total: r.data?.downloadTotal ?? 0,
		memory: r.data?.memory ?? null, count: length(all), conns: conns, leases: leases() };
};

/* ---------- status ---------- */

function pkg_version(name) {
	let r = sh('command -v opkg >/dev/null && opkg list-installed ' + q(name));
	if (r.code == 0) {
		const m = match(r.out, /^[^ ]+ - ([^ \n]+)/);
		return m ? m[1] : null;
	}
	r = sh('command -v apk >/dev/null && apk list -I ' + q(name));
	if (r.code == 0) {
		const m = match(r.out, regexp('^' + replace(name, /[.+-]/g, '\\$&') + '-([^ \n]+)'));
		return m ? m[1] : null;
	}
	return null;
}

function meminfo() {
	const t = readfile('/proc/meminfo') ?? '';
	const g = k => { const m = match(t, regexp(k + ':[ \t]+([0-9]+)')); return m ? int(m[1]) * 1024 : null; };
	return { total: g('MemTotal'), available: g('MemAvailable') };
}

function board() {
	const r = sh('ubus call system board');
	if (r.code == 0) {
		try {
			const b = json(r.out);
			return { model: b.model, release: b.release?.version, target: b.release?.target, kernel: b.kernel };
		} catch (e) {}
	}
	const rel = readfile(ROOT + '/etc/openwrt_release') ?? '';
	const g = k => { const m = match(rel, regexp(k + "='([^']*)'")); return m ? m[1] : null; };
	return { model: null, release: g('DISTRIB_RELEASE'), target: g('DISTRIB_TARGET'), kernel: null };
}

export function status(full) {
	const up = split(readfile('/proc/uptime') ?? '0', ' ');
	const la = split(readfile('/proc/loadavg') ?? '', ' ');
	const out = {
		fleet_version: VERSION,
		hostname: trim(readfile('/proc/sys/kernel/hostname') ?? ''),
		board: board(),
		uptime: int(up[0]),
		load: [ +la[0], +la[1], +la[2] ],
		memory: meminfo(),
		nikki: {
			enabled: uci_get('nikki.config.enabled') == '1',
			running: nikki_running(),
			profile: active_profile(),
			version: pkg_version('nikki'),
			luci_version: pkg_version('luci-app-nikki'),
		},
		time: time(),
	};
	if (type(out.nikki.profile) == 'object')
		delete out.nikki.profile.path;
	const v = api('GET', '/version', null, 3);
	out.mihomo = v.ok ? { reachable: true, version: v.data?.version } : { reachable: false, error: v.error ?? ('HTTP ' + v.code) };
	if (!full || !v.ok)
		return out;
	try {
		status_details(out);
	} catch (e) {
		out.status_error = `${e}`;
	}
	return out;
};

function status_details(out) {

	const pp = api('GET', '/providers/proxies', null, 8);
	out.providers = [];
	for (let n, p in (pp.data?.providers ?? {})) {
		if (p.vehicleType == 'Compatible')
			continue;
		let alive = 0;
		for (let x in (p.proxies ?? []))
			if (x.alive) alive++;
		push(out.providers, { name: n, count: length(p.proxies ?? []), alive: alive,
			updated: p.updatedAt, sub: p.subscriptionInfo });
	}
	const px = api('GET', '/proxies', null, 8);
	out.groups = [];
	for (let n, g in (px.data?.proxies ?? {})) {
		if (!(g.type in [ 'Selector', 'URLTest', 'Fallback', 'LoadBalance', 'Relay' ]) || n == 'GLOBAL')
			continue;
		const h = g.now != null ? px.data.proxies[g.now]?.history : null;
		push(out.groups, { name: n, type: g.type, now: g.now, delay: type(h) == 'array' && length(h) ? h[length(h) - 1]?.delay : null });
	}
	const cn = api('GET', '/connections', null, 5);
	if (cn.ok)
		out.traffic = { up: cn.data?.uploadTotal, down: cn.data?.downloadTotal, connections: length(cn.data?.connections ?? []) };
}
