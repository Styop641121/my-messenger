(function () {
  'use strict';

  /* ---------- timers that keep running when the page is in the background ----------
     A hidden page gets its timers slowed down to about one per minute, which makes the
     server drop the connection while the phone is locked. Timers that run inside a Worker
     are not slowed down, so setTimeout/setInterval are routed through one. */
  (function () {
    try {
      if (!window.Worker || !window.Blob || !window.URL || !URL.createObjectURL) return;
      var src = 'var t={};onmessage=function(e){var d=e.data;' +
        'if(d.a==="s"){t[d.i]=setTimeout(function(){delete t[d.i];postMessage(d.i)},d.d)}' +
        'else if(d.a==="i"){t[d.i]=setInterval(function(){postMessage(d.i)},d.d)}' +
        'else if(d.a==="c"){clearTimeout(t[d.i]);clearInterval(t[d.i]);delete t[d.i]}}';
      var w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      var cbs = {}, seq = 1000000;
      var oST = window.setTimeout.bind(window), oSI = window.setInterval.bind(window);
      var oCT = window.clearTimeout.bind(window), oCI = window.clearInterval.bind(window);
      w.onmessage = function (e) {
        var c = cbs[e.data];
        if (!c) return;
        if (!c.rep) delete cbs[e.data];
        try { c.f.apply(window, c.args); } catch (err) { oST(function () { throw err; }, 0); }
      };
      function add(rep, f, d, args) {
        var id = ++seq;
        cbs[id] = { f: f, args: args, rep: rep };
        w.postMessage({ a: rep ? 'i' : 's', i: id, d: d });
        return id;
      }
      function clear(id, orig) {
        if (cbs[id]) { delete cbs[id]; w.postMessage({ a: 'c', i: id }); } else orig(id);
      }
      window.setTimeout = function (f, d) {
        d = Math.max(0, +d || 0);
        if (typeof f !== 'function' || d < 20) return oST.apply(null, arguments);
        return add(false, f, d, Array.prototype.slice.call(arguments, 2));
      };
      window.setInterval = function (f, d) {
        d = Math.max(20, +d || 0);
        if (typeof f !== 'function') return oSI.apply(null, arguments);
        return add(true, f, d, Array.prototype.slice.call(arguments, 2));
      };
      window.clearTimeout = function (id) { clear(id, oCT); };
      window.clearInterval = function (id) { clear(id, oCI); };
    } catch (e) { /* the normal timers keep working */ }
  })();

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

  /* ---------- Android bridge (absent when the page runs in a normal browser) ---------- */
  var NATIVE = window.Android || null;
  function native(fn, a, b, c) {
    try {
      if (!NATIVE || typeof NATIVE[fn] !== 'function') return undefined;
      if (arguments.length === 1) return NATIVE[fn]();
      if (arguments.length === 2) return NATIVE[fn](a);
      if (arguments.length === 3) return NATIVE[fn](a, b);
      return NATIVE[fn](a, b, c);
    } catch (e) { return undefined; }
  }
  function hasNative(fn) { return !!NATIVE && typeof NATIVE[fn] === 'function'; }
  function missedCall(id) { native('notifyMessage', id, nameOf(id), 'Բաց թողնված զանգ'); }

  /* ---------- network relay servers ---------- */
  // Mobile networks often block direct phone-to-phone links, so relay (TURN) servers are listed too.
  var ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478'], username: 'peerjs', credential: 'peerjsp' },
    {
      urls: [
        'turn:openrelay.metered.ca:80',
        'turn:openrelay.metered.ca:443',
        'turn:openrelay.metered.ca:443?transport=tcp',
        'turns:openrelay.metered.ca:443?transport=tcp'
      ],
      username: 'openrelayproject', credential: 'openrelayproject'
    }
  ];

  /* ---------- ring tones (generated, no audio files) ---------- */
  var audioCtx = null, ringInt = null;
  function tone(freq, dur) {
    if (!audioCtx) return;
    try {
      var o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = 'sine'; o.frequency.value = freq;
      o.connect(g); g.connect(audioCtx.destination);
      var t = audioCtx.currentTime;
      g.gain.setValueAtTime(0.3, t);
      g.gain.setValueAtTime(0, t + dur);
      o.start(t); o.stop(t + dur + 0.05);
    } catch (e) {}
  }
  function stopRing() {
    if (ringInt) { clearInterval(ringInt); ringInt = null; }
    native('stopCall'); // also stops the phone's own ringtone and clears the call notification
  }
  function startRing(isIncoming) {
    stopRing();
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch (e) { return; }
    function once() {
      if (isIncoming) {
        tone(880, 0.18);
        setTimeout(function () { tone(660, 0.18); }, 230);
        setTimeout(function () { tone(880, 0.18); }, 700);
        setTimeout(function () { tone(660, 0.18); }, 930);
      } else {
        tone(425, 1.0);
      }
    }
    once();
    ringInt = setInterval(once, isIncoming ? 2400 : 3500);
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
  // A short history of connection events, shown in the profile window, to find out what happens in the background.
  function netLog(text) {
    var l = load('netlog', []);
    l.push({ t: Date.now(), x: text });
    save('netlog', l.slice(-14));
  }
  function lastTs(id) { var m = msgs[id]; return m && m.length ? m[m.length - 1].ts : 0; }
  function pending(id) { return (msgs[id] || []).filter(function (m) { return m.m && m.s === 'p'; }); }

  /* ---------- screens ---------- */
  function showScreen(name) {
    ['setup', 'home', 'chat'].forEach(function (s) { $('#' + s).hidden = s !== name; });
  }
  var lastOn = null;
  function setStatus(on, text) {
    if (on !== lastOn) { lastOn = on; netLog(on ? 'Կապը կա' : 'Կապը կորավ'); }
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
  // A photo is a small square JPEG (data URL). Anything else is ignored.
  var PHOTO_RE = /^data:image\/jpeg;base64,[A-Za-z0-9+\/=]{20,20000}$/;
  function okPhoto(p) { return typeof p === 'string' && PHOTO_RE.test(p); }
  // Paints an avatar: the contact's photo, or the first letter on one of six shapes chosen from the id.
  function paintAvatar(a, c) {
    var h = 0, s = c.id || '';
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    a.setAttribute('data-k', String(h % 6));
    if (okPhoto(c.photo)) {
      a.textContent = '';
      a.style.backgroundImage = 'url("' + c.photo + '")';
      a.classList.add('photo');
    } else {
      a.textContent = (c.name || c.id || '?').charAt(0).toUpperCase();
      a.style.backgroundImage = '';
      a.classList.remove('photo');
    }
  }
  function avatarEl(c) {
    var a = el('span', 'avatar');
    a.setAttribute('aria-hidden', 'true');
    paintAvatar(a, c);
    return a;
  }
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
      b.appendChild(avatarEl(c));
      var body = el('span', 'ci-body');
      body.appendChild(el('span', 'ci-name', c.name || id));
      body.appendChild(el('span', 'ci-last', last ? (last.m ? 'Դու՝ ' : '') + last.x : c.id));
      b.appendChild(body);
      var side = el('span', 'ci-side');
      if (last) side.appendChild(el('span', 'ci-time', hhmm(last.ts)));
      if (c.unread > 0) side.appendChild(el('span', 'badge', String(c.unread)));
      b.appendChild(side);
      b.addEventListener('click', function () { openChat(id); });
      li.appendChild(b);
      var more = el('button', 'more');
      more.type = 'button';
      more.setAttribute('aria-label', 'Ընտրանքներ՝ ' + (c.name || id));
      more.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>';
      more.addEventListener('click', function () { openContact(id); });
      li.appendChild(more);
      list.appendChild(li);
    });
  }

  /* ---------- chat ---------- */
  function renderChatHeader() {
    if (!current) return;
    var c = ensureContact(current);
    $('#chat-name').textContent = c.name || c.id;
    paintAvatar($('#chat-avatar'), c);
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
    native('clearNotification', id);
    showScreen('chat');
    renderChat();
    connectTo(id);
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
    var p = new Peer(me.id, { config: { iceServers: ICE_SERVERS } });
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
        if (lookupPending && target.indexOf(lookupPending.id) !== -1) lookupPending.finish(null);
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

  // Asks an online person for their name and photo without adding them as a contact.
  var lookupPending = null;
  function lookupProfile(id, cb) {
    if (!peer || !online) { cb(null); return; }
    var done = false, conn = null, timer = null;
    function finish(r) {
      if (done) return;
      done = true; clearTimeout(timer);
      if (lookupPending && lookupPending.id === id) lookupPending = null;
      try { if (conn) conn.close(); } catch (e) {}
      cb(r);
    }
    lookupPending = { id: id, finish: finish };
    timer = setTimeout(function () { finish(null); }, 12000);
    try { conn = peer.connect(id, { reliable: true }); } catch (e) { finish(null); return; }
    conn.on('data', function (d) {
      if (d && d.t === 'hello') {
        finish({ name: typeof d.name === 'string' ? d.name.trim().slice(0, 30) : '', photo: okPhoto(d.p) ? d.p : '' });
      }
    });
    conn.on('error', function () { finish(null); });
  }

  var lastTick = Date.now();
  function tick() {
    var now = Date.now();
    if (now - lastTick > 60000) netLog('Էջը քնել էր ' + Math.round((now - lastTick) / 60000) + ' ր');
    lastTick = now;
    if (!me || !$('#setup').hidden) return;
    if (!peer || peer.destroyed) { startPeer(); return; }
    if (peer.disconnected) { try { peer.reconnect(); } catch (e) {} return; }
    if (online) Object.keys(msgs).forEach(flush);
  }
  setInterval(tick, 8000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) tick(); });
  window.addEventListener('online', tick);

  // conns[id] is a list: a contact can have several links at once (one we opened, one they opened).
  var CONNECT_PATIENCE = 40000; // how long a link may stay "connecting" before we try a fresh one
  function setupConn(conn) {
    var id = conn.peer;
    if (!conns[id]) conns[id] = [];
    if (!conn._t) conn._t = Date.now();
    conns[id].push(conn);
    conn.on('open', function () {
      try { conn.send({ t: 'hello', name: me.name, p: me.photo || '' }); } catch (e) {}
      flush(id);
    });
    conn.on('data', function (d) { onData(id, d); });
    function drop() {
      var l = conns[id] || [];
      var k = l.indexOf(conn);
      if (k !== -1) l.splice(k, 1);
    }
    conn.on('close', drop);
    conn.on('error', drop);
  }
  function openConn(id) {
    var l = conns[id] || [];
    for (var k = l.length - 1; k >= 0; k--) { if (l[k].open) return l[k]; }
    return null;
  }
  function connectTo(id) {
    var ready = openConn(id);
    if (ready) return ready;
    var l = conns[id] || [];
    for (var k = 0; k < l.length; k++) {
      if (Date.now() - l[k]._t < CONNECT_PATIENCE) return l[k]; // still trying, do not restart it
    }
    l.slice().forEach(function (c) { try { c.close(); } catch (e) {} });
    conns[id] = [];
    if (!peer || !online) return null;
    var nc = peer.connect(id, { reliable: true });
    nc._t = Date.now();
    setupConn(nc);
    return nc;
  }
  function sendCtl(id, obj) {
    var c = openConn(id);
    if (c) { try { c.send(obj); } catch (e) {} }
  }
  function flush(id) {
    var list = pending(id);
    if (!list.length || !online) return;
    var c = connectTo(id);
    if (!c || !c.open) return;
    // A link can look open but be dead after a network change. If messages stay unconfirmed, start a fresh link.
    var stuck = list.some(function (m) { return (m.n || 0) >= 3; });
    if (stuck) {
      list.forEach(function (m) { m.n = 0; });
      saveMsgs();
      (conns[id] || []).slice().forEach(function (x) { try { x.close(); } catch (e) {} });
      conns[id] = [];
      connectTo(id);
      return;
    }
    list.forEach(function (m) {
      m.n = (m.n || 0) + 1;
      try { c.send({ t: 'msg', i: m.i, x: m.x, ts: m.ts }); } catch (e) {}
    });
  }

  function onData(id, d) {
    if (!d || typeof d !== 'object') return;
    if (d.t === 'hello') {
      var c = ensureContact(id), changed = false;
      if (typeof d.name === 'string' && d.name.trim() && !c.custom) {
        c.name = d.name.trim().slice(0, 30);
        changed = true;
      }
      if (typeof d.p === 'string') {
        var np = okPhoto(d.p) ? d.p : '';
        if (np !== (c.photo || '')) { c.photo = np; changed = true; }
      }
      if (changed) {
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
      native('notifyMessage', id, nameOf(id), d.x.slice(0, 300)); // shown only when the app is not on screen
      if (current === id) renderChat(); else if (!current) renderHome();
    } else if (d.t === 'ack') {
      var l2 = msgs[id] || [], changed = false;
      for (var j = 0; j < l2.length; j++) {
        if (l2[j].i === d.i && l2[j].m && l2[j].s !== 'd') { l2[j].s = 'd'; changed = true; }
      }
      if (changed) { saveMsgs(); if (current === id) renderChat(); }
    } else if (d.t === 'bye') {
      if (incoming && incoming.peer === id) { dismissIncoming(); toast('Բաց թողնված զանգ'); missedCall(id); native('callEnded'); }
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
    paintAvatar($('#call-initial'), contacts[id] || { id: id, name: nameOf(id) });
    $('#c-cam').parentNode.hidden = !video;
    $('#c-mic').className = 'round';
    $('#c-cam').className = 'round';
    var local = $('#local');
    local.srcObject = video ? localStream : null;
    local.hidden = !video;
    $('#call-avatar').hidden = false;
    $('#remote').srcObject = null;
    setCallState('ringing', 'Զանգում ենք…');
    $('#call').hidden = false;
    native('keepScreenOn', true);
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
      startRing(false);
      setTimeout(function () { watchIce(c); }, 0);
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
      stopRing();
      var r = $('#remote');
      r.muted = false; r.volume = 1;
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
  // Shows how the network link is doing while connecting, and gives up cleanly if it fails.
  function watchIce(c) {
    var pc = c.peerConnection;
    if (!pc || !pc.addEventListener) return;
    pc.addEventListener('iceconnectionstatechange', function () {
      if (call !== c) return;
      var s = pc.iceConnectionState;
      if (callState !== 'active') {
        $('#call-state').textContent = (callState === 'ringing' ? 'Զանգում ենք…' : 'Կապվում ենք…') + ' (' + s + ')';
      }
      if (s === 'failed') {
        toast('Կապը չհաստատվեց։ Ցանցը չի թողնում ուղիղ կապ');
        endCall(true);
      }
    });
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
    stopRing();
    if (notify && id) sendCtl(id, { t: 'bye' });
    if (c) { try { c.close(); } catch (e) {} }
    stopStream(localStream); localStream = null;
    $('#remote').srcObject = null; $('#local').srcObject = null;
    $('#call').hidden = true;
    native('keepScreenOn', false);
    native('callEnded');
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
    if (hasNative('incomingCall')) native('incomingCall', id, nameOf(id), video); else startRing(true);
    connectTo(id);
    clearTimeout(incomingTimer);
    incomingTimer = setTimeout(function () {
      if (incoming === c) { rejectIncoming(); missedCall(id); }
    }, 45000);
    c.on('close', function () {
      if (incoming === c) { dismissIncoming(); toast('Բաց թողնված զանգ'); missedCall(id); native('callEnded'); }
    });
  }
  function dismissIncoming() {
    clearTimeout(incomingTimer);
    stopRing();
    incoming = null;
    closeDialog('#dlg-incoming');
  }
  function rejectIncoming() {
    var c = incoming;
    if (!c) return;
    sendCtl(c.peer, { t: 'bye' });
    dismissIncoming();
    native('callEnded');
    try { c.close(); } catch (e) {}
  }
  function acceptIncoming() {
    var c = incoming;
    if (!c) return;
    var video = $('#dlg-incoming').dataset.video === '1';
    var id = c.peer;
    clearTimeout(incomingTimer);
    stopRing();
    navigator.mediaDevices.getUserMedia(mediaConstraints(video)).then(function (stream) {
      if (incoming !== c) { stopStream(stream); return; }
      incoming = null;
      closeDialog('#dlg-incoming');
      localStream = stream;
      showCall(id, video);
      setCallState('connecting', 'Կապվում ենք…');
      bindCall(c);
      c.answer(stream);
      setTimeout(function () { watchIce(c); }, 0);
      clearTimeout(ringTimer);
      ringTimer = setTimeout(function () {
        if (call === c && callState !== 'active') { toast('Կապը չհաստատվեց'); endCall(true); }
      }, 40000);
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
    found = null; findSeq++; $('#add-found').hidden = true;
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
    if (found && found.id === id) {
      if (found.photo) c.photo = found.photo;
      if (!name && found.name && !c.custom) c.name = found.name;
    }
    if (name) { c.name = name; c.custom = true; }
    saveContacts();
    closeDialog('#dlg-add');
    renderHome();
    openChat(id);
  });

  var found = null, findSeq = 0;
  function showFound(msg, profile, id) {
    var box = $('#add-found');
    box.hidden = false;
    $('#found-text').textContent = msg;
    var av = $('#found-avatar');
    av.hidden = !profile;
    if (profile) paintAvatar(av, { id: id, name: profile.name || id, photo: profile.photo });
  }
  $('#add-id').addEventListener('input', function () { found = null; findSeq++; $('#add-found').hidden = true; });
  $('#add-find').addEventListener('click', function () {
    var id = $('#add-id').value.trim().toLowerCase();
    var err = $('#add-err');
    err.hidden = true;
    if (!validId(id)) { err.textContent = 'ID-ն սխալ է։ Այն պետք է լինի 3–30 նիշ՝ լատինատառ, թվեր, «_» կամ «-»։'; err.hidden = false; return; }
    if (me && id === me.id) { err.textContent = 'Սա քո սեփական ID-ն է։'; err.hidden = false; return; }
    var seq = ++findSeq;
    found = null;
    showFound('Փնտրում եմ…', null, id);
    lookupProfile(id, function (r) {
      if (seq !== findSeq) return;
      if (r) { found = { id: id, name: r.name, photo: r.photo }; showFound(r.name ? 'Գտնվեց՝ ' + r.name : 'Գտնվեց', r, id); }
      else showFound('Այս պահին առցանց չէ, կամ այդպիսի ID չկա։ Կարող ես ավելացնել, և նամակը կհասնի, երբ նա առցանց լինի։', null, id);
    });
  });

  // notification settings
  $('#btn-notif').addEventListener('click', function () {
    var fs = native('canFullScreen');
    $('#n-full').textContent = '3. Թույլատրել զանգը լրիվ էկրանով' + (fs === true ? ' (միացված է)' : fs === false ? ' (անջատված է)' : '');
    openDialog('#dlg-notif');
  });
  $('#n-close').addEventListener('click', function () { closeDialog('#dlg-notif'); });
  $('#n-notif').addEventListener('click', function () { native('openSettings', 'notifications'); });
  $('#n-batt').addEventListener('click', function () { native('openSettings', 'battery'); });
  $('#n-full').addEventListener('click', function () { native('openSettings', 'fullscreen'); });

  // my id
  function renderMyProfile() {
    if (!me) return;
    $('#myid-box').textContent = me.id;
    paintAvatar($('#me-avatar'), me);
    $('#photo-clear').hidden = !okPhoto(me.photo);
    var nl = load('netlog', []);
    $('#netlog').textContent = nl.length ? nl.map(function (e) { return hhmm(e.t) + '  ' + e.x; }).join('\n') : 'Դեռ գրառում չկա';
    var hasLock = hasNative('setAppLock');
    $('#lock-row').hidden = !hasLock;
    if (hasLock) $('#lock-toggle').textContent = native('isAppLock') === true ? 'Անջատել հավելվածի կողպումը' : 'Կողպել հավելվածը հեռախոսի ծածկագրով';
  }
  function broadcastProfile() {
    Object.keys(conns).forEach(function (id) { sendCtl(id, { t: 'hello', name: me.name, p: me.photo || '' }); });
  }
  function resizePhoto(file, cb) {
    var url = URL.createObjectURL(file), img = new Image();
    img.onload = function () {
      var S = 160, cv = document.createElement('canvas');
      cv.width = cv.height = S;
      var w = img.naturalWidth, h = img.naturalHeight, m = Math.min(w, h);
      cv.getContext('2d').drawImage(img, (w - m) / 2, (h - m) / 2, m, m, 0, 0, S, S);
      URL.revokeObjectURL(url);
      var q = 0.75, out = cv.toDataURL('image/jpeg', q);
      while (out.length > 18000 && q > 0.3) { q -= 0.1; out = cv.toDataURL('image/jpeg', q); }
      cb(okPhoto(out) ? out : null);
    };
    img.onerror = function () { URL.revokeObjectURL(url); cb(null); };
    img.src = url;
  }
  function setMyPhoto(p) {
    me.photo = p || '';
    save('me', me);
    renderMyProfile();
    broadcastProfile();
  }
  $('#photo-pick').addEventListener('click', function () { $('#photo-file').click(); });
  $('#photo-file').addEventListener('change', function () {
    var f = this.files && this.files[0];
    this.value = '';
    if (!f) return;
    resizePhoto(f, function (p) {
      if (p) { setMyPhoto(p); toast('Լուսանկարը պահվեց'); } else toast('Այս նկարը չհաջողվեց բացել');
    });
  });
  $('#photo-clear').addEventListener('click', function () { setMyPhoto(''); toast('Լուսանկարը հեռացվեց'); });
  $('#lock-toggle').addEventListener('click', function () {
    var on = native('isAppLock') === true;
    var r = native('setAppLock', !on);
    if (r === false) toast('Նախ հեռախոսի կարգավորումներում սահմանիր էկրանի կողպում (ծածկագիր, գրաֆիկական բանալի կամ մատնահետք)');
    else toast(on ? 'Կողպումն անջատվեց' : 'Կողպումը միացվեց');
    renderMyProfile();
  });
  $('#btn-myid').addEventListener('click', function () {
    $('#myid-share').hidden = !(window.Android && window.Android.share);
    renderMyProfile();
    openDialog('#dlg-myid');
  });
  $('#myid-close').addEventListener('click', function () { closeDialog('#dlg-myid'); });
  $('#myid-share').addEventListener('click', function () {
    if (window.Android && window.Android.share && me) {
      window.Android.share('Գրիր ինձ KHOSQ-ով։ Իմ ID-ն՝ ' + me.id);
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
  var delArmed = false, contactId = null;
  function openContact(id) {
    id = (typeof id === 'string' && id) ? id : current;
    if (!id) return;
    contactId = id;
    var c = ensureContact(id);
    $('#contact-title').textContent = c.name || c.id;
    $('#contact-id').textContent = c.id;
    $('#contact-name').value = c.name || '';
    delArmed = false;
    $('#contact-del').textContent = 'Ջնջել կոնտակտը';
    $('#contact-hint').hidden = true;
    openDialog('#dlg-contact');
  }
  $('#chat-title').addEventListener('click', function () { openContact(); });
  $('#btn-more').addEventListener('click', function () { openContact(); });
  $('#chat-title').addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openContact(); } });
  $('#contact-close').addEventListener('click', function () { closeDialog('#dlg-contact'); });
  $('#contact-save').addEventListener('click', function () {
    var c = ensureContact(contactId);
    var n = $('#contact-name').value.trim();
    if (n) { c.name = n; c.custom = true; saveContacts(); if (current === contactId) renderChatHeader(); renderHome(); }
    closeDialog('#dlg-contact');
  });
  $('#contact-del').addEventListener('click', function () {
    if (!delArmed) { delArmed = true; $('#contact-del').textContent = 'Այո, ջնջել'; $('#contact-hint').hidden = false; return; }
    var id = contactId;
    delete contacts[id]; delete msgs[id];
    saveContacts(); saveMsgs();
    closeDialog('#dlg-contact');
    if (current === id) closeChat(); else renderHome();
    toast('Կոնտակտը ջնջվեց');
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
  // Called by the Android shell when a notification is tapped while the page is running.
  window.__open = function (id) {
    if (!me || typeof id !== 'string' || !id) return false;
    ensureContact(id);
    openChat(id);
    return true;
  };

  function enterApp() {
    showScreen('home');
    renderHome();
    startPeer();
    var pc = native('consumePendingChat'); // a notification tapped before the page was ready
    if (pc) window.__open(String(pc));
  }
  if (me && me.id) enterApp(); else openSetup('');
})();
