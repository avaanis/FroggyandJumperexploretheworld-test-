(() => {
  const $ = (id) => document.getElementById(id);
  const ed = $("editor");
  const LS = { data: "fj_data_v1", auth: "fj_unlocked", theme: "fj_theme", who: "fj_who", active: "fj_active" };
  const shared = typeof FIREBASE_CONFIG !== "undefined" && FIREBASE_CONFIG;
  const LEGACY_TEXT = "<p>Songs that belong to us. Add notes, memories or song dedications below.</p>";
  const session = Math.random().toString(36).slice(2);

  let me = localStorage.getItem(LS.who) || "Jumper";
  const other = () => (me === "Jumper" ? "Froggy" : "Jumper");

  let tabs = [], activeId = localStorage.getItem(LS.active);
  let col = null, presCol = null, firstLoad = true, started = false;
  let presence = {}, lastOff = null, lastPresWrite = 0, presPending = null;
  let renderedEmbed = null, pendingRange = null, activeCid = null, dragFrom = null, savedRange = null;
  const dirty = new Set(), timers = {};

  const uid = () => Math.random().toString(36).slice(2, 9);
  const norm = (s) => s.trim().toLowerCase();
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const sha256 = async (t) =>
    [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)))]
      .map((b) => b.toString(16).padStart(2, "0")).join("");
  const cur = () => tabs.find((t) => t.id === activeId);
  const byOrder = (a, b) => a.order - b.order || a.updated - b.updated;
  const normalize = (t, i) => ({
    id: t.id || uid(), title: t.title || "", html: t.html || "", embed: t.embed || "",
    comments: Array.isArray(t.comments) ? t.comments : [],
    order: typeof t.order === "number" ? t.order : i, updated: t.updated || 0
  });
  const clean = (t) => { if (t.html === LEGACY_TEXT) t.html = ""; return t; };
  const seedTab = () => ({ id: "playlist", title: "Our Playlist", html: "", embed: SEED_PLAYLIST, comments: [], order: -1, updated: Date.now() });
  const toDoc = (t) => ({ title: t.title, html: t.html, embed: t.embed, comments: t.comments, order: t.order, updated: t.updated, by: session });

  function setSync(msg, bad) {
    $("sync-status").textContent = msg;
    $("sync-status").className = bad ? "bad" : "";
  }

  /* ================= Theme ================= */
  function setTheme(t) {
    document.documentElement.setAttribute("data-theme", t);
    localStorage.setItem(LS.theme, t);
    $("theme-toggle").textContent = t === "dark" ? "Light mode" : "Dark mode";
  }
  const toggleTheme = () => setTheme(document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark");
  setTheme(document.documentElement.getAttribute("data-theme"));
  $("theme-toggle").onclick = toggleTheme;

  /* ================= Login ================= */
  let loginWho = me;
  document.querySelectorAll("#who-seg button").forEach((b) => {
    b.classList.toggle("on", b.dataset.who === loginWho);
    b.onclick = () => {
      loginWho = b.dataset.who;
      document.querySelectorAll("#who-seg button").forEach((x) => x.classList.toggle("on", x === b));
    };
  });

  const AUTH_MSG = {
    bad: "Incorrect password.",
    "auth/invalid-credential": "Incorrect password, or the shared login has not been added in Firebase yet.",
    "auth/wrong-password": "Incorrect password.",
    "auth/user-not-found": "The shared login has not been added in Firebase Authentication yet.",
    "auth/invalid-email": "SHARED_EMAIL in config.js is not a valid email address.",
    "auth/operation-not-allowed": "Turn on Email/Password sign-in in Firebase Authentication.",
    "auth/unauthorized-domain": "Add this website's domain in Firebase: Authentication > Settings > Authorized domains.",
    "auth/network-request-failed": "Could not reach Firebase. Check your connection.",
    "auth/invalid-api-key": "The Firebase apiKey in config.js is wrong.",
    "auth/too-many-requests": "Too many attempts. Wait a minute and try again."
  };

  let fbReady = false;
  function initFirebase() {
    if (fbReady) return;
    fbReady = true;
    firebase.initializeApp(FIREBASE_CONFIG);
    try { firebase.firestore().settings({ experimentalAutoDetectLongPolling: true, merge: true }); } catch (e) {}
  }

  $("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const pw = norm($("pw").value);
    $("login-error").hidden = true;
    me = loginWho;
    localStorage.setItem(LS.who, me);
    try {
      if (shared) {
        initFirebase();
        await firebase.auth().signInWithEmailAndPassword(SHARED_EMAIL, pw);
      } else if ((await sha256(pw)) !== PASSWORD_HASH) {
        throw { code: "bad" };
      } else {
        sessionStorage.setItem(LS.auth, "1");
      }
      start();
    } catch (err) {
      $("login-error").textContent = AUTH_MSG[err.code] || "Could not sign in" + (err.code ? " (" + err.code + ")" : "") + ".";
      $("login-error").hidden = false;
      $("pw").select();
    }
  });

  $("logout").onclick = async () => {
    flushAll();
    if (presCol) await presCol.doc(me).set({ seen: 0 }, { merge: true }).catch(() => {});
    sessionStorage.removeItem(LS.auth);
    if (shared && fbReady) await firebase.auth().signOut();
    location.reload();
  };

  /* ================= Start ================= */
  function start() {
    if (started) return;
    started = true;
    $("login").hidden = true;
    $("app").hidden = false;
    $("pw").value = "";

    if (shared) {
      col = firebase.firestore().collection("fj-tabs");
      setSync("Connecting...");
      col.onSnapshot(onRemote, (err) =>
        setSync(err.code === "permission-denied" ? "Sync blocked: publish the Firestore rules" : "Sync offline (" + (err.code || "error") + ")", true));
      startPresence();
    } else {
      $("banner").textContent = "Live sync is off, so changes are saved only on this device and " + other() + " will not see them. Connect Firebase (see README) to turn it on.";
      $("banner").hidden = false;
      let local = null;
      try { local = JSON.parse(localStorage.getItem(LS.data)); } catch (e) {}
      tabs = ((local && local.tabs) || []).map(normalize).map(clean);
      if (!(local && local.seeded)) tabs.unshift(seedTab());
      tabs.sort(byOrder).forEach((t, i) => (t.order = i));
      persistLocal();
      setSync("Sync off, this device only", true);
      finishLoad();
    }
  }

  function finishLoad() {
    if (!cur()) activeId = tabs[0] ? tabs[0].id : null;
    render(true);
  }

  /* ================= Live sync ================= */
  function onRemote(snap) {
    let listChanged = false, activeChanged = false;
    snap.docChanges().forEach((ch) => {
      const id = ch.doc.id;
      if (ch.doc.metadata.hasPendingWrites) return;
      if (ch.type === "removed") {
        if (tabs.some((t) => t.id === id)) {
          tabs = tabs.filter((t) => t.id !== id);
          listChanged = true;
          if (id === activeId) activeChanged = true;
        }
        return;
      }
      const d = ch.doc.data();
      const t = tabs.find((x) => x.id === id);
      const next = clean(normalize(Object.assign({}, d, { id }), 0));
      if (!t) {
        next.base = { html: next.html, title: next.title };
        tabs.push(next);
        listChanged = true;
        return;
      }
      if (d.by === session) return;                    // echo of our own write

      if (dirty.has(id)) {                             // we have unsent edits: merge block by block
        const m = mergeHtml((t.base || {}).html || "", t.html, next.html);
        if (m !== null && m !== t.html) {
          const known = new Set(t.comments.map((c) => c.id));
          t.comments = t.comments.concat(next.comments.filter((c) => !known.has(c.id)))
            .filter((c) => m.includes(`data-cid="${c.id}"`));
          t.html = m;
          if (id === activeId) activeChanged = true;
          touch(t);
        }
        t.base = { html: next.html, title: next.title };
        return;
      }

      const diff = ["title", "html", "embed"].some((k) => t[k] !== next[k]) ||
        JSON.stringify(t.comments) !== JSON.stringify(next.comments);
      if (diff || t.order !== next.order) listChanged = true;
      if (diff && id === activeId) activeChanged = true;
      Object.assign(t, next);
      t.base = { html: next.html, title: next.title };
    });
    tabs.sort(byOrder);

    if (firstLoad) {
      firstLoad = false;
      if (snap.empty) seedShared();
      setSync("Live");
      finishLoad();
      return;
    }
    if (!cur()) { activeId = tabs[0] ? tabs[0].id : null; render(true); return; }
    if (listChanged && dragFrom === null) renderTabs();
    if (activeChanged) applyActive();
  }

  async function seedShared() {
    try {
      const db = firebase.firestore();
      const meta = db.collection("fj-meta").doc("app");
      if ((await meta.get()).exists) return;
      await meta.set({ seeded: true });
      let list = [];
      try {
        const old = await db.collection("froggy-jumper").doc("lists").get();
        if (old.exists) list = JSON.parse(old.data().json).tabs || [];
      } catch (e) {}
      if (!list.length) { try { list = JSON.parse(localStorage.getItem(LS.data)).tabs || []; } catch (e) {} }
      if (!list.length) list = [seedTab()];
      list.forEach((t, i) => {
        const n = clean(normalize(t, i));
        n.order = i;
        db.collection("fj-tabs").doc(n.id).set(toDoc(n));
      });
    } catch (e) { setSync("Setup problem: check the Firestore rules", true); }
  }

  /* ---- block-level merge so two people can type in the same tab ---- */
  function blocks(html) {
    const d = document.createElement("div");
    d.innerHTML = html;
    const m = new Map(), order = [];
    for (const n of d.childNodes) {
      if (n.nodeType !== 1 || !n.dataset.b) return null;
      m.set(n.dataset.b, n.outerHTML);
      order.push(n.dataset.b);
    }
    return { m, order };
  }

  function mergeHtml(base, local, remote) {
    const B = blocks(base), L = blocks(local), R = blocks(remote);
    if (!B || !L || !R) return null;
    const pick = (id) => {
      const inB = B.m.has(id), inL = L.m.has(id), inR = R.m.has(id);
      const b = B.m.get(id), l = L.m.get(id), r = R.m.get(id);
      if (inB) {
        if (!inL && !inR) return null;
        if (!inL) return r === b ? null : r;
        if (!inR) return l === b ? null : l;
        return l !== b ? l : r;
      }
      return inL ? l : r;
    };
    const order = R.order.slice();
    L.order.forEach((id, i) => {
      if (order.includes(id) || pick(id) === null) return;
      const prev = L.order[i - 1];
      const at = prev ? order.indexOf(prev) + 1 : 0;
      order.splice(at < 0 ? order.length : at, 0, id);
    });
    return order.map(pick).filter((x) => x !== null).join("");
  }

  function applyActive() {
    const t = cur(); if (!t) return;
    if (document.activeElement !== $("doc-title")) $("doc-title").value = t.title;
    if (ed.innerHTML !== t.html) {
      const off = document.activeElement === ed ? caretOffset(ed) : null;
      ed.innerHTML = t.html || "<p><br></p>";
      if (off !== null) setCaret(ed, off);
    }
    renderEmbed(t);
    renderComments();
    renderRemoteCaret();
  }

  function caretOffset(root) {
    const s = getSelection();
    if (!s.rangeCount || !root.contains(s.anchorNode)) return null;
    const pre = document.createRange();
    pre.selectNodeContents(root);
    pre.setEnd(s.getRangeAt(0).endContainer, s.getRangeAt(0).endOffset);
    return pre.toString().length;
  }
  function setCaret(root, off) {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n, c = 0;
    while ((n = w.nextNode())) {
      if (c + n.length >= off) {
        const r = document.createRange();
        r.setStart(n, off - c); r.collapse(true);
        const s = getSelection(); s.removeAllRanges(); s.addRange(r);
        return;
      }
      c += n.length;
    }
  }
  function placeCaret(el, end) {
    const r = document.createRange();
    r.selectNodeContents(el); r.collapse(!end);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  }

  /* ================= Saving ================= */
  function persistLocal() {
    try { localStorage.setItem(LS.data, JSON.stringify({ tabs: tabs.map(({ base, ...r }) => r), seeded: true })); } catch (e) {}
  }

  function touch(t) {
    t.updated = Date.now();
    if (!shared) { persistLocal(); setSync("Sync off, this device only", true); return; }
    dirty.add(t.id);
    setSync("Saving...");
    clearTimeout(timers[t.id]);
    timers[t.id] = setTimeout(() => pushTab(t.id), 200);
  }

  function pushTab(id) {
    clearTimeout(timers[id]); delete timers[id];
    const t = tabs.find((x) => x.id === id);
    if (!t || !dirty.has(id)) return;
    const stamp = t.updated, html = t.html, title = t.title;
    col.doc(id).set(toDoc(t))
      .then(() => {
        t.base = { html, title };
        if (t.updated === stamp) dirty.delete(id);
        if (!dirty.size) setSync("Live");
      })
      .catch((err) => setSync(err.code === "permission-denied" ? "Not saved: publish the Firestore rules" : "Not saved, check connection", true));
  }

  function flushAll() { Object.keys(timers).forEach((id) => pushTab(id)); }
  window.addEventListener("pagehide", flushAll);
  document.addEventListener("visibilitychange", () => { if (document.hidden) flushAll(); });

  /* ================= Presence ================= */
  const online = (p) => !!(p && p.seen && Date.now() - p.seen < 50000);

  function startPresence() {
    presCol = firebase.firestore().collection("fj-presence");
    presCol.onSnapshot((s) => { presence = {}; s.forEach((d) => (presence[d.id] = d.data())); renderPresence(); }, () => {});
    writePresence();
    setInterval(writePresence, 15000);
    setInterval(renderPresence, 10000);
    window.addEventListener("pagehide", () => presCol.doc(me).set({ seen: 0 }, { merge: true }));
  }

  function writePresence() {
    if (!presCol) return;
    lastPresWrite = Date.now();
    if (document.activeElement === ed) lastOff = caretOffset(ed);
    presCol.doc(me).set({ who: me, tab: activeId || null, off: lastOff, seen: Date.now(), session }).catch(() => {});
  }
  function schedulePresence() {
    if (!presCol || presPending) return;
    presPending = setTimeout(() => { presPending = null; writePresence(); }, Math.max(0, 1000 - (Date.now() - lastPresWrite)));
  }

  function renderPresence() {
    if (!shared) return;
    const box = $("presence");
    box.hidden = false;
    box.innerHTML = "";
    ["Jumper", "Froggy"].forEach((n) => {
      const on = n === me || online(presence[n]);
      const av = document.createElement("span");
      av.className = "av " + n.toLowerCase() + (on ? " on" : "");
      av.textContent = n[0];
      av.title = n === me ? n + " (you)" : n + (on ? " is online" : " is offline");
      box.appendChild(av);
    });
    const p = presence[other()];
    $("presence-text").textContent = online(p) ? other() + (p.tab === activeId ? " is on this page" : " is online") : other() + " is offline";
    if (dragFrom === null) renderTabs();
    renderRemoteCaret();
  }

  function renderRemoteCaret() {
    const el = $("remote-caret"), p = presence[other()];
    if (!shared || $("sheet").hidden || !online(p) || p.tab !== activeId || p.off == null) { el.hidden = true; return; }
    const w = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT);
    let n, c = 0, last = null, hit = null;
    while ((n = w.nextNode())) {
      last = n;
      if (c + n.length >= p.off) { hit = [n, p.off - c]; break; }
      c += n.length;
    }
    if (!hit && last) hit = [last, last.length];
    if (!hit) { el.hidden = true; return; }
    const r = document.createRange();
    r.setStart(hit[0], hit[1]); r.collapse(true);
    const rc = r.getClientRects()[0] || hit[0].parentElement.getBoundingClientRect();
    const pr = $("page").getBoundingClientRect();
    el.hidden = false;
    el.className = other().toLowerCase();
    el.firstChild.textContent = other();
    el.style.left = rc.left - pr.left + "px";
    el.style.top = rc.top - pr.top + "px";
    el.style.height = (rc.height || 20) + "px";
  }
  window.addEventListener("resize", renderRemoteCaret);

  /* ================= Spotify embed ================= */
  function embedUrl(link) {
    const m = (link || "").match(/open\.spotify\.com\/(?:intl-[a-z]+\/)?(playlist|album|track|episode|show|artist)\/([A-Za-z0-9]+)/);
    return m ? `https://open.spotify.com/embed/${m[1]}/${m[2]}` : null;
  }
  function renderEmbed(t) {
    const wrap = $("embed-wrap");
    const src = t && t.embed ? embedUrl(t.embed) : null;
    if (src === renderedEmbed) return;
    renderedEmbed = src;
    wrap.innerHTML = "";
    wrap.hidden = !src;
    if (!src) return;
    const f = document.createElement("iframe");
    f.src = src;
    f.height = src.includes("/playlist/") || src.includes("/album/") ? 352 : 152;
    f.allow = "autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture";
    f.loading = "lazy";
    wrap.appendChild(f);
  }

  /* ================= Rendering ================= */
  function render(full) {
    if (!cur()) activeId = tabs[0] ? tabs[0].id : null;
    if (activeId) localStorage.setItem(LS.active, activeId);
    renderTabs();
    const t = cur();
    $("sheet").hidden = !t;
    $("empty").hidden = !!t;
    if (t && full) {
      $("doc-title").value = t.title;
      ed.innerHTML = t.html || "<p><br></p>";
      normalizeEditor();
      pendingRange = null; activeCid = null;
      $("composer").hidden = true;
      renderedEmbed = undefined;
      renderEmbed(t);
      renderComments();
      schedulePresence();
    }
    if (!t) { renderedEmbed = undefined; renderEmbed(null); }
    renderRemoteCaret();
  }

  function renderTabs() {
    const nav = $("tabs");
    nav.innerHTML = "";
    const p = presence[other()];
    tabs.forEach((t, i) => {
      const row = document.createElement("div");
      row.className = "tab-row" + (t.id === activeId ? " active" : "");
      row.draggable = true;
      const b = document.createElement("button");
      b.className = "tab";
      b.textContent = t.title || "Untitled";
      b.onclick = () => { activeId = t.id; render(true); document.body.classList.remove("menu-open"); };
      row.appendChild(b);

      if (shared && online(p) && p.tab === t.id) {
        const h = document.createElement("span");
        h.className = "here " + other().toLowerCase();
        h.title = other() + " is here";
        row.appendChild(h);
      }
      if (t.id === activeId) {
        const mv = document.createElement("span");
        mv.className = "mv";
        [["Move up", "\u2191", -1], ["Move down", "\u2193", 1]].forEach(([title, ch, d]) => {
          const m = document.createElement("button");
          m.title = title; m.textContent = ch;
          m.disabled = i + d < 0 || i + d >= tabs.length;
          m.onclick = (e) => { e.stopPropagation(); moveTab(i, i + d); };
          mv.appendChild(m);
        });
        row.appendChild(mv);
      }
      row.addEventListener("dragstart", (e) => { dragFrom = i; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", t.id); });
      row.addEventListener("dragover", (e) => { e.preventDefault(); row.classList.add("over"); });
      row.addEventListener("dragleave", () => row.classList.remove("over"));
      row.addEventListener("drop", (e) => { e.preventDefault(); row.classList.remove("over"); if (dragFrom !== null) moveTab(dragFrom, i); dragFrom = null; });
      row.addEventListener("dragend", () => { dragFrom = null; renderTabs(); });
      nav.appendChild(row);
    });
  }

  function moveTab(from, to) {
    if (from === to || to < 0 || to >= tabs.length) return;
    tabs.splice(to, 0, tabs.splice(from, 1)[0]);
    tabs.forEach((t, i) => { if (t.order !== i) { t.order = i; touch(t); } });
    renderTabs();
  }

  /* ================= Tab actions ================= */
  $("new-tab").onclick = () => {
    const t = { id: uid(), title: "", html: "", embed: "", comments: [], updated: Date.now(), base: { html: "", title: "" },
      order: Math.max(-1, ...tabs.map((x) => x.order)) + 1 };
    tabs.push(t);
    activeId = t.id;
    touch(t);
    render(true);
    $("doc-title").focus();
    document.body.classList.remove("menu-open");
  };

  function deleteTab() {
    const t = cur();
    if (!t || !confirm(`Delete "${t.title || "Untitled"}"? This cannot be undone.`)) return;
    tabs = tabs.filter((x) => x.id !== t.id);
    clearTimeout(timers[t.id]); delete timers[t.id]; dirty.delete(t.id);
    activeId = null;
    if (shared) {
      setSync("Saving...");
      col.doc(t.id).delete().then(() => setSync("Live")).catch(() => setSync("Not saved, check connection", true));
    } else persistLocal();
    render(true);
  }

  $("doc-title").addEventListener("input", (e) => {
    const t = cur(); if (!t) return;
    t.title = e.target.value;
    renderTabs(); touch(t);
  });

  /* ================= Editor core ================= */
  try { document.execCommand("defaultParagraphSeparator", false, "p"); } catch (e) {}

  // Keep the document as a clean list of blocks, each with a stable id (needed for merging)
  function normalizeEditor() {
    const off = document.activeElement === ed ? caretOffset(ed) : null;
    [...ed.childNodes].forEach((n) => {
      if (n.nodeType === 3) {
        if (!n.textContent.trim() && !n.textContent.includes("\u00a0")) { n.remove(); return; }
        const p = document.createElement("p");
        n.replaceWith(p); p.appendChild(n);
      } else if (n.nodeType !== 1) n.remove();
    });
    let emptied = false;
    if (!ed.firstChild) { ed.innerHTML = "<p><br></p>"; emptied = true; }
    const seen = new Set();
    [...ed.children].forEach((el) => {
      if (!el.dataset.b || seen.has(el.dataset.b)) el.dataset.b = uid();
      seen.add(el.dataset.b);
    });
    if (emptied && document.activeElement === ed) placeCaret(ed.firstChild, false);
    else if (off !== null) setCaret(ed, off);
  }

  function sync() {
    const t = cur(); if (!t) return;
    normalizeEditor();
    ed.querySelectorAll("a:not([target])").forEach((a) => { a.target = "_blank"; a.rel = "noopener"; });
    t.html = ed.innerHTML;
    const before = t.comments.length;
    t.comments = t.comments.filter((c) => ed.querySelector(`.cmt[data-cid="${c.id}"]`));
    if (t.comments.length !== before) renderComments();
    touch(t);
    schedulePresence();
  }
  ed.addEventListener("input", sync);

  ed.addEventListener("change", (e) => {
    if (e.target.type !== "checkbox") return;
    e.target.toggleAttribute("checked", e.target.checked);
    sync();
  });

  ed.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); doLink(); return; }
    if (e.key !== "Enter" || e.shiftKey) return;
    const n = getSelection().anchorNode;
    const el = n && (n.nodeType === 1 ? n : n.parentElement);
    const todo = el && el.closest(".todo");
    if (!todo || !ed.contains(todo)) return;
    e.preventDefault();
    if (!todo.textContent.replace(/\u00a0/g, "").trim()) {
      const p = document.createElement("p");
      p.innerHTML = "<br>";
      todo.replaceWith(p);
      placeCaret(p, false);
    } else {
      const nu = document.createElement("div");
      nu.className = "todo";
      nu.innerHTML = '<input type="checkbox">\u00a0';
      todo.after(nu);
      placeCaret(nu, true);
    }
    sync();
  });

  ed.addEventListener("click", (e) => {
    const a = e.target.closest && e.target.closest("a");
    if (a && (e.ctrlKey || e.metaKey)) window.open(a.href, "_blank", "noopener");
    const c = e.target.closest && e.target.closest(".cmt");
    const next = c ? c.dataset.cid : null;
    if (next !== activeCid) { activeCid = next; renderComments(); }
  });

  /* ================= Selection helpers ================= */
  document.addEventListener("selectionchange", () => {
    const s = getSelection();
    if (s.rangeCount && ed.contains(s.anchorNode)) {
      savedRange = s.getRangeAt(0).cloneRange();
      updateToolbarState();
      lastOff = caretOffset(ed);
    }
    schedulePresence();
  });

  function restoreSel() {
    if (document.activeElement === ed) return;
    ed.focus();
    if (savedRange) { const s = getSelection(); s.removeAllRanges(); s.addRange(savedRange); }
  }

  const blockOf = (node) => {
    const el = node && (node.nodeType === 1 ? node : node.parentElement);
    const b = el && el.closest("p,div,h1,h2,h3,h4,li");
    return b && b !== ed && ed.contains(b) ? b : null;
  };

  function cmd(c, v) {
    restoreSel();
    document.execCommand("styleWithCSS", false, true);
    document.execCommand(c, false, v || null);
    sync();
  }

  function updateToolbarState() {
    const s = getSelection();
    const n = s.anchorNode;
    if (!n || !ed.contains(n)) return;
    const el = n.nodeType === 1 ? n : n.parentElement;
    const cs = getComputedStyle(el);
    if (document.activeElement !== $("size")) $("size").value = Math.round(parseFloat(cs.fontSize) * 0.75);
    $("font-label").textContent = cs.fontFamily.split(",")[0].replace(/["']/g, "").trim();
    const b = blockOf(n);
    $("style-label").textContent = ({ h1: "Title", h2: "Heading 1", h3: "Heading 2", h4: "Heading 3" })[b ? b.tagName.toLowerCase() : "p"] || "Normal text";
    ["bold", "italic", "underline"].forEach((c) => $("btn-" + c).classList.toggle("on", document.queryCommandState(c)));
  }

  /* ================= Ribbon actions ================= */
  const SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 72];

  function applySize(pt) {
    restoreSel();
    const s = getSelection();
    if (s.isCollapsed) {
      const b = blockOf(s.anchorNode);
      if (!b) return;
      s.selectAllChildren(b);
    }
    document.execCommand("styleWithCSS", false, false);
    document.execCommand("fontSize", false, "7");
    document.execCommand("styleWithCSS", false, true);
    ed.querySelectorAll('font[size="7"]').forEach((f) => {
      const sp = document.createElement("span");
      sp.style.fontSize = pt + "pt";
      while (f.firstChild) sp.appendChild(f.firstChild);
      sp.querySelectorAll("[style*='font-size']").forEach((x) => (x.style.fontSize = ""));
      f.replaceWith(sp);
    });
    $("size").value = pt;
    sync();
  }
  const stepSize = (dir) => {
    const c = parseInt($("size").value, 10) || 11;
    const next = dir > 0 ? SIZES.find((x) => x > c) || c : [...SIZES].reverse().find((x) => x < c) || c;
    applySize(next);
  };
  $("size").addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const v = Math.min(400, Math.max(1, parseInt($("size").value, 10) || 11));
    applySize(v);
  });

  function applyColor(kind, color) {
    restoreSel();
    document.execCommand("styleWithCSS", false, true);
    if (kind === "fore") {
      if (color === null) {
        document.execCommand("foreColor", false, "#010203");
        ed.querySelectorAll('[style*="rgb(1, 2, 3)"]').forEach((e) => (e.style.color = "var(--ink)"));
        ed.querySelectorAll('font[color="#010203"]').forEach((f) => { f.removeAttribute("color"); f.style.color = "var(--ink)"; });
      } else document.execCommand("foreColor", false, color);
      $("color-bar").style.background = color || "var(--ink)";
    } else {
      document.execCommand("hiliteColor", false, color || "transparent");
      $("hl-bar").style.background = color || "transparent";
    }
    sync();
  }

  function doLink() {
    const url = prompt("Link address:", "https://");
    if (!url || url === "https://") return;
    const href = /^(https?:|mailto:)/i.test(url) ? url : "https://" + url;
    restoreSel();
    if (getSelection().isCollapsed) document.execCommand("insertHTML", false, `<a href="${esc(href)}">${esc(href)}</a>`);
    else document.execCommand("createLink", false, href);
    sync();
  }

  function addCheck() {
    restoreSel();
    document.execCommand("insertHTML", false, '<div class="todo"><input type="checkbox">&nbsp;</div>');
    sync();
  }

  function setBlock(tag) { restoreSel(); document.execCommand("formatBlock", false, `<${tag}>`); sync(); }

  function setSpacing(v) {
    restoreSel();
    const s = getSelection();
    if (!s.rangeCount) return;
    const r = s.getRangeAt(0);
    ed.querySelectorAll("p,div,h1,h2,h3,h4,li").forEach((b) => { if (r.intersectsNode(b)) b.style.lineHeight = v; });
    sync();
  }

  function beginComment() {
    const t = cur(); if (!t) return;
    restoreSel();
    const sel = getSelection();
    if (!sel.rangeCount || sel.isCollapsed || !ed.contains(sel.anchorNode) || !ed.contains(sel.focusNode)) {
      alert("Select some text first, then add a comment.");
      return;
    }
    const r = sel.getRangeAt(0);
    if (r.cloneContents().querySelector("div,p,li,ul,ol,h1,h2,h3,h4")) {
      alert("Please select text within a single line or paragraph.");
      return;
    }
    pendingRange = r.cloneRange();
    $("comments").hidden = false;
    $("composer").hidden = false;
    $("comment-text").value = "";
    $("comment-text").focus();
  }

  function wordCount() {
    const txt = ed.innerText.trim();
    const words = txt ? txt.split(/\s+/).length : 0;
    alert(`Words: ${words}\nCharacters: ${txt.length}`);
  }

  function download(kind) {
    const t = cur(); if (!t) return;
    const name = (t.title || "Untitled").replace(/[^\w\- ]+/g, "") || "Untitled";
    const body = kind === "txt" ? ed.innerText
      : `<!DOCTYPE html><meta charset="utf-8"><title>${esc(t.title)}</title><body>${ed.innerHTML.replace(/ data-b="[^"]*"/g, "")}</body>`;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([body], { type: kind === "txt" ? "text/plain" : "text/html" }));
    a.download = name + "." + kind;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  const ACT = {
    undo: () => cmd("undo"), redo: () => cmd("redo"),
    bold: () => cmd("bold"), italic: () => cmd("italic"), underline: () => cmd("underline"),
    link: doLink, comment: beginComment,
    clear: () => { cmd("removeFormat"); setBlock("p"); },
    "size-": () => stepSize(-1), "size+": () => stepSize(1)
  };
  document.querySelectorAll("#toolbar [data-act]").forEach((b) => (b.onclick = () => ACT[b.dataset.act]()));
  document.querySelectorAll("#toolbar button, #menubar button").forEach((b) =>
    b.addEventListener("mousedown", (e) => e.preventDefault())); // keep the text selection

  /* ================= Icons ================= */
  const ICON = {
    undo: '<path d="M9 14L4 9l5-5M4 9h10a6 6 0 010 12h-3"/>',
    redo: '<path d="M15 14l5-5-5-5M20 9H10a6 6 0 000 12h3"/>',
    link: '<path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1"/>',
    comment: '<path d="M4 5h16v11H10l-6 4z"/>',
    "align-left": '<path d="M4 6h16M4 10h10M4 14h16M4 18h10"/>',
    bullets: '<path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/>',
    spacing: '<path d="M6 4v16M3 7l3-3 3 3M3 17l3 3 3-3M12 7h9M12 12h9M12 17h9"/>',
    clear: '<path d="M5 5h11M10 5L7 19M13 14l7 7M20 14l-7 7"/>',
    textcolor: '<path d="M6 17L12 4l6 13M8.5 12h7"/>',
    highlight: '<path d="M14 4l6 6-9 9H6v-5zM4 21h16"/>'
  };
  document.querySelectorAll("[data-icon]").forEach((b) =>
    b.insertAdjacentHTML("afterbegin",
      `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICON[b.dataset.icon]}</svg>`));

  /* ================= Dropdowns ================= */
  let pop = null;
  const closePop = () => { if (pop) { pop.remove(); pop = null; } };
  document.addEventListener("mousedown", (e) => { if (pop && !pop.contains(e.target) && !pop.anchor.contains(e.target)) closePop(); });
  window.addEventListener("resize", closePop);

  function openPop(anchor, build, cls) {
    if (pop && pop.anchor === anchor) { closePop(); return; }
    closePop();
    const el = document.createElement("div");
    el.className = "pop" + (cls ? " " + cls : "");
    el.addEventListener("mousedown", (e) => { if (!["INPUT", "LABEL"].includes(e.target.tagName)) e.preventDefault(); });
    build(el);
    document.body.appendChild(el);
    const r = anchor.getBoundingClientRect();
    el.style.top = r.bottom + 2 + "px";
    el.style.left = Math.max(4, Math.min(r.left, innerWidth - el.offsetWidth - 6)) + "px";
    el.anchor = anchor;
    pop = el;
  }

  function menuList(el, items) {
    items.forEach((it) => {
      if (it === "-") { const r = document.createElement("div"); r.className = "rule"; el.appendChild(r); return; }
      const b = document.createElement("button");
      b.className = "mi";
      const l = document.createElement("span");
      l.textContent = it.l;
      if (it.st) l.style.cssText = it.st;
      b.appendChild(l);
      if (it.s) { const k = document.createElement("span"); k.className = "key"; k.textContent = it.s; b.appendChild(k); }
      b.onclick = () => { closePop(); it.a(); };
      el.appendChild(b);
    });
  }

  const hex = (h, s, l) => {
    s /= 100; l /= 100;
    const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return "#" + [f(0), f(8), f(4)].map((x) => Math.round(x * 255).toString(16).padStart(2, "0")).join("");
  };
  const HUES = [0, 28, 50, 120, 175, 215, 255, 280, 310, 335];
  const COLORS = [
    "#8a2335", "#b13a4d", "#d6586a", "#e8909c", "#f6d3d9", "#3f2a74", "#5b3fa3", "#7c5cc4", "#a98ce6", "#e6dcf7",
    "#000000", "#434343", "#666666", "#999999", "#b7b7b7", "#cccccc", "#d9d9d9", "#efefef", "#f3f3f3", "#ffffff",
    ...HUES.map((h) => hex(h, 100, 50)),
    ...[85, 70, 55, 40, 25].flatMap((L) => HUES.map((h) => hex(h, 70, L)))
  ];

  function palette(kind) {
    return (el) => {
      const auto = document.createElement("button");
      auto.className = "auto";
      auto.textContent = kind === "fore" ? "Default text colour" : "No highlight";
      auto.onclick = () => { closePop(); applyColor(kind, null); };
      const grid = document.createElement("div");
      grid.className = "grid";
      COLORS.forEach((c) => {
        const s = document.createElement("button");
        s.className = "sw"; s.style.background = c; s.title = c;
        s.onclick = () => { closePop(); applyColor(kind, c); };
        grid.appendChild(s);
      });
      const custom = document.createElement("label");
      custom.innerHTML = '<input type="color" value="#7c5cc4"> Custom colour';
      custom.firstChild.onchange = (e) => { closePop(); applyColor(kind, e.target.value); };
      el.append(auto, grid, custom);
    };
  }

  const STYLES = [
    ["Normal text", "p", ""],
    ["Title", "h1", "font:400 1.9rem 'Instrument Serif',serif"],
    ["Heading 1", "h2", "font-size:1.35rem;font-weight:600"],
    ["Heading 2", "h3", "font-size:1.15rem;font-weight:600"],
    ["Heading 3", "h4", "font-weight:600;color:var(--muted)"]
  ];
  const FONTS = ["Bricolage Grotesque", "Instrument Serif", "Fraunces", "Lora", "Playfair Display", "DM Serif Display", "Syne",
    "Fredoka", "Caveat", "Space Mono", "Arial", "Georgia", "Times New Roman", "Courier New", "Verdana"];

  $("style-btn").onclick = (e) => openPop(e.currentTarget, (el) => menuList(el, STYLES.map(([l, t, st]) => ({ l, st, a: () => setBlock(t) }))));
  $("font-btn").onclick = (e) => openPop(e.currentTarget, (el) => menuList(el, FONTS.map((f) => ({
    l: f, st: `font-family:'${f}'`, a: () => { restoreSel(); document.execCommand("styleWithCSS", false, true); document.execCommand("fontName", false, f); sync(); }
  }))));
  $("color-btn").onclick = (e) => openPop(e.currentTarget, palette("fore"), "pal");
  $("hl-btn").onclick = (e) => openPop(e.currentTarget, palette("back"), "pal");
  $("align-btn").onclick = (e) => openPop(e.currentTarget, (el) => menuList(el, [
    { l: "Align left", s: "Ctrl+Shift+L", a: () => cmd("justifyLeft") },
    { l: "Centre", s: "Ctrl+Shift+E", a: () => cmd("justifyCenter") },
    { l: "Align right", s: "Ctrl+Shift+R", a: () => cmd("justifyRight") },
    { l: "Justify", s: "Ctrl+Shift+J", a: () => cmd("justifyFull") },
    "-",
    { l: "Increase indent", a: () => cmd("indent") },
    { l: "Decrease indent", a: () => cmd("outdent") }
  ]));
  $("list-btn").onclick = (e) => openPop(e.currentTarget, (el) => menuList(el, [
    { l: "Bulleted list", a: () => cmd("insertUnorderedList") },
    { l: "Numbered list", a: () => cmd("insertOrderedList") },
    { l: "Checklist", a: addCheck }
  ]));
  $("spacing-btn").onclick = (e) => openPop(e.currentTarget, (el) => menuList(el,
    [["Single", "1.15"], ["1.5", "1.6"], ["Double", "2.1"], ["Tight", "1"]].map(([l, v]) => ({ l, a: () => setSpacing(v) }))));

  const MENUS = {
    file: () => [
      { l: "New tab", a: () => $("new-tab").click() },
      { l: "Download as text (.txt)", a: () => download("txt") },
      { l: "Download as web page (.html)", a: () => download("html") },
      { l: "Print", s: "Ctrl+P", a: () => window.print() },
      "-",
      { l: "Delete this tab", a: deleteTab }
    ],
    edit: () => [
      { l: "Undo", s: "Ctrl+Z", a: () => cmd("undo") },
      { l: "Redo", s: "Ctrl+Y", a: () => cmd("redo") },
      "-",
      { l: "Select all", s: "Ctrl+A", a: () => { ed.focus(); document.execCommand("selectAll"); } }
    ],
    view: () => [
      { l: document.documentElement.getAttribute("data-theme") === "dark" ? "Light mode" : "Dark mode", a: toggleTheme },
      { l: "Full screen", a: () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()) }
    ],
    insert: () => [
      { l: "Link", s: "Ctrl+K", a: doLink },
      { l: "Comment", a: beginComment },
      { l: "Checklist", a: addCheck },
      { l: "Horizontal line", a: () => cmd("insertHorizontalRule") },
      { l: "Today's date", a: () => cmd("insertText", new Date().toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })) }
    ],
    format: () => [
      { l: "Bold", s: "Ctrl+B", a: ACT.bold },
      { l: "Italic", s: "Ctrl+I", a: ACT.italic },
      { l: "Underline", s: "Ctrl+U", a: ACT.underline },
      { l: "Strikethrough", a: () => cmd("strikeThrough") },
      { l: "Superscript", a: () => cmd("superscript") },
      { l: "Subscript", a: () => cmd("subscript") },
      "-",
      { l: "Clear formatting", a: ACT.clear }
    ],
    tools: () => [{ l: "Word count", a: wordCount }]
  };
  document.querySelectorAll("#menubar [data-menu]").forEach((b) =>
    (b.onclick = () => openPop(b, (el) => menuList(el, MENUS[b.dataset.menu]()))));

  /* ================= Comments ================= */
  $("composer").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = $("comment-text").value.trim();
    const t = cur();
    if (!text || !pendingRange || !t) return;
    const id = uid();
    const span = document.createElement("span");
    span.className = "cmt";
    span.dataset.cid = id;
    span.appendChild(pendingRange.extractContents());
    pendingRange.insertNode(span);
    t.comments.push({ id, text, who: me, time: Date.now() });
    pendingRange = null;
    $("composer").hidden = true;
    activeCid = id;
    sync();
    renderComments();
  });
  $("comment-cancel").onclick = () => { pendingRange = null; $("composer").hidden = true; renderComments(); };

  function renderComments() {
    const t = cur();
    const list = $("comment-list");
    list.innerHTML = "";
    const items = t ? t.comments.filter((c) => ed.querySelector(`.cmt[data-cid="${c.id}"]`)) : [];
    $("comments").hidden = !items.length && $("composer").hidden;
    items.forEach((c) => {
      const card = document.createElement("div");
      card.className = "comment" + (c.id === activeCid ? " active" : "");
      const head = document.createElement("div");
      head.className = "chead";
      const who = document.createElement("strong");
      who.textContent = c.who || "";
      const when = document.createElement("span");
      when.textContent = new Date(c.time).toLocaleDateString(undefined, { day: "numeric", month: "short" });
      head.append(who, when);
      const body = document.createElement("p");
      body.textContent = c.text;
      const res = document.createElement("button");
      res.className = "small";
      res.textContent = "Resolve";
      res.onclick = (e) => {
        e.stopPropagation();
        const s = ed.querySelector(`.cmt[data-cid="${c.id}"]`);
        if (s) { while (s.firstChild) s.parentNode.insertBefore(s.firstChild, s); s.remove(); ed.normalize(); }
        t.comments = t.comments.filter((x) => x.id !== c.id);
        if (activeCid === c.id) activeCid = null;
        sync(); renderComments();
      };
      card.append(head, body, res);
      card.onclick = () => {
        activeCid = c.id;
        const s = ed.querySelector(`.cmt[data-cid="${c.id}"]`);
        if (s) s.scrollIntoView({ block: "center", behavior: "smooth" });
        renderComments();
      };
      list.appendChild(card);
    });
    let st = $("active-style");
    if (!st) { st = document.createElement("style"); st.id = "active-style"; document.head.appendChild(st); }
    st.textContent = activeCid ? `.cmt[data-cid="${activeCid}"]{background:var(--cmt-active) !important}` : "";
  }

  $("menu-btn").onclick = () => document.body.classList.toggle("menu-open");

  /* ================= Auto sign-in on refresh (kept last) ================= */
  if (shared) {
    initFirebase();
    firebase.auth().onAuthStateChanged((u) => { if (u) start(); });
  } else if (sessionStorage.getItem(LS.auth)) {
    start();
  }
})();
