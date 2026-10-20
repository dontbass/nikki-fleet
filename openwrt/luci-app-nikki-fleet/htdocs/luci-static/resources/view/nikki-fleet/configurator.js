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

return view.extend({
	render: function () {
		// saving restarts Nikki and waits for mihomo; allow it more time than the default
		if ((L.env.rpctimeout || 20) < 90)
			L.env.rpctimeout = 90;

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
			}
		};

		return E('iframe', {
			src: L.resource('nikki-fleet/configurator.html'),
			title: _('Configurator'),
			style: 'width:100%;height:calc(100vh - 170px);min-height:620px;border:0;border-radius:8px;display:block'
		});
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
