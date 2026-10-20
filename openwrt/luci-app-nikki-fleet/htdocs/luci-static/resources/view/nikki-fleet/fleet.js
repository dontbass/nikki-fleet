'use strict';
'require view';
'require rpc';
'require ui';

// SPDX-License-Identifier: GPL-3.0-or-later
// Connect this router to a nikki-fleet panel (remote management).

const callStatus = rpc.declare({ object: 'luci.nikki-fleet', method: 'agent_status' });
const callEnroll = rpc.declare({ object: 'luci.nikki-fleet', method: 'agent_enroll', params: [ 'server', 'code', 'insecure' ] });
const callUnenroll = rpc.declare({ object: 'luci.nikki-fleet', method: 'agent_unenroll' });

return view.extend({
	load: function () {
		return L.resolveDefault(callStatus(), {});
	},

	render: function (st) {
		const status = st.enrolled
			? E('p', {}, [
				E('strong', { style: 'color:' + (st.running ? '#2d7a4b' : '#a4471c') }, st.running ? _('Connected') : _('Agent is not running')),
				' · ', _('Panel'), ': ', E('code', {}, st.server),
				' · ', _('Router ID'), ': ', E('code', {}, st.router_id)
			])
			: E('p', {}, _('This router is not connected to a panel.'));

		const server = E('input', { 'class': 'cbi-input-text', type: 'text', placeholder: 'https://fleet.example.com', style: 'width:100%;max-width:420px' });
		const code = E('input', { 'class': 'cbi-input-text', type: 'text', placeholder: 'ABCD-EFGH', style: 'width:100%;max-width:200px;text-transform:uppercase' });
		const insecure = E('input', { type: 'checkbox' });

		const enroll = function () {
			return callEnroll(server.value.trim(), code.value.trim(), insecure.checked).then(function (r) {
				if (r && r.ok) {
					ui.addNotification(null, E('p', _('Router connected to the panel')), 'info');
					window.setTimeout(function () { location.reload(); }, 1500);
				} else {
					ui.addNotification(null, E('pre', {}, (r && (r.output || r.error)) || _('Connection failed')), 'error');
				}
			});
		};
		const unenroll = function () {
			return callUnenroll().then(function () { location.reload(); });
		};

		return E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, _('Remote management')),
			E('div', { 'class': 'cbi-map-descr' }, _('nikki-fleet lets you see the status of this router and edit its Nikki profile from a web panel, from anywhere. The router connects to the panel itself, so no open ports or public IP are needed. Every change is checked with mihomo -t and rolled back automatically if mihomo does not start.')),
			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, _('Status')),
				status,
				st.enrolled ? E('button', { 'class': 'btn cbi-button cbi-button-negative', click: ui.createHandlerFn(this, unenroll) }, _('Disconnect from panel')) : ''
			]),
			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, st.enrolled ? _('Connect to another panel') : _('Connect to a panel')),
				E('p', {}, _('In the panel press "Connect router", then enter the panel address and the one-time code here.')),
				E('div', { 'class': 'cbi-value' }, [ E('label', { 'class': 'cbi-value-title' }, _('Panel address')), E('div', { 'class': 'cbi-value-field' }, server) ]),
				E('div', { 'class': 'cbi-value' }, [ E('label', { 'class': 'cbi-value-title' }, _('Code')), E('div', { 'class': 'cbi-value-field' }, code) ]),
				E('div', { 'class': 'cbi-value' }, [ E('label', { 'class': 'cbi-value-title' }, _('Self-signed certificate')), E('div', { 'class': 'cbi-value-field' }, [ insecure, ' ', _('do not verify TLS (testing only)') ]) ]),
				E('div', { 'class': 'cbi-page-actions' }, E('button', { 'class': 'btn cbi-button cbi-button-apply', click: ui.createHandlerFn(this, enroll) }, _('Connect')))
			])
		]);
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
