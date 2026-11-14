(function () {
  'use strict';

  /* ---------- helpers ---------- */
  function $(s) { return document.querySelector(s); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function load(k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function hhmm(ts) {
    try { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; }
  }
  var ID_RE = /^[A-Za-z0-9]+(?:[_-][A-Za-z0-9]+)*$/;
  function validId(id) { return id.length >= 3 && id.length <= 30 && ID_RE.test(id); }

  var toastTimer = null;
  function toast(text) {
    var t = $('#toast');
    t.textContent = text; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 3500);
  }

  /* ---------- state ---------- */
  var me = load('me', null);              // { id, name }
  var contacts = load('contacts', {});    // id -> { id, name, custom, unread }
  var msgs = load('msgs', {});            // id -> [ { i, m, x, ts, s } ]  s: 'p' pending, 'd' delivered
  var peer = null, online = false, idRetry = 0;
  var conns = {};
  var current = null;
  var call = null, callId = null, callVideo = false, callState = '', callTimer = null, callStart = 0, ringTimer = null;
  var localStream = null;
  var incoming = null, incomingTimer = null;

  function saveContacts() { save('contacts', contacts); }
  function saveMsgs() {
    Object.keys(msgs).forEach(function (k) { if (msgs[k].length > 500) msgs[k] = msgs[k].slice(-500); });
    save('msgs', msgs);
  }
  function ensureContact(id) {
    if (!contacts[id]) { contacts[id] = { id: id, name: id, custom: false, unread: 0 }; saveContacts(); }
    return contacts[id];
  }
  function chatOf(id) { if (!msgs[id]) msgs[id] = []; return msgs[id]; }
  function lastTs(id) { var m = msgs[id]; return m && m.length ? m[m.length - 1].ts : 0; }
  function pending(id) { return (msgs[id] || []).filter(function (m) { return m.m && m.s === 'p'; }); }

  /* ---------- screens ---------- */
  function showScreen(name) {
    ['setup', 'home', 'chat'].forEach(function (s) { $('#' + s).hidden = s !== name; });
  }
  function setStatus(on, text) {
    online = on;
    $('#status').className = 'status' + (on ? ' on' : '');
    $('#status-text').textContent = text;
    if (current) renderChatHeader();
  }

  /* ---------- setup ---------- */
  function setupError(text) {
    var e = $('#setup-err');
    e.textContent = text || ''; e.hidden = !text;
  }
  function openSetup(errText) {
    $('#in-name').value = me ? me.name : '';
    $('#in-id').value = me ? me.id : 'u' + Math.random().toString(36).slice(2, 8);
    setupError(errText);
    showScreen('setup');
  }
  $('#btn-start').addEventListener('click', function () {
    var name = $('#in-name').value.trim();
    var id = $('#in-id').value.trim().toLowerCase();
    if (!name) { setupError('Գրիր քո անունը։'); return; }
    if (!validId(id)) {
      setupError('ID-ն պետք է լինի 3–30 նիշ. լատինատառ, թվեր, «_» կամ «-», սկսվի և ավարտվի տառով կամ թվով։');
      return;
    }
    me = { id: id, name: name };
    save('me', me);
    enterApp();
  });

  /* ---------- home ---------- */
  function renderHome() {
    var list = $('#chats');
    list.textContent = '';
    var ids = Object.keys(contacts).sort(function (a, b) { return lastTs(b) - lastTs(a); });
    $('#empty').hidden = ids.length > 0;
    list.hidden = ids.length === 0;
    ids.forEach(function (id) {
      var c = contacts[id], m = msgs[id] || [], last = m[m.length - 1];
      var li = el('li');
      var b = el('button', 'chat-item');
      b.type = 'button';
      b.appendChild(el('span', 'avatar', (c.name || id).charAt(0).toUpperCase()));
      var body = el('span', 'ci-body');
      body.appendChild(el('span', 'ci-name', c.name || id));
      body.appendChild(el('span', 'ci-last', last ? (last.m ? 'Դու՝ ' : '') + last.x : c.id));
      b.appendChild(body);
      if (c.unread > 0) b.appendChild(el('span', 'badge', String(c.unread)));
      b.addEventListener('click', function () { openChat(id); });
      li.appendChild(b);
      list.appendChild(li);
    });
  }

  /* ---------- chat ---------- */
  function renderChatHeader() {
    if (!current) return;
    var c = ensureContact(current);
    $('#chat-name').textContent = c.name || c.id;
    var p = pending(current).length;
    $('#chat-sub').textContent = !online ? 'Կապ չկա' : (p ? 'Չառաքված՝ ' + p : c.id);
  }
  function renderChat() {
    var log = $('#log');
    log.textContent = '';
    (msgs[current] || []).forEach(function (m) {
      var d = el('div', 'msg' + (m.m ? ' mine' : ''));
      d.appendChild(document.createTextNode(m.x));
      var meta = hhmm(m.ts);
      if (m.m) meta += m.s === 'd' ? ' · ✓' : ' · ուղարկվում է…';
      d.appendChild(el('span', 'meta', meta));
      log.appendChild(d);
    });
    log.scrollTop = log.scrollHeight;
    renderChatHeader();
  }
  function openChat(id) {
    current = id;
    var c = ensureContact(id);
    c.unread = 0; saveContacts();
    showScreen('chat');
    renderChat();
    flush(id);
  }
  function closeChat() {
    current = null;
    renderHome();
    showScreen('home');
  }
  function sendText() {
    var ta = $('#in-msg');
    var t = ta.value.trim();
    if (!t || !current) return;
    chatOf(current).push({ i: uid(), m: true, x: t.slice(0, 4000), ts: Date.now(), s: 'p' });
    saveMsgs();
    ta.value = ''; autoGrow();
    renderChat();
    flush(current);
  }
  function autoGrow() {
    var ta = $('#in-msg');
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
  }
  $('#composer').addEventListener('submit', function (e) { e.preventDefault(); sendText(); $('#in-msg').focus(); });
  $('#in-msg').addEventListener('input', autoGrow);
  $('#btn-back').addEventListener('click', closeChat);
  $('#btn-acall').addEventListener('click', function () { if (current) startCall(current, false); });
  $('#btn-vcall').addEventListener('click', function () { if (current) startCall(current, true); });

  /* ---------- networking (PeerJS) ---------- */
  function startPeer() {
    if (!me) return;
    if (typeof Peer === 'undefined') { setStatus(false, 'Գրադարանը բացակայում է'); return; }
    if (peer && !peer.destroyed) return;
    setStatus(false, 'Միանում է…');
    var p = new Peer(me.id);
    peer = p;

    p.on('open', function () {
      if (p !== peer) return;
      idRetry = 0;
      setStatus(true, 'Կապի մեջ է');
      Object.keys(msgs).forEach(flush);
    });
    p.on('disconnected', function () {
      if (p !== peer) return;
      setStatus(false, 'Կապ չկա');
    });
    p.on('close', function () {
      if (p !== peer) return;
      setStatus(false, 'Կապ չկա');
    });
    p.on('connection', function (c) { if (p === peer) setupConn(c); });
    p.on('call', function (c) { if (p === peer) onIncomingCall(c); });
    p.on('error', function (err) {
      if (p !== peer) return;
      var type = err && err.type;
      if (type === 'unavailable-id') {
        try { p.destroy(); } catch (e) {}
        peer = null;
        idRetry++;
        if (idRetry <= 4) { setStatus(false, 'Միանում է…'); setTimeout(startPeer, 3000); }
        else { idRetry = 0; openSetup('Այս ID-ն արդեն զբաղված է։ Ընտրիր ուրիշ ID։'); }
      } else if (type === 'peer-unavailable') {
        // Failed message retries to other offline contacts also raise this error, so match the callee.
        var target = String((err && err.message) || '');
        if (call && callState === 'ringing' && callId && target.indexOf(callId) !== -1) {
          toast('Կոնտակտը հասանելի չէ (հավանաբար օֆլայն է)');
          endCall(false);
        }
      } else if (type === 'invalid-id' || type === 'browser-incompatible') {
        openSetup('ID-ն ընդունված չէ։ Փորձիր ուրիշ ID։');
      } else {
        setStatus(false, 'Կապ չկա');
      }
    });
  }

  function tick() {
    if (!me || !$('#setup').hidden) return;
    if (!peer || peer.destroyed) { startPeer(); return; }
    if (peer.disconnected) { try { peer.reconnect(); } catch (e) {} return; }
    if (online) Object.keys(msgs).forEach(flush);
  }
  setInterval(tick, 8000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) tick(); });
  window.addEventListener('online', tick);

  function setupConn(conn) {
    var id = conn.peer;
    conns[id] = conn;
    conn.on('open', function () {
      try { conn.send({ t: 'hello', name: me.name }); } catch (e) {}
      flush(id);
    });
    conn.on('data', function (d) { onData(id, d); });
    function drop() { if (conns[id] === conn) delete conns[id]; }
    conn.on('close', drop);
    conn.on('error', drop);
  }
  function connectTo(id) {
    var c = conns[id];
    if (c && (c.open || (c._t && Date.now() - c._t < 12000))) return c;
    if (c) { try { c.close(); } catch (e) {} delete conns[id]; }
    if (!peer || !online) return null;
    var nc = peer.connect(id, { reliable: true });
    nc._t = Date.now();
    setupConn(nc);
    return nc;
  }
  function sendCtl(id, obj) {
    var c = conns[id];
    if (c && c.open) { try { c.send(obj); } catch (e) {} }
  }
  function flush(id) {
    var list = pending(id);
    if (!list.length || !online) return;
    var c = connectTo(id);
    if (c && c.open) {
      list.forEach(function (m) {
        try { c.send({ t: 'msg', i: m.i, x: m.x, ts: m.ts }); } catch (e) {}
      });
    }
  }

  function onData(id, d) {
    if (!d || typeof d !== 'object') return;
    if (d.t === 'hello') {
      var c = ensureContact(id);
      if (typeof d.name === 'string' && d.name.trim() && !c.custom) {
        c.name = d.name.trim().slice(0, 30);
        saveContacts();
        if (current === id) renderChatHeader(); else if (!current) renderHome();
      }
    } else if (d.t === 'msg') {
      if (typeof d.i !== 'string' || typeof d.x !== 'string') return;
      sendCtl(id, { t: 'ack', i: d.i });
      var list = chatOf(id);
      for (var k = 0; k < list.length; k++) { if (list[k].i === d.i) return; }
      var ct = ensureContact(id);
      list.push({ i: d.i, m: false, x: d.x.slice(0, 4000), ts: Date.now() });
      if (current === id) { ct.unread = 0; } else { ct.unread = (ct.unread || 0) + 1; }
      saveMsgs(); saveContacts();
      if (current === id) renderChat(); else if (!current) renderHome();
    } else if (d.t === 'ack') {
      var l2 = msgs[id] || [], changed = false;
      for (var j = 0; j < l2.length; j++) {
        if (l2[j].i === d.i && l2[j].m && l2[j].s !== 'd') { l2[j].s = 'd'; changed = true; }
      }
      if (changed) { saveMsgs(); if (current === id) renderChat(); }
    } else if (d.t === 'bye') {
      if (incoming && incoming.peer === id) { dismissIncoming(); toast('Բաց թողնված զանգ'); }
      if (call && callId === id) endCall(false);
    }
  }

  /* ---------- calls ---------- */
  function mediaConstraints(video) {
    return {
      audio: { echoCancellation: true, noiseSuppression: true },
      video: video ? { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } } : false
    };
  }
  function nameOf(id) { var c = contacts[id]; return c ? (c.name || id) : id; }

  function showCall(id, video) {
    callId = id; callVideo = video;
    $('#call-name').textContent = nameOf(id);
    $('#call-initial').textContent = nameOf(id).charAt(0).toUpperCase();
    $('#c-cam').hidden = !video;
    $('#c-mic').className = 'round';
    $('#c-cam').className = 'round';
    var local = $('#local');
    local.srcObject = video ? localStream : null;
    local.hidden = !video;
    $('#call-avatar').hidden = false;
    $('#remote').srcObject = null;
    setCallState('ringing', 'Զանգում ենք…');
    $('#call').hidden = false;
  }
  function setCallState(state, text) {
    callState = state;
    $('#call-state').textContent = text;
  }

  function startCall(id, video) {
    if (call || incoming) { toast('Արդեն զանգ կա'); return; }
    if (!peer || !online) { toast('Կապ չկա, փորձիր մի փոքր հետո'); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { toast('Այս սարքում զանգը հասանելի չէ'); return; }
    navigator.mediaDevices.getUserMedia(mediaConstraints(video)).then(function (stream) {
      if (call || incoming) { stopStream(stream); return; }
      localStream = stream;
      showCall(id, video);
      connectTo(id);
      var c = peer.call(id, stream, { metadata: { video: video, name: me.name } });
      if (!c) { toast('Չհաջողվեց զանգել'); endCall(false); return; }
      bindCall(c);
      clearTimeout(ringTimer);
      ringTimer = setTimeout(function () {
        if (call && callState === 'ringing') { toast('Պատասխան չեղավ'); endCall(true); }
      }, 45000);
    }).catch(function () {
      toast('Տեսախցիկի կամ խոսափողի թույլտվությունը չի տրվել');
    });
  }

  function bindCall(c) {
    call = c;
    c.on('stream', function (rs) {
      if (call !== c) return;
      clearTimeout(ringTimer);
      var r = $('#remote');
      r.srcObject = rs;
      var p = r.play(); if (p && p.catch) p.catch(function () {});
      $('#call-avatar').hidden = rs.getVideoTracks().length > 0;
      if (callState !== 'active') {
        callStart = Date.now();
        clearInterval(callTimer);
        callTimer = setInterval(updateTimer, 1000);
        updateTimer();
        callState = 'active';
      }
    });
    c.on('close', function () { if (call === c) endCall(false); });
    c.on('error', function () { if (call === c) endCall(false); });
  }
  function updateTimer() {
    var s = Math.floor((Date.now() - callStart) / 1000);
    var m = Math.floor(s / 60), r = s % 60;
    $('#call-state').textContent = (m < 10 ? '0' : '') + m + ':' + (r < 10 ? '0' : '') + r;
  }
  function stopStream(s) { if (s) s.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} }); }

  function endCall(notify) {
    if (!call && !localStream && $('#call').hidden) return;
    var c = call, id = callId;
    call = null; callId = null; callState = '';
    clearInterval(callTimer); clearTimeout(ringTimer);
    if (notify && id) sendCtl(id, { t: 'bye' });
    if (c) { try { c.close(); } catch (e) {} }
    stopStream(localStream); localStream = null;
    $('#remote').srcObject = null; $('#local').srcObject = null;
    $('#call').hidden = true;
  }

  function onIncomingCall(c) {
    if (call || incoming) { try { c.close(); } catch (e) {} return; }
    incoming = c;
    var id = c.peer;
    var c0 = ensureContact(id);
    var meta = c.metadata || {};
    if (typeof meta.name === 'string' && meta.name.trim() && !c0.custom && c0.name === id) {
      c0.name = meta.name.trim().slice(0, 30); saveContacts();
    }
    var video = !!meta.video;
    $('#inc-title').textContent = nameOf(id) + ' քեզ զանգում է';
    $('#inc-kind').textContent = video ? 'Տեսազանգ' : 'Ձայնային զանգ';
    $('#dlg-incoming').dataset.video = video ? '1' : '';
    openDialog('#dlg-incoming');
    connectTo(id);
    clearTimeout(incomingTimer);
    incomingTimer = setTimeout(function () { if (incoming === c) rejectIncoming(); }, 45000);
    c.on('close', function () {
      if (incoming === c) { dismissIncoming(); toast('Բաց թողնված զանգ'); }
    });
  }
  function dismissIncoming() {
    clearTimeout(incomingTimer);
    incoming = null;
    closeDialog('#dlg-incoming');
  }
  function rejectIncoming() {
    var c = incoming;
    if (!c) return;
    sendCtl(c.peer, { t: 'bye' });
    dismissIncoming();
    try { c.close(); } catch (e) {}
  }
  function acceptIncoming() {
    var c = incoming;
    if (!c) return;
    var video = $('#dlg-incoming').dataset.video === '1';
    var id = c.peer;
    clearTimeout(incomingTimer);
    navigator.mediaDevices.getUserMedia(mediaConstraints(video)).then(function (stream) {
      if (incoming !== c) { stopStream(stream); return; }
      incoming = null;
      closeDialog('#dlg-incoming');
      localStream = stream;
      showCall(id, video);
      setCallState('connecting', 'Կապվում ենք…');
      bindCall(c);
      c.answer(stream);
    }).catch(function () {
      toast('Տեսախցիկի կամ խոսափողի թույլտվությունը չի տրվել');
      rejectIncoming();
    });
  }
  $('#inc-yes').addEventListener('click', acceptIncoming);
  $('#inc-no').addEventListener('click', rejectIncoming);
  $('#dlg-incoming').addEventListener('cancel', function (e) { e.preventDefault(); });

  $('#c-end').addEventListener('click', function () { endCall(true); });
  $('#c-mic').addEventListener('click', function () {
    if (!localStream) return;
    var off = false;
    localStream.getAudioTracks().forEach(function (t) { t.enabled = !t.enabled; off = !t.enabled; });
    $('#c-mic').className = 'round' + (off ? ' off' : '');
    $('#c-mic').setAttribute('aria-label', off ? 'Խոսափողը միացնել' : 'Խոսափողն անջատել');
  });
  $('#c-cam').addEventListener('click', function () {
    if (!localStream) return;
    var off = false;
    localStream.getVideoTracks().forEach(function (t) { t.enabled = !t.enabled; off = !t.enabled; });
    $('#c-cam').className = 'round' + (off ? ' off' : '');
    $('#c-cam').setAttribute('aria-label', off ? 'Տեսախցիկը միացնել' : 'Տեսախցիկն անջատել');
  });

  /* ---------- dialogs ---------- */
  function openDialog(sel) { var d = $(sel); if (!d.open) { try { d.showModal(); } catch (e) { d.setAttribute('open', ''); } } }
  function closeDialog(sel) { var d = $(sel); if (d.open) { try { d.close(); } catch (e) { d.removeAttribute('open'); } } }

  // add contact
  $('#btn-add').addEventListener('click', function () {
    $('#add-id').value = ''; $('#add-name').value = '';
    $('#add-err').hidden = true;
    openDialog('#dlg-add');
  });
  $('#add-cancel').addEventListener('click', function () { closeDialog('#dlg-add'); });
  $('#form-add').addEventListener('submit', function (e) {
    e.preventDefault();
    var id = $('#add-id').value.trim().toLowerCase();
    var name = $('#add-name').value.trim();
    var err = $('#add-err');
    if (!validId(id)) { err.textContent = 'ID-ն սխալ է։ Այն պետք է լինի 3–30 նիշ՝ լատինատառ, թվեր, «_» կամ «-»։'; err.hidden = false; return; }
    if (me && id === me.id) { err.textContent = 'Սա քո սեփական ID-ն է։'; err.hidden = false; return; }
    var c = ensureContact(id);
    if (name) { c.name = name; c.custom = true; saveContacts(); }
    closeDialog('#dlg-add');
    renderHome();
    openChat(id);
  });

  // my id
  $('#btn-myid').addEventListener('click', function () {
    $('#myid-box').textContent = me ? me.id : '';
    $('#myid-share').hidden = !(window.Android && window.Android.share);
    openDialog('#dlg-myid');
  });
  $('#myid-close').addEventListener('click', function () { closeDialog('#dlg-myid'); });
  $('#myid-share').addEventListener('click', function () {
    if (window.Android && window.Android.share && me) {
      window.Android.share('Գրիր ինձ իմ մեսենջերով։ Իմ ID-ն՝ ' + me.id);
    }
  });
  $('#myid-copy').addEventListener('click', function () {
    var text = me ? me.id : '';
    function fallback() {
      var ta = el('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) {}
      document.body.removeChild(ta);
      toast(ok ? 'Պատճենվեց' : 'Երկար սեղմիր ID-ի վրա և պատճենիր');
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast('Պատճենվեց'); }, fallback);
    } else { fallback(); }
  });

  // contact details
  var delArmed = false;
  function openContact() {
    if (!current) return;
    var c = ensureContact(current);
    $('#contact-title').textContent = c.name || c.id;
    $('#contact-id').textContent = c.id;
    $('#contact-name').value = c.name || '';
    delArmed = false;
    $('#contact-del').textContent = 'Ջնջել զրույցը';
    openDialog('#dlg-contact');
  }
  $('#chat-title').addEventListener('click', openContact);
  $('#chat-title').addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openContact(); } });
  $('#contact-close').addEventListener('click', function () { closeDialog('#dlg-contact'); });
  $('#contact-save').addEventListener('click', function () {
    var c = ensureContact(current);
    var n = $('#contact-name').value.trim();
    if (n) { c.name = n; c.custom = true; saveContacts(); renderChatHeader(); }
    closeDialog('#dlg-contact');
  });
  $('#contact-del').addEventListener('click', function () {
    if (!delArmed) { delArmed = true; $('#contact-del').textContent = 'Հաստատել ջնջումը'; return; }
    var id = current;
    delete contacts[id]; delete msgs[id];
    saveContacts(); saveMsgs();
    closeDialog('#dlg-contact');
    closeChat();
  });

  /* ---------- Android back button ---------- */
  window.__back = function () {
    if (!$('#call').hidden) return true;
    if (incoming) return true;
    var open = document.querySelector('dialog[open]');
    if (open) { try { open.close(); } catch (e) { open.removeAttribute('open'); } return true; }
    if (!$('#chat').hidden) { closeChat(); return true; }
    return false;
  };

  /* ---------- start ---------- */
  function enterApp() {
    showScreen('home');
    renderHome();
    startPeer();
  }
  if (me && me.id) enterApp(); else openSetup('');
})();
