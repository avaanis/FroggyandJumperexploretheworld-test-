(() => {
  const $ = (id) => document.getElementById(id);
  const LS_DATA = "fj_data_v1", LS_AUTH = "fj_unlocked", LS_THEME = "fj_theme", LS_WHO = "fj_who", LS_ACTIVE = "fj_active";
  const shared = typeof FIREBASE_CONFIG !== "undefined" && FIREBASE_CONFIG;
  const LEGACY_TEXT = "<p>Songs that belong to us. Add notes, memories or song dedications below.</p>";
  const session = Math.random().toString(36).slice(2); // identifies this open page, so we ignore our own echoes

  let tabs = [], activeId = localStorage.getItem(LS_ACTIVE);
  let col = null, firstLoad = true, started = false;
  const dirty = new Set(), timers = {};
  let renderedEmbed = null, pendingRange = null, activeCid = null, dragFrom = null;

  const uid = () => Math.random().toString(36).slice(2, 9);
  const norm = (s) => s.trim().toLowerCase();
  const sha256 = async (t) =>
    [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)))]
      .map((b) => b.toString(16).padStart(2, "0")).join("");
  const cur = () => tabs.find((t) => t.id === activeId);
  const setStatus = (m) => ($("sync-status").textContent = m);
  const byOrder = (a, b) => a.order - b.order || a.updated - b.updated;
  const normalize = (t, i) => ({
    id: t.id || uid(), title: t.title || "", html: t.html || "", embed: t.embed || "",
    comments: Array.isArray(t.comments) ? t.comments : [],
    order: typeof t.order === "number" ? t.order : i, updated: t.updated || 0
  });
  const clean = (t) => { if (t.html === LEGACY_TEXT) t.html = ""; return t; }; // removes the old playlist-tab writing
  const seedTab = () => ({ id: "playlist", title: "Our Playlist", html: "", embed: SEED_PLAYLIST, comments: [], order: -1, updated: Date.now() });
  const toDoc = (t) => ({ title: t.title, html: t.html, embed: t.embed, comments: t.comments, order: t.order, updated: t.updated, by: session });

  /* ---------- Theme ---------- */
  function setTheme(t) {
    document.documentElement.setAttribute("data-theme", t);
    localStorage.setItem(LS_THEME, t);
    $("theme-toggle").textContent = t === "dark" ? "Light mode" : "Dark mode";
  }
  setTheme(document.documentElement.getAttribute("data-theme"));
  $("theme-toggle").onclick = () =>
    setTheme(document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark");

  /* ---------- Login ---------- */
  $("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const pw = norm($("pw").value);
    $("login-error").hidden = true;
    try {
      if (shared) {
        if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
        await firebase.auth().signInWithEmailAndPassword(SHARED_EMAIL, pw);
      } else if ((await sha256(pw)) !== PASSWORD_HASH) {
        throw new Error("bad password");
      } else {
        sessionStorage.setItem(LS_AUTH, "1");
      }
      start();
    } catch (err) {
      $("login-error").hidden = false;
      $("pw").select();
    }
  });

  $("logout").addEventListener("click", async () => {
    flushAll();
    sessionStorage.removeItem(LS_AUTH);
    if (shared && firebase.apps.length) await firebase.auth().signOut();
    location.reload();
  });

  /* ---------- Start ---------- */
  function start() {
    if (started) return;
    started = true;
    $("login").hidden = true;
    $("app").hidden = false;
    $("pw").value = "";
    $("who").value = localStorage.getItem(LS_WHO) || "Jumper";

    if (shared) {
      col = firebase.firestore().collection("fj-tabs");
      setStatus("Connecting...");
      col.onSnapshot(onRemote, () => setStatus("Cannot connect"));
    } else {
      let local = null;
      try { local = JSON.parse(localStorage.getItem(LS_DATA)); } catch {}
      tabs = ((local && local.tabs) || []).map(normalize).map(clean);
      if (!(local && local.seeded)) tabs.unshift(seedTab());
      tabs.sort(byOrder).forEach((t, i) => (t.order = i));
      persistLocal();
      setStatus("Saved on this device only");
      finishLoad();
    }
  }

  function finishLoad() {
    if (!cur()) activeId = tabs[0] ? tabs[0].id : null;
    render(true);
  }

  /* ---------- Live sync (shared mode) ---------- */
  function onRemote(snap) {
    let listChanged = false, activeChanged = false;
    snap.docChanges().forEach((ch) => {
      const id = ch.doc.id;
      if (ch.doc.metadata.hasPendingWrites) return;           // our own write, not yet confirmed
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
      if (t && (d.by === session || dirty.has(id))) return;   // our own change, or we have newer unsent edits
      const next = clean(normalize(Object.assign({}, d, { id }), 0));
      if (!t) { tabs.push(next); listChanged = true; return; }
      const diff = ["title", "html", "embed"].some((k) => t[k] !== next[k]) ||
        JSON.stringify(t.comments) !== JSON.stringify(next.comments);
      if (diff || t.order !== next.order) listChanged = true;
      if (diff && id === activeId) activeChanged = true;
      Object.assign(t, next);
    });
    tabs.sort(byOrder);

    if (firstLoad) {
      firstLoad = false;
      if (snap.empty) seedShared();
      setStatus("Saved");
      finishLoad();
      return;
    }
    if (!cur()) { activeId = tabs[0] ? tabs[0].id : null; render(true); return; }
    if (listChanged) renderTabs();
    if (activeChanged) applyActive();
  }

  // First ever run on a fresh database: playlist tab, or import older lists
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
      } catch {}
      if (!list.length) { try { list = JSON.parse(localStorage.getItem(LS_DATA)).tabs || []; } catch {} }
      if (!list.length) list = [seedTab()];
      list.forEach((t, i) => {
        const n = clean(normalize(t, i));
        n.order = i;
        db.collection("fj-tabs").doc(n.id).set(toDoc(n));
      });
    } catch (e) { setStatus("Setup problem, check Firebase rules"); }
  }

  // Apply a partner's edit to the page we are looking at, without losing our cursor
  function applyActive() {
    const t = cur(); if (!t) return;
    const ed = $("editor");
    if (document.activeElement !== $("doc-title")) $("doc-title").value = t.title;
    if (ed.innerHTML !== t.html) {
      const off = document.activeElement === ed ? caretOffset(ed) : null;
      ed.innerHTML = t.html;
      if (off !== null) setCaret(ed, off);
    }
    renderEmbed(t);
    renderComments();
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

  /* ---------- Saving: every change is written straight away ---------- */
  function persistLocal() {
    try { localStorage.setItem(LS_DATA, JSON.stringify({ tabs, seeded: true })); } catch {}
  }

  function touch(t) {
    t.updated = Date.now();
    if (!shared) { persistLocal(); setStatus("Saved on this device only"); return; }
    dirty.add(t.id);
    setStatus("Saving...");
    clearTimeout(timers[t.id]);
    timers[t.id] = setTimeout(() => pushTab(t.id), 200);
  }

  function pushTab(id) {
    clearTimeout(timers[id]); delete timers[id];
    const t = tabs.find((x) => x.id === id);
    if (!t || !dirty.has(id)) return;
    const stamp = t.updated;
    col.doc(id).set(toDoc(t))
      .then(() => { if (t.updated === stamp) dirty.delete(id); if (!dirty.size) setStatus("Saved"); })
      .catch(() => setStatus("Not saved, check connection"));
  }

  function flushAll() { Object.keys(timers).forEach(pushTab); }
  window.addEventListener("pagehide", flushAll);
  document.addEventListener("visibilitychange", () => { if (document.hidden) flushAll(); });

  /* ---------- Spotify embed ---------- */
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

  /* ---------- Rendering ---------- */
  function render(full) {
    if (!cur()) activeId = tabs[0] ? tabs[0].id : null;
    if (activeId) localStorage.setItem(LS_ACTIVE, activeId);
    renderTabs();
    const t = cur();
    $("sheet").hidden = !t;
    $("empty").hidden = !!t;
    $("delete-tab").disabled = !t;
    if (t && full) {
      $("doc-title").value = t.title;
      $("editor").innerHTML = t.html;
      pendingRange = null; activeCid = null;
      $("composer").hidden = true;
      renderedEmbed = undefined;
      renderEmbed(t);
      renderComments();
    }
    if (!t) { renderedEmbed = undefined; renderEmbed(null); }
  }

  function renderTabs() {
    const nav = $("tabs");
    nav.innerHTML = "";
    tabs.forEach((t, i) => {
      const row = document.createElement("div");
      row.className = "tab-row" + (t.id === activeId ? " active" : "");
      row.draggable = true;

      const b = document.createElement("button");
      b.className = "tab";
      b.textContent = t.title || "Untitled";
      b.onclick = () => { activeId = t.id; render(true); document.body.classList.remove("menu-open"); };
      row.appendChild(b);

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

  /* ---------- Tab actions ---------- */
  $("new-tab").onclick = () => {
    const t = { id: uid(), title: "", html: "", embed: "", comments: [], updated: Date.now(),
      order: Math.max(-1, ...tabs.map((x) => x.order)) + 1 };
    tabs.push(t);
    activeId = t.id;
    touch(t);
    render(true);
    $("doc-title").focus();
    document.body.classList.remove("menu-open");
  };

  $("delete-tab").onclick = () => {
    const t = cur();
    if (!t || !confirm(`Delete "${t.title || "Untitled"}"? This cannot be undone.`)) return;
    tabs = tabs.filter((x) => x.id !== t.id);
    clearTimeout(timers[t.id]); delete timers[t.id]; dirty.delete(t.id);
    activeId = null;
    if (shared) { col.doc(t.id).delete().then(() => setStatus("Saved")).catch(() => setStatus("Not saved, check connection")); setStatus("Saving..."); }
    else persistLocal();
    render(true);
  };

  $("doc-title").addEventListener("input", (e) => {
    const t = cur(); if (!t) return;
    t.title = e.target.value;
    renderTabs(); touch(t);
  });

  function sync() {
    const t = cur(); if (!t) return;
    t.html = $("editor").innerHTML;
    const before = t.comments.length;
    t.comments = t.comments.filter((c) => $("editor").querySelector(`.cmt[data-cid="${c.id}"]`));
    if (t.comments.length !== before) renderComments();
    touch(t);
  }
  $("editor").addEventListener("input", sync);

  /* ---------- Toolbar ---------- */
  document.querySelectorAll("#toolbar [data-cmd]").forEach((b) =>
    b.addEventListener("mousedown", (e) => { e.preventDefault(); document.execCommand(b.dataset.cmd); sync(); })
  );

  $("add-check").addEventListener("mousedown", (e) => {
    e.preventDefault();
    document.execCommand("insertHTML", false, '<div class="todo"><input type="checkbox">&nbsp;</div>');
    sync();
  });

  $("block").addEventListener("change", (e) => {
    $("editor").focus();
    document.execCommand("formatBlock", false, e.target.value);
    sync();
  });

  $("color").addEventListener("change", (e) => {
    $("editor").focus();
    const v = e.target.value;
    if (v === "default") document.execCommand("removeFormat");
    else if (v) document.execCommand("foreColor", false, v);
    e.target.value = "";
    sync();
  });

  const HL = { red: "rgba(214,88,106,0.38)", purple: "rgba(124,92,196,0.38)", none: "transparent" };
  document.querySelectorAll("[data-hl]").forEach((b) =>
    b.addEventListener("mousedown", (e) => {
      e.preventDefault();
      document.execCommand("styleWithCSS", false, true);
      document.execCommand("hiliteColor", false, HL[b.dataset.hl]);
      sync();
    })
  );

  $("editor").addEventListener("change", (e) => {
    if (e.target.type !== "checkbox") return;
    e.target.toggleAttribute("checked", e.target.checked);
    sync();
  });

  /* ---------- Comments ---------- */
  $("add-comment").addEventListener("mousedown", (e) => {
    e.preventDefault();
    const t = cur(); if (!t) return;
    const sel = getSelection();
    const ed = $("editor");
    if (!sel.rangeCount || sel.isCollapsed || !ed.contains(sel.anchorNode) || !ed.contains(sel.focusNode)) {
      alert("Select some text first, then click Comment.");
      return;
    }
    const r = sel.getRangeAt(0);
    if (r.cloneContents().querySelector("div,p,li,ul,ol,h2,h3")) {
      alert("Please select text within a single line or paragraph.");
      return;
    }
    pendingRange = r.cloneRange();
    $("comments").hidden = false;
    $("composer").hidden = false;
    $("comment-text").value = "";
    $("comment-text").focus();
  });

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
    t.comments.push({ id, text, who: $("who").value, time: Date.now() });
    localStorage.setItem(LS_WHO, $("who").value);
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
    const items = t ? t.comments.filter((c) => $("editor").querySelector(`.cmt[data-cid="${c.id}"]`)) : [];
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
        const s = $("editor").querySelector(`.cmt[data-cid="${c.id}"]`);
        if (s) { while (s.firstChild) s.parentNode.insertBefore(s.firstChild, s); s.remove(); $("editor").normalize(); }
        t.comments = t.comments.filter((x) => x.id !== c.id);
        if (activeCid === c.id) activeCid = null;
        sync(); renderComments();
      };
      card.append(head, body, res);
      card.onclick = () => {
        activeCid = c.id;
        const s = $("editor").querySelector(`.cmt[data-cid="${c.id}"]`);
        if (s) s.scrollIntoView({ block: "center", behavior: "smooth" });
        renderComments();
      };
      list.appendChild(card);
    });

    let st = $("active-style");
    if (!st) { st = document.createElement("style"); st.id = "active-style"; document.head.appendChild(st); }
    st.textContent = activeCid ? `.cmt[data-cid="${activeCid}"]{background:var(--cmt-active) !important}` : "";
  }

  $("editor").addEventListener("click", (e) => {
    const c = e.target.closest && e.target.closest(".cmt");
    const next = c ? c.dataset.cid : null;
    if (next !== activeCid) { activeCid = next; renderComments(); }
  });

  $("menu-btn").onclick = () => document.body.classList.toggle("menu-open");

  /* ---------- Stay logged in on refresh (kept last so everything above exists) ---------- */
  if (shared) {
    firebase.initializeApp(FIREBASE_CONFIG);
    firebase.auth().onAuthStateChanged((u) => { if (u) start(); });
  } else if (sessionStorage.getItem(LS_AUTH)) {
    start();
  }
})();
