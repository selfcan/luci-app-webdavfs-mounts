'use strict';
'require view';
'require form';
'require uci';
'require rpc';
'require fs';
'require ui';

var SERVICE_NAME = 'webdav-mounts';
var MAIN_BINARY = '/usr/sbin/mount.webdavfs';
var WEBDAVFS_MOUNT_OPTIONS_URL = 'https://github.com/miquels/webdavfs#mount-options';
var isReadonlyView = !L.hasViewPermission() || null;

function firstGlobalSection() {
	var sid = null;

	uci.sections('webdav-mounts', 'global', function(s) {
		if (sid == null)
			sid = s['.name'];
	});

	return sid;
}

function getConfigValue(section_id, option, legacy_option, fallback) {
	var value = uci.get('webdav-mounts', section_id, option);

	if (value != null)
		return value;

	if (legacy_option != null) {
		value = uci.get('webdav-mounts', section_id, legacy_option);
		if (value != null)
			return value;
	}

	return fallback;
}

function writeMigratedValue(section_id, option, legacy_option, value, keep_empty) {
	if (legacy_option != null)
		uci.unset('webdav-mounts', section_id, legacy_option);

	if (value == null || value === '') {
		if (keep_empty)
			uci.set('webdav-mounts', section_id, option, '');
		else
			uci.unset('webdav-mounts', section_id, option);
	}
	else {
		uci.set('webdav-mounts', section_id, option, value);
	}
}

function cleanBaseDir(path) {
	path = (path || '').replace(/\/+$/, '');
	return path || '/';
}

function joinMountDir(base, name) {
	if (!base)
		return '';

	if (!name)
		name = '<name>';

	return '%s/%s'.format(cleanBaseDir(base), name);
}

function updateDefaultMountDir(map, section_id, base, name) {
	var field = map.findElement('data-field', 'cbid.webdav-mounts.%s.mount_dir_mode'.format(section_id));
	var output = field ? field.querySelector('[data-role="default-mount-dir"]') : null;

	if (output == null) {
		field = map.findElement('data-field', 'cbid.webdav-mounts.%s._default_mount_dir'.format(section_id));
		output = field ? field.querySelector('output') : null;
	}

	if (output != null)
		output.textContent = base ? joinMountDir(base, name) : 'Unavailable';
}

function normalizePrefix(prefix) {
	prefix = (prefix || '').trim();

	if (prefix !== '' && prefix.charAt(0) !== '/')
		prefix = '/%s'.format(prefix);

	return prefix;
}

function buildWebdavUrl(use_https, host, port, prefix) {
	var proto = use_https ? 'https' : 'http';
	var defaultPort = use_https ? '443' : '80';
	var portPart;

	host = (host || '').trim();
	port = port || defaultPort;
	portPart = port === defaultPort ? '' : ':%s'.format(port);
	prefix = normalizePrefix(prefix);

	if (!host)
		return null;

	return '%s://%s%s%s'.format(proto, host, portPart, prefix);
}

function buildWebdavMountUrl(use_https, host, port, prefix) {
	var proto = use_https ? 'https' : 'http';
	var defaultPort = use_https ? '443' : '80';

	host = (host || '').trim();
	port = port || defaultPort;
	prefix = normalizePrefix(prefix);

	if (!host)
		return null;

	return '%s://%s:%s%s'.format(proto, host, port, prefix);
}

function webdavUrl(section_id) {
	var use_https = uci.get('webdav-mounts', section_id, 'use_https') === '1';
	var host = uci.get('webdav-mounts', section_id, 'host') || '';
	var defaultPort = use_https ? '443' : '80';
	var port = uci.get('webdav-mounts', section_id, 'port') || defaultPort;
	var prefix = normalizePrefix(uci.get('webdav-mounts', section_id, 'path_prefix'));

	return buildWebdavUrl(use_https, host, port, prefix);
}

function webdavMountUrl(section_id) {
	var use_https = uci.get('webdav-mounts', section_id, 'use_https') === '1';
	var host = uci.get('webdav-mounts', section_id, 'host') || '';
	var defaultPort = use_https ? '443' : '80';
	var port = uci.get('webdav-mounts', section_id, 'port') || defaultPort;
	var prefix = normalizePrefix(uci.get('webdav-mounts', section_id, 'path_prefix'));

	return buildWebdavMountUrl(use_https, host, port, prefix);
}

function cleanMountDir(path) {
	path = (path || '').trim().replace(/\/+$/, '');
	return path || '/';
}

function currentBaseMountDir() {
	var globalSection = firstGlobalSection();

	if (!globalSection)
		return '/mnt/openlist';

	return (getConfigValue(globalSection, 'base_mount_dir', 'base_mount_point', '/mnt/openlist') || '').trim();
}

function mountDirForEntry(section_id) {
	var mode = uci.get('webdav-mounts', section_id, 'mount_dir_mode') || 'default';
	var name = uci.get('webdav-mounts', section_id, 'name') || '';
	var base, mountDir;

	if (mode === 'custom')
		mountDir = uci.get('webdav-mounts', section_id, 'mount_dir') || '';
	else {
		base = currentBaseMountDir();
		mountDir = (base && name) ? joinMountDir(base, name) : '';
	}

	return mountDir ? cleanMountDir(mountDir) : '';
}

function entryLabel(section_id) {
	return uci.get('webdav-mounts', section_id, 'name') || section_id;
}

function assertUniqueMountDirs() {
	var seen = {};

	uci.sections('webdav-mounts', 'mount', function(s) {
		var section_id = s['.name'];
		var mountDir = mountDirForEntry(section_id);
		var key = mountDir ? cleanMountDir(mountDir) : '';

		if (!key)
			return;

		if (seen[key] != null)
			throw new Error('Mount Directory "%s" is already used by "%s" and "%s".'.format(key, seen[key], entryLabel(section_id)));

		seen[key] = entryLabel(section_id);
	});
}

function mountEntriesForSave(section_ids) {
	var filter = null;
	var entries = [];

	if (section_ids != null) {
		filter = {};
		for (var i = 0; i < section_ids.length; i++)
			filter[section_ids[i]] = true;
	}

	uci.sections('webdav-mounts', 'mount', function(s) {
		var section_id = s['.name'];
		var mountDir, mountUrl, displayUrl;

		if (filter != null && !filter[section_id])
			return;

		mountDir = mountDirForEntry(section_id);
		mountUrl = webdavMountUrl(section_id);
		displayUrl = webdavUrl(section_id);

		if (!mountDir || !mountUrl)
			return;

		entries.push({
			section_id: section_id,
			label: entryLabel(section_id),
			mountDir: mountDir,
			mountUrl: mountUrl,
			displayUrl: displayUrl
		});
	});

	return entries;
}

function prepareMountDir(entry) {
	return L.resolveDefault(fs.exec('/etc/init.d/webdav-mounts', [
		'prepare_dir',
		entry.mountDir,
		entry.mountUrl,
		entry.displayUrl
	]), { code: 1, stdout: '', stderr: 'Unable to prepare mount directory' }).then(function(res) {
		var detail;

		if (res.code === 0)
			return true;

		detail = shortenProbeText(res.stderr || res.stdout, '', '');
		throw new Error('Mount Directory "%s" for "%s" is not usable: %s'.format(entry.mountDir, entry.label, detail));
	});
}

function validateMountDirsBeforeSave(section_ids) {
	var entries, chain;

	assertUniqueMountDirs();
	entries = mountEntriesForSave(section_ids);
	chain = Promise.resolve();

	entries.forEach(function(entry) {
		chain = chain.then(function() {
			return prepareMountDir(entry);
		});
	});

	return chain;
}

function wrapMountDirSave(map, section_ids) {
	var save;

	if (map._webdavMountDirSaveWrapped)
		return;

	save = map.save;
	map.save = function(cb, silent) {
		var self = this;

		return save.call(this, function() {
			var args = arguments;

			return validateMountDirsBeforeSave(section_ids).then(function() {
				if (cb != null)
					return cb.apply(self, args);
			});
		}, silent);
	};

	map._webdavMountDirSaveWrapped = true;
}

function addMountOptionsHelp(option) {
	var renderFrame = option.renderFrame;

	option.renderFrame = function(section_id, in_table, option_index, nodes) {
		var frame = renderFrame.apply(this, arguments);
		var field;

		if (in_table || frame == null || frame.querySelector == null)
			return frame;

		field = frame.querySelector('.cbi-value-field');
		if (field != null) {
			field.appendChild(E('div', { 'class': 'cbi-value-description' }, [
				'Comma-separated mount.webdavfs -o options. See ',
				E('a', {
					'href': WEBDAVFS_MOUNT_OPTIONS_URL,
					'target': '_blank',
					'rel': 'noreferrer noopener'
				}, 'webdavfs mount options'),
				'.'
			]));
		}

		return frame;
	};
}

function setProbeStatus(node, state, label, description) {
	var badge = node.querySelector ? node.querySelector('[data-role="probe-badge"]') : null;
	var detail = node.querySelector ? node.querySelector('[data-role="probe-description"]') : null;
	var detailIcon = node.querySelector ? node.querySelector('[data-role="probe-description-icon"]') : null;
	var detailText = node.querySelector ? node.querySelector('[data-role="probe-description-text"]') : null;
	var refresh = node.querySelector ? node.querySelector('[data-role="probe-refresh"]') : null;
	var color = state === 'ok' ? '#128a2e' : state === 'fail' ? '#c62828' : '#666';
	var background = state === 'ok' ? '#e7f6ec' : state === 'fail' ? '#fdeaea' : '#f2f2f2';

	badge = badge || node;
	description = description || '';

	badge.textContent = label;
	badge.title = description ? '%s: %s'.format(label, description) : label;
	badge.style.display = 'inline-block';
	badge.style.minWidth = '5.5em';
	badge.style.textAlign = 'center';
	badge.style.borderRadius = '3px';
	badge.style.padding = '0.1em 0.45em';
	badge.style.fontWeight = '600';
	badge.style.color = color;
	badge.style.background = background;
	badge.style.border = '1px solid %s'.format(color);
	badge.style.whiteSpace = 'nowrap';

	if (detail != null) {
		if (detailIcon != null) {
			detailIcon.textContent = state === 'ok' ? 'i' : '!';
			detailIcon.style.background = state === 'ok' ? '#dbeafe' : '#f6c343';
			detailIcon.style.color = state === 'ok' ? '#1d4ed8' : '#5c3b00';
			detailIcon.style.border = state === 'ok' ? '1px solid #60a5fa' : 'none';
		}

		if (detailText != null)
			detailText.textContent = description;
		else
			detail.textContent = description;

		detail.title = description;
		detail.style.display = description ? 'flex' : 'none';
	}

	if (refresh != null)
		refresh.disabled = state === 'pending' ? true : null;
}

function createProbeStatusNode(onRefresh) {
	var children = [
		E('span', { 'data-role': 'probe-badge' }, [ 'Checking' ])
	];

	if (onRefresh != null) {
		children.push(E('button', {
			'type': 'button',
			'class': 'cbi-button',
			'title': 'Refresh status',
			'data-role': 'probe-refresh',
			'style': 'min-width:1.8em;padding:0 0.35em;line-height:1.4em',
			'click': onRefresh
		}, [ '\u21bb' ]));
	}

	return E('div', { 'style': 'min-width:9em' }, [
		E('div', { 'style': 'display:flex;align-items:center;gap:0.35em' }, children),
		E('div', {
			'data-role': 'probe-description',
			'style': 'display:none;margin-top:0.25em;max-width:34em;overflow-wrap:anywhere;white-space:normal;color:#666;gap:0.35em;align-items:flex-start'
		}, [
			E('span', {
				'data-role': 'probe-description-icon',
				'style': 'display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;width:1.1em;height:1.1em;margin-top:0.1em;border-radius:50%;background:#f6c343;color:#5c3b00;font-weight:700;line-height:1'
			}, [ '!' ]),
			E('span', { 'data-role': 'probe-description-text' })
		])
	]);
}

function shortenProbeText(value, username, password) {
	value = (value || '')
		.replace(/\r/g, '\n')
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();

	if (password)
		value = value.split(password).join('***');

	if (username)
		value = value.split('%s:%s'.format(username, password || '')).join('%s:***'.format(username));

	if (value.length > 180)
		value = '%s...'.format(value.substring(0, 177));

	return value;
}

function parseProbeOutput(stdout) {
	var output = stdout || '';
	var match = output.match(/\r?\n(\d{3})\s*$/);
	var httpCode = '';
	var payload = output;
	var blocks, statusLine = '', body = '';

	if (match != null) {
		httpCode = match[1];
		payload = output.substring(0, match.index);
	}
	else {
		payload = output.trim();
		if (/^\d{3}$/.test(payload)) {
			httpCode = payload;
			payload = '';
		}
	}

	blocks = payload.split(/\r?\n\r?\n/);
	for (var i = 0; i < blocks.length; i++) {
		if (/^HTTP\/[0-9.]+\s+\d{3}/.test(blocks[i]))
			statusLine = blocks[i].split(/\r?\n/)[0];
		else if (blocks[i].trim())
			body = body ? '%s\n%s'.format(body, blocks[i]) : blocks[i];
	}

	return {
		httpCode: httpCode,
		statusLine: statusLine,
		body: body
	};
}

function probeFailureDescription(res, parsed, username, password) {
	var stderr = shortenProbeText(res.stderr, username, password);
	var statusLine = shortenProbeText(parsed.statusLine, username, password);
	var body = shortenProbeText(parsed.body, username, password);
	var detail = '';

	if (statusLine && body)
		detail = '%s: %s'.format(statusLine, body);
	else
		detail = stderr || statusLine || body;

	if (!detail && parsed.httpCode && parsed.httpCode !== '000')
		detail = 'HTTP %s'.format(parsed.httpCode);

	if (!detail)
		detail = 'No response from server';

	return detail;
}

function probeWebdav(node, values) {
	var params, started;

	if (!values.url) {
		setProbeStatus(node, 'fail', 'Unavailable', 'URL is incomplete');
		return Promise.resolve(false);
	}

	if (values.requireCredential && !values.username) {
		setProbeStatus(node, 'fail', 'Unavailable', 'Username is required');
		return Promise.resolve(false);
	}

	params = [
		'-sS',
		'-i',
		'-w', '\n%{http_code}',
		'-X', 'PROPFIND',
		'-H', 'Depth: 0',
		'--connect-timeout', '3',
		'--max-time', '5',
		values.url
	];

	if (values.requireCredential)
		params.splice(2, 0, '-u', '%s:%s'.format(values.username, values.password));

	started = Date.now();
	return L.resolveDefault(fs.exec('/usr/bin/curl', params), { code: 1, stdout: '', stderr: '' }).then(function(res) {
		var parsed = parseProbeOutput(res.stdout);
		var elapsed = Date.now() - started;

		if (res.code === 0 && /^(2|3)\d\d$/.test(parsed.httpCode)) {
			setProbeStatus(node, 'ok', 'Available', 'Checked in %d ms'.format(elapsed));
			return true;
		}

		setProbeStatus(node, 'fail', 'Unavailable', probeFailureDescription(res, parsed, values.username, values.password));
		return false;
	});
}

function probeValuesFromUci(section_id) {
	return {
		url: webdavUrl(section_id),
		requireCredential: uci.get('webdav-mounts', section_id, 'require_credential') === '1',
		username: uci.get('webdav-mounts', section_id, 'username') || '',
		password: uci.get('webdav-mounts', section_id, 'password') || ''
	};
}

function probeValuesFromForm(section, section_id) {
	var use_https = section.formvalue(section_id, 'use_https') === '1';
	var host = section.formvalue(section_id, 'host') || '';
	var port = section.formvalue(section_id, 'port') || (use_https ? '443' : '80');
	var prefix = section.formvalue(section_id, 'path_prefix') || '';

	return {
		url: buildWebdavUrl(use_https, host, port, prefix),
		requireCredential: section.formvalue(section_id, 'require_credential') === '1',
		username: section.formvalue(section_id, 'username') || '',
		password: section.formvalue(section_id, 'password') || ''
	};
}

function setEntryEnabledAvailability(map, section_id, available, checking, retries) {
	var cbid = 'cbid.webdav-mounts.%s.enabled'.format(section_id);
	var field = map.findElement('data-field', cbid) || map.findElement('id', cbid);
	var checkbox = null;

	retries = retries || 0;

	if (field != null) {
		if (field.matches != null && field.matches('input[type="checkbox"]'))
			checkbox = field;
		else
			checkbox = field.querySelector('input[type="checkbox"]');
	}

	if (checkbox == null) {
		if (checking && retries < 10)
			window.setTimeout(function() {
				setEntryEnabledAvailability(map, section_id, available, checking, retries + 1);
			}, 0);
		return;
	}

	if (checking) {
		checkbox.disabled = true;
		return;
	}

	if (available) {
		checkbox.disabled = isReadonlyView || null;
		return;
	}

	checkbox.checked = false;
	checkbox.disabled = true;
	checkbox.dispatchEvent(new CustomEvent('widget-change', { bubbles: true }));
}

return view.extend({
	callRcInit: rpc.declare({
		object: 'rc',
		method: 'init',
		params: [ 'name', 'action' ],
		expect: { '': 1 }
	}),

	callServiceRunning: function() {
		return L.resolveDefault(fs.exec('/etc/init.d/webdav-mounts', [ 'running' ]), { code: 1 }).then(function(res) {
			return res.code === 0;
		});
	},

	callMainBinary: function() {
		return L.resolveDefault(fs.exec(MAIN_BINARY, [ '--version' ]), null).then(function(res) {
			var output, version;

			if (res == null || res.code !== 0)
				return {
					available: false,
					path: MAIN_BINARY,
					version: 'Unavailable'
				};

			output = ((res.stdout || res.stderr || '')).trim();
			version = output.split(/\n/)[0] || 'Unknown version';

			return {
				available: true,
				path: MAIN_BINARY,
				version: version
			};
		});
	},

	load: function() {
		return Promise.all([
			uci.load('webdav-mounts'),
			this.callServiceRunning(),
			this.callMainBinary()
		]);
	},

	handleServiceAction: function(m, actions, ev) {
		var self = this;

		return m.save().then(function() {
			var chain = Promise.resolve();

			actions.forEach(function(action) {
				chain = chain.then(function() {
					return self.callRcInit(SERVICE_NAME, action).then(function(code) {
						if (code !== 0)
							throw 'Command failed: %s'.format(action);
					});
				});
			});

			return chain;
		}).then(function() {
			ui.addNotification(null, E('p', 'Service state has been updated.'), 'info');
			window.location.reload();
		}).catch(function(e) {
			ui.addNotification(null, E('p', 'Unable to update service state: %s'.format(e)));
		});
	},

		probeEntry: function(map, section_id, node) {
			return probeWebdav(node, probeValuesFromUci(section_id)).then(function(available) {
				setEntryEnabledAvailability(map, section_id, available, false);
			});
		},

	render: function(data) {
		var view = this;
		var serviceRunning = data[1];
		var mainBinary = data[2];
		var globalSection = firstGlobalSection();
		var baseMountDir = globalSection ? getConfigValue(globalSection, 'base_mount_dir', 'base_mount_point', '/mnt/openlist') : '/mnt/openlist';
		var m, s, o, portOption;

		m = new form.Map('webdav-mounts', 'WebDAV Mounts', 'Manage WebDAV mounts using mount.webdavfs.');
		m.readonly = !mainBinary.available ? true : m.readonly;
		wrapMountDirSave(m);

		s = m.section(form.TypedSection, 'global', 'Service');
		s.anonymous = true;
		s.addremove = false;

		o = s.option(form.DummyValue, '_status', 'Status');
		o.cfgvalue = function() {
			return serviceRunning ? _('Running') : _('Stopped');
		};
		o.write = function() {};

		o = s.option(form.DummyValue, '_main_binary', 'Main Binary');
		o.cfgvalue = function() {
			return E('span', [
				E('code', mainBinary.path),
				' (%s)'.format(mainBinary.version)
			]);
		};
		o.write = function() {};

		if (!mainBinary.available)
			return m.render();

		o = s.option(form.DummyValue, '_action', 'Action');
		o.cfgvalue = L.bind(function() {
			return E('span', [
				E('button', {
					'type': 'button',
					'class': 'cbi-button cbi-button-apply',
					'click': ui.createHandlerFn(this, 'handleServiceAction', m, [ 'enable', 'start' ]),
					'disabled': isReadonlyView || serviceRunning || null
				}, [ 'Start' ]),
				' ',
				E('button', {
					'type': 'button',
					'class': 'cbi-button cbi-button-reset',
					'click': ui.createHandlerFn(this, 'handleServiceAction', m, [ 'stop', 'disable' ]),
					'disabled': isReadonlyView || !serviceRunning || null
				}, [ 'Stop' ])
			]);
		}, this);
		o.write = function() {};

		s = m.section(form.TypedSection, 'global', 'Global Settings');
		s.anonymous = true;
		s.addremove = false;

		o = s.option(form.Value, 'base_mount_dir', 'Base Mount Directory');
		o.placeholder = '/mnt/openlist';
		o.cfgvalue = function(section_id) {
			return getConfigValue(section_id, 'base_mount_dir', 'base_mount_point', '/mnt/openlist');
		};
		o.write = function(section_id, value) {
			writeMigratedValue(section_id, 'base_mount_dir', 'base_mount_point', (value || '').trim(), true);
		};
		o.remove = function(section_id) {
			writeMigratedValue(section_id, 'base_mount_dir', 'base_mount_point', '', true);
		};

		o = s.option(form.Flag, 'allow_other', 'Allow Other');
		o.default = o.enabled;
		o.rmempty = false;

		o = s.option(form.Flag, 'read_only', 'Read Only');
		o.default = o.disabled;
		o.rmempty = false;

		o = s.option(form.Value, 'other_options', 'Other Options');
		o.placeholder = 'uid=0,gid=0';
		o.rmempty = true;
		addMountOptionsHelp(o);

		s = m.section(form.GridSection, 'mount', 'Mount Entries');
		s.addremove = true;
		s.anonymous = true;
		s.modaltitle = 'Mount Entry';
		s.addbtntitle = 'Add Mount Entry';

		o = s.option(form.Flag, 'enabled', _('Enabled'));
		o.default = o.enabled;
		o.rmempty = false;
		o.editable = true;

		o = s.option(form.Value, 'name', 'Name');
		o.rmempty = false;
		o.onchange = function(ev, section_id, value) {
			updateDefaultMountDir(this.map, section_id, baseMountDir, value);
		};

		o = s.option(form.DummyValue, '_webdav_url', 'WebDAV URL');
		o.modalonly = false;
		o.textvalue = function(section_id) {
			return webdavUrl(section_id);
		};

			o = s.option(form.DummyValue, '_status', 'Status');
			o.modalonly = false;
			o.textvalue = function(section_id) {
				var node;

				node = createProbeStatusNode(function(ev) {
					ev.preventDefault();
					ev.stopPropagation();
					setProbeStatus(node, 'pending', 'Checking');
					setEntryEnabledAvailability(m, section_id, false, true);
					view.probeEntry(m, section_id, node);
				});

				setProbeStatus(node, 'pending', 'Checking');
				setEntryEnabledAvailability(m, section_id, false, true);
			window.setTimeout(function() {
				view.probeEntry(m, section_id, node);
			}, 0);

			return node;
		};

			o = s.option(form.Value, 'host', 'Host');
			o.modalonly = true;
			o.rmempty = false;

			o = s.option(form.Flag, 'use_https', 'Use HTTPS');
			o.modalonly = true;
			o.default = o.disabled;
			o.rmempty = false;
			o.onchange = function(ev, section_id, value) {
				var elem = this.section.getUIElement(section_id, 'port');
				var current;

				if (elem == null)
					return;

				current = elem.getValue();
				if (current === '' || current === '80' || current === '443') {
					elem.setValue(value === '1' ? '443' : '80');
					elem.triggerValidation();
				}
			};

			portOption = s.option(form.Value, 'port', 'Port');
			portOption.modalonly = true;
			portOption.datatype = 'port';
			portOption.rmempty = false;
			portOption.cfgvalue = function(section_id) {
				var value = uci.get('webdav-mounts', section_id, 'port');
				var use_https = uci.get('webdav-mounts', section_id, 'use_https') === '1';

				return value || (use_https ? '443' : '80');
			};

			o = s.option(form.ListValue, 'mount_dir_mode', 'Mount Directory');
			o.modalonly = true;
			o.default = baseMountDir ? 'default' : 'custom';
			o.rmempty = false;
			o.renderWidget = function(section_id, option_index, cfgvalue) {
				var mode = cfgvalue || this.default;
				var name = this.section.formvalue(section_id, 'name') || uci.get('webdav-mounts', section_id, 'name') || '';
				var customValue = uci.get('webdav-mounts', section_id, 'mount_dir') || '';
				var radioName = this.cbid(section_id);
				var customInput, defaultRadio, specifiedRadio, syncState;

				if (!baseMountDir && mode === 'default')
					mode = 'custom';

				defaultRadio = E('input', {
					'type': 'radio',
					'name': radioName,
					'value': 'default',
					'checked': mode === 'default' ? true : null,
					'disabled': !baseMountDir || null
				});
				specifiedRadio = E('input', {
					'type': 'radio',
					'name': radioName,
					'value': 'custom',
					'checked': mode === 'custom' ? true : null
				});
				customInput = E('input', {
					'type': 'text',
					'class': 'cbi-input-text',
					'data-role': 'specified-mount-dir',
					'value': customValue,
					'placeholder': '/mnt/openlist/name',
					'disabled': mode !== 'custom' ? true : null,
					'style': 'margin-top:0.25em;max-width:24em;width:100%'
				});

				syncState = function() {
					customInput.disabled = !specifiedRadio.checked;
				};

				defaultRadio.addEventListener('change', syncState);
				specifiedRadio.addEventListener('change', syncState);

				return E('div', { 'class': 'webdav-mount-dir-mode' }, [
					E('label', { 'style': 'display:block;margin-bottom:0.35em' }, [
						defaultRadio,
						' Use Default',
						E('div', {
							'data-role': 'default-mount-dir',
							'style': 'margin:0.25em 0 0 1.6em;color:#666;overflow-wrap:anywhere'
						}, baseMountDir ? joinMountDir(baseMountDir, name) : 'Unavailable')
					]),
					E('label', { 'style': 'display:block' }, [
						specifiedRadio,
						' Specified',
						E('div', { 'style': 'margin-left:1.6em' }, [
							customInput,
							E('div', { 'style': 'margin-top:0.25em;color:#666' }, 'Must start with /.')
						])
					])
				]);
			};
			o.formvalue = function(section_id) {
				var field = this.map.findElement('data-field', this.cbid(section_id));
				var checked = field ? field.querySelector('input[type="radio"]:checked') : null;

				return checked ? checked.value : this.default;
			};
			o.validate = function(section_id, value) {
				var field = this.map.findElement('data-field', this.cbid(section_id));
				var customInput = field ? field.querySelector('[data-role="specified-mount-dir"]') : null;
				var customValue = customInput ? customInput.value.trim() : '';

				if (value === 'default' && !baseMountDir)
					return 'Base Mount Directory is empty.';

				if (value === 'custom') {
					if (!customValue)
						return 'Specified Mount Directory is required.';

					if (customValue.charAt(0) !== '/')
						return 'Specified Mount Directory must start with /.';
				}

				return true;
			};
			o.write = function(section_id, value) {
				var field = this.map.findElement('data-field', this.cbid(section_id));
				var customInput = field ? field.querySelector('[data-role="specified-mount-dir"]') : null;
				var customValue = customInput ? customInput.value.trim() : '';

				uci.set('webdav-mounts', section_id, 'mount_dir_mode', value);

				if (value === 'custom')
					uci.set('webdav-mounts', section_id, 'mount_dir', customValue);
				else
					uci.unset('webdav-mounts', section_id, 'mount_dir');
			};

		o = s.option(form.Value, 'path_prefix', 'Path Prefix');
		o.modalonly = true;
		o.description = 'Must start with /.';
		o.rmempty = true;
		o.write = function(section_id, value) {
			value = normalizePrefix(value);

				if (value)
					uci.set('webdav-mounts', section_id, 'path_prefix', value);
				else
					uci.unset('webdav-mounts', section_id, 'path_prefix');
			};

		o = s.option(form.Flag, 'require_credential', 'Requires Credential');
			o.modalonly = true;
			o.default = o.disabled;
			o.rmempty = false;

			o = s.option(form.Value, 'username', 'Username');
			o.modalonly = true;
			o.depends('require_credential', '1');
			o.rmempty = false;
			o.validate = function(section_id, value) {
				if (this.section.formvalue(section_id, 'require_credential') === '1' && !value)
					return 'Username is required when credential is enabled.';

				return true;
			};

			o = s.option(form.Value, 'password', 'Password');
			o.modalonly = true;
			o.depends('require_credential', '1');
			o.password = true;
			o.rmempty = true;

			o = s.option(form.DummyValue, '_validate_url', 'Validate');
			o.modalonly = true;
			o.renderWidget = function(section_id) {
				var section = this.section;
				var statusNode = createProbeStatusNode();

				setProbeStatus(statusNode, 'pending', 'Not checked');

				return E('div', { 'style': 'display:flex;align-items:flex-start;gap:0.75em;flex-wrap:wrap' }, [
					E('button', {
						'type': 'button',
						'class': 'cbi-button cbi-button-action',
						'click': function(ev) {
							ev.preventDefault();
							ev.stopPropagation();
							setProbeStatus(statusNode, 'pending', 'Checking');
							probeWebdav(statusNode, probeValuesFromForm(section, section_id));
						}
					}, [ 'Validate' ]),
					statusNode
				]);
			};
			o.write = function() {};

			s.addModalOptions = function(modalSection, section_id) {
				var ss, so;

			wrapMountDirSave(modalSection.map, [ section_id ]);

			so = modalSection.option(form.SectionValue, '_override', form.NamedSection, section_id, 'mount', '');
			so.renderWidget = function(section_id, option_index, cfgvalue) {
				return this.subsection.render(section_id);
			};
			so.renderFrame = function(section_id, in_table, option_index, nodes) {
				return E('details', { 'class': 'webdav-override cbi-section' }, [
					E('summary', { 'style': 'cursor:pointer;font-weight:600;margin:0.5em 0' }, 'Override'),
					nodes
				]);
			};

			ss = so.subsection;
			ss.addremove = false;

			so = ss.option(form.ListValue, 'allow_other', 'Allow Other');
			so.value('', 'Use Global');
			so.value('1', 'Enabled');
			so.value('0', 'Disabled');
			so.default = '';
			so.rmempty = true;

			so = ss.option(form.ListValue, 'read_only', 'Read Only');
			so.value('', 'Use Global');
			so.value('1', 'Enabled');
			so.value('0', 'Disabled');
			so.default = '';
			so.rmempty = true;

			so = ss.option(form.Value, 'other_options', 'Other Options');
			so.rmempty = true;
			addMountOptionsHelp(so);
			};

		return m.render();
	}
});
