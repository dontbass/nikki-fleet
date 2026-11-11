'use strict';
'require view';
'require rpc';

// SPDX-License-Identifier: GPL-3.0-or-later
// Hosts the shared nikki-fleet configurator in an iframe and gives it access
// to the router through the luci.nikki-fleet rpcd object (window.NF_HOST).

const callProfiles = rpc.declare({ object: 'luci.nikki-fleet', method: 'profiles' });
const callRead = rpc.declare({ object: 'luci.nikki-fleet', method: 'read', params: [ 'kind', 'name' ] });
const callWrite = rpc.declare({ object: 'luci.nikki-fleet', method: 'write', params: [ 'kind', 'name', 'content', 'activate', 'reload' ] });
const callApi = rpc.declare({ object: 'luci.nikki-fleet', method: 'api', params: [ 'method', 'path', 'body' ] });


// The router's LuCI theme (Bootstrap, Argon, Material, OpenWrt2020, 404-Mode…):
// render a few standard LuCI elements off-screen inside the view and read their
// computed styles, so the configurator can take over the theme's colors, font and
// corner radius instead of keeping its own look.
function isColor(c) {
	var m = String(c || '').match(/rgba?\(([^)]+)\)/);
	if (!m) return false;
	var v = m[1].split(/[ ,\/]+/).filter(Boolean);
	return v.length < 4 || parseFloat(v[3]) > 0.05;
}

function saturation(c) {
	var m = String(c || '').match(/rgba?\(([^)]+)\)/);
	if (!m) return 0;
	var v = m[1].split(/[ ,\/]+/).filter(Boolean).map(Number);
	var mx = Math.max(v[0], v[1], v[2]), mn = Math.min(v[0], v[1], v[2]);
	return mx ? (mx - mn) / mx : 0;
}

// first opaque background from el up to <html>
function bgOf(el) {
	for (; el && el.nodeType === 1; el = el.parentElement) {
		var b = getComputedStyle(el).backgroundColor;
		if (isColor(b)) return b;
	}
	return null;
}

function sampleTheme(host) {
	var probe = E('div', { 'style': 'position:absolute;left:-9999px;top:0;width:600px;visibility:hidden;pointer-events:none', 'aria-hidden': 'true' }, [
		E('div', { 'class': 'cbi-map' }, [
			E('div', { 'class': 'cbi-section' }, [
				E('p', { 'class': 'p-text' }, 'x'),
				E('div', { 'class': 'cbi-section-descr' }, 'x'),
				E('div', { 'class': 'cbi-value' }, [
					E('div', { 'class': 'cbi-value-field' }, [
						E('input', { 'class': 'cbi-input-text', 'type': 'text' }),
						E('div', { 'class': 'cbi-value-description' }, 'x')
					])
				]),
				E('button', { 'class': 'btn primary' }, 'x'),
				E('button', { 'class': 'btn cbi-button cbi-button-save' }, 'x'),
				E('button', { 'class': 'btn cbi-button cbi-button-apply' }, 'x'),
				E('button', { 'class': 'btn cbi-button cbi-button-action' }, 'x'),
				E('button', { 'class': 'btn cbi-button cbi-button-positive' }, 'x'),
				E('button', { 'class': 'btn cbi-button' }, 'x'),
				E('a', { 'href': '#' }, 'x')
			])
		])
	]);
	(host.isConnected ? host : document.body).appendChild(probe);
	try {
		var q = function (s) { return probe.querySelector(s); };
		var cs = function (s) { return getComputedStyle(q(s)); };
		var sec = q('.cbi-section'), text = cs('.p-text'), input = cs('.cbi-input-text'), plain = cs('.cbi-button:not(.cbi-button-save):not(.cbi-button-apply):not(.cbi-button-action):not(.cbi-button-positive):not(.primary)');
		var panel = bgOf(sec) || bgOf(document.body) || 'rgb(255, 255, 255)';
		var t = {
			panel: panel,
			fg: text.color,
			muted: cs('.cbi-value-description').color,
			line: isColor(input.borderTopColor) && parseFloat(input.borderTopWidth) > 0 ? input.borderTopColor : null,
			input: isColor(input.backgroundColor) ? input.backgroundColor : null,
			font: getComputedStyle(document.body).fontFamily,
			radius: parseFloat(plain.borderTopLeftRadius) || parseFloat(input.borderTopLeftRadius) || 0
		};
		if (t.muted === t.fg) t.muted = cs('.cbi-section-descr').color;
		if (t.muted === t.fg) t.muted = null;
		// accent: the theme's own primary color variable (Argon --primary, Material
		// --main-color, Bootstrap --primary-color-high…), else the first colored
		// primary button (background, then border, then text), else the link color
		var vars = [ '--primary', '--main-color', '--primary-color-high', '--primary-color', '--accent-color', '--accent', '--theme-color' ];
		var vp = q('.p-text');
		for (var j = 0; j < vars.length && !t.accent; j++) {
			vp.style.color = '';
			vp.style.color = 'var(' + vars[j] + ', rgba(0, 0, 0, 0))';
			var vc = getComputedStyle(vp).color;
			if (isColor(vc) && saturation(vc) > 0.25) t.accent = vc;
		}
		vp.style.color = '';
		var sels = [ '.btn.primary', '.cbi-button-apply', '.cbi-button-action', '.cbi-button-save', '.cbi-button-positive' ];
		for (var i = 0; i < sels.length; i++) {
			var b = cs(sels[i]);
			if (isColor(b.backgroundColor) && saturation(b.backgroundColor) > 0.25) {
				if (!t.accent || t.accent === b.backgroundColor) { t.accent = b.backgroundColor; t.accentInk = b.color; }
				break;
			}
			if (t.accent) continue;
			if (isColor(b.borderTopColor) && saturation(b.borderTopColor) > 0.3) { t.accent = b.borderTopColor; break; }
			if (saturation(b.color) > 0.3) { t.accent = b.color; break; }
		}
		if (!t.accent && saturation(cs('a').color) > 0.25) t.accent = cs('a').color;
		// a font the theme did not set is the browser default (Times): keep ours
		if (/^"?times/i.test(t.font || '')) t.font = null;
		return t;
	} finally {
		probe.remove();
	}
}

// re-sample when the theme switches between light and dark (system setting or
// a theme's own toggle that changes classes/attributes on <html>/<body>)
function watchTheme(cb) {
	var timer = null, fire = function () { clearTimeout(timer); timer = setTimeout(cb, 120); };
	try { window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', fire); } catch (e) {}
	try {
		var mo = new MutationObserver(fire);
		mo.observe(document.documentElement, { attributes: true, attributeFilter: [ 'class', 'style', 'data-theme', 'data-bs-theme', 'data-darkmode' ] });
		mo.observe(document.body, { attributes: true, attributeFilter: [ 'class', 'style', 'data-theme', 'data-darkmode' ] });
	} catch (e) {}
}

return view.extend({
	render: function () {
		// saving restarts Nikki and waits for mihomo; allow it more time than the default
		if ((L.env.rpctimeout || 20) < 90)
			L.env.rpctimeout = 90;

		var holder = E('div', { 'class': 'nikki-fleet-configurator' });

		window.NF_HOST = {
			kind: 'luci',
			title: '',
			canWrite: true,
			listProfiles: function () {
				return callProfiles();
			},
			readProfile: function (kind, name) {
				return callRead(kind, name).then(function (r) {
					if (!r || !r.ok)
						throw new Error((r && r.error) || _('Cannot read profile'));
					return r.content;
				});
			},
			writeProfile: function (kind, name, content, opts) {
				return callWrite(kind, name, content, !!(opts && opts.activate), !(opts && opts.reload === false));
			},
			api: function (method, path, body) {
				return callApi(method, path, body == null ? '' : JSON.stringify(body));
			},
			theme: function () {
				return sampleTheme(holder);
			},
			onTheme: function (cb) {
				watchTheme(cb);
			}
		};

		holder.appendChild(E('iframe', {
			src: L.resource('nikki-fleet/configurator.html'),
			title: _('Configurator'),
			style: 'width:100%;height:calc(100vh - 170px);min-height:620px;border:0;display:block;background:transparent',
			allowtransparency: 'true'
		}));
		return holder;
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
