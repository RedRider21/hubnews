'use strict';

const API = window.HUBNEWS_API || new URLSearchParams(location.search).get('api') || 'api.php';
const DB_NAME = 'hubnews';
const DB_VERSION = 2;
const STORE_NAME = 'stories';
const TR_STORE = 'translations';
const HN_CACHE_TTL = 10 * 60 * 1000;
const CF_STORE = 'customFeeds';
const CF_PALETTE = ['#5b8cff', '#f59e0b', '#14b8a6', '#ec4899', '#84cc16', '#f97316', '#6366f1', '#e11d48'];

let db = null;
let channels = [];
let activeKey = 'hackernews';
let autoRefreshTimer = null;
let hnStories = [];
let currentItems = [];
let googleBlocked = false;
let articleI18n = null; // stato originale/traduzione del corpo articolo nel reader
let pendingStory = null; // story HN corrente, per aprire l'articolo con i commenti

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── Utilità ── */

async function fetchJSON(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.json();
}

function timeAgo(timestamp) {
    const seconds = Math.floor(Date.now() / 1000) - timestamp;
    if (seconds < 60) return `${seconds}s fa`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m fa`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h fa`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}g fa`;
    return new Date(timestamp * 1000).toLocaleDateString('it-IT');
}

function getDomain(url) {
    if (!url) return null;
    try {
        return new URL(url).hostname.replace('www.', '');
    } catch {
        return null;
    }
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function escapeAttr(text) {
    return escapeHtml(text).replace(/"/g, '&quot;');
}

function stripHtml(text) {
    const div = document.createElement('div');
    div.innerHTML = text || '';
    return div.textContent || '';
}

function updateStatus(msg) {
    $('status-text').textContent = msg;
}

/* ── Feed personalizzati (localStorage) ── */

function loadCustomFeeds() {
    try {
        return JSON.parse(localStorage.getItem(CF_STORE)) || [];
    } catch {
        return [];
    }
}

function saveCustomFeeds(list) {
    try {
        localStorage.setItem(CF_STORE, JSON.stringify(list));
    } catch {
        /* storage pieno o non disponibile: ignora */
    }
}

function customChannel() {
    const feeds = loadCustomFeeds();
    if (!feeds.length) return null;
    return {
        key: 'custom', label: 'Personalizzati', icon: '📌', color: '#5b8cff',
        description: 'Feed RSS/Atom aggiunti da te',
        custom: true, sources: feeds.map((f) => f.name || getDomain(f.url) || f.url),
    };
}

function nextCFColor(i) {
    return CF_PALETTE[i % CF_PALETTE.length];
}

function showError(target, message) {
    $(target).innerHTML = `<div class="error-msg">${escapeHtml(message)}</div>`;
}

/* ── IndexedDB ── */

function openDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'id' });
            }
            if (!db.objectStoreNames.contains(TR_STORE)) {
                db.createObjectStore(TR_STORE, { keyPath: 't' });
            }
        };
        req.onsuccess = (e) => resolve(e.target.result);
        req.onerror = (e) => reject(e.target.error);
    });
}

function idbReq(store, mode, op) {
    return new Promise((resolve, reject) => {
        if (!db) return resolve(null);
        const tx = db.transaction(store, mode);
        const req = op(tx.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

const dbGet = (id) => idbReq(STORE_NAME, 'readonly', (s) => s.get(id));
const dbGetAll = async () => {
    const rows = (await idbReq(STORE_NAME, 'readonly', (s) => s.getAll())) || [];
    const list = rows.filter((r) => r && !r.deleted && !r.dead);
    list.sort((a, b) => (b.time || 0) - (a.time || 0));
    return list;
};
const dbPut = (item) => idbReq(STORE_NAME, 'readwrite', (s) => s.put({ ...item, _cachedAt: Date.now() }));
const trGet = (text) => idbReq(TR_STORE, 'readonly', (s) => s.get(text));
const trSet = (text, tr) => idbReq(TR_STORE, 'readwrite', (s) => s.put({ t: text, tr, _at: Date.now() }));

async function getStory(id) {
    const cached = await dbGet(id);
    if (cached && (Date.now() - cached._cachedAt) < HN_CACHE_TTL) {
        return cached;
    }
    const item = await fetchJSON(`${API}?action=item&id=${id}`);
    await dbPut(item);
    return item;
}

/* ── Traduzione client-side (Google Translate, fallback MyMemory) ── */

async function translateGoogle(text) {
    if (googleBlocked) return null;
    try {
        const resp = await fetch(
            'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=it&dt=t&q=' +
            encodeURIComponent(text)
        );
        if (resp.status === 429) {
            googleBlocked = true; // Google ci ha limitati: d'ora in poi usa MyMemory
            return null;
        }
        if (!resp.ok) return null;
        const data = await resp.json();
        if (!Array.isArray(data) || !Array.isArray(data[0])) return null;
        let out = '';
        for (const seg of data[0]) {
            if (seg && seg[0]) out += seg[0];
        }
        return out || null;
    } catch {
        return null;
    }
}

async function translateMymemory(text) {
    try {
        const resp = await fetch(
            'https://api.mymemory.translated.net/get?langpair=en|it&q=' + encodeURIComponent(text)
        );
        if (!resp.ok) return null;
        const data = await resp.json();
        const tr = data && data.responseData && data.responseData.translatedText;
        if (!tr || /MYMEMORY WARNING/i.test(tr)) return null;
        return tr;
    } catch {
        return null;
    }
}

async function translateText(text) {
    if (!text) return text;
    const cached = await trGet(text);
    if (cached) return cached.tr;
    const tr = (await translateGoogle(text)) || (await translateMymemory(text));
    if (tr) {
        await trSet(text, tr);
        return tr;
    }
    return text;
}

/** Traduce testi lunghi spezzandoli in blocchi, preservando la punteggiatura. */
async function translateLongText(text) {
    const MAX = 350; // sotto i limiti per richiesta di MyMemory
    if (text.length <= MAX) return translateText(text);
    const parts = [];
    let cur = '';
    for (const chunk of text.split(/(?<=[.!?…])\s+/)) {
        if (cur && (cur + ' ' + chunk).trim().length > MAX) {
            parts.push(cur.trim());
            cur = chunk;
        } else {
            cur = (cur + ' ' + chunk).trim();
        }
    }
    if (cur) parts.push(cur.trim());
    if (parts.length <= 1) return translateText(text);
    const translated = [];
    for (const p of parts) {
        const tr = await translateText(p);
        translated.push(tr && tr !== p ? tr : p);
    }
    return translated.join(' ');
}

/** Traduce una lista di stringhe (Google prima, MyMemory come ripiego), con cache e rate-limit. */
async function translateBatch(texts, onProgress) {
    const out = new Map();
    const todo = [];
    for (const t of texts) {
        const c = await trGet(t);
        if (c) out.set(t, c.tr);
        else todo.push(t);
    }
    let done = 0;
    for (let i = 0; i < todo.length; i += 4) {
        const batch = todo.slice(i, i + 4);
        const results = await Promise.all(batch.map((t) => translateGoogle(t)));
        for (let j = 0; j < batch.length; j++) {
            let tr = results[j];
            if (!tr) tr = await translateMymemory(batch[j]);
            if (tr) {
                out.set(batch[j], tr);
                await trSet(batch[j], tr);
            }
        }
        done += batch.length;
        if (onProgress) onProgress(done, todo.length);
        if (i + 4 < todo.length) await sleep(220);
    }
    return out;
}

/* ── Sanitizzazione del contenuto articolo (reader) ── */

function sanitizeHtml(html) {
    const allowed = new Set(['P', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE', 'CODE', 'FIGURE', 'BR', 'STRONG', 'EM', 'B', 'I', 'A', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'SPAN', 'DIV', 'IMG']);
    const imgAttrs = new Set(['src', 'srcset', 'alt', 'title']);
    const doc = new DOMParser().parseFromString(html || '', 'text/html');
    function clean(node) {
        for (const child of [...node.children]) {
            const tag = child.tagName;
            if (!allowed.has(tag) || tag === 'SCRIPT' || tag === 'IFRAME' || tag === 'FORM') {
                while (child.firstChild) node.insertBefore(child.firstChild, child);
                child.remove();
                continue;
            }
            for (const attr of [...child.attributes]) {
                const name = attr.name.toLowerCase();
                if (name.startsWith('on') || /javascript:/i.test(attr.value)) {
                    child.removeAttribute(attr.name);
                } else if (tag === 'IMG' && !imgAttrs.has(name)) {
                    // img: via gli hack (style absolute, srcset gigante, data-*, classi)
                    child.removeAttribute(attr.name);
                }
            }
            if (tag === 'A') {
                child.setAttribute('target', '_blank');
                child.setAttribute('rel', 'noopener');
            }
            clean(child);
        }
    }
    clean(doc.body);
    // Sweep finale: rimuove gli elementi non consentiti "promossi" dagli unwrap
    for (const el of doc.body.querySelectorAll('*')) {
        if (!allowed.has(el.tagName)) el.remove();
    }
    return doc.body.innerHTML;
}

/* ── Canali / tab ── */

function renderTabs() {
    const nav = $('channels-nav');
    const custom = customChannel();
    const list = custom ? [...channels, custom] : channels;
    nav.innerHTML = list.map((ch) => `
        <button class="channel-tab ${ch.key === activeKey ? 'active' : ''}"
                data-key="${escapeAttr(ch.key)}" style="--c:${ch.color}" role="tab">
            <span class="tab-icon">${ch.icon}</span>
            <span class="tab-label">${escapeHtml(ch.label)}</span>
        </button>`).join('');
    nav.querySelectorAll('.channel-tab').forEach((btn) =>
        btn.addEventListener('click', () => selectChannel(btn.dataset.key)));
}

async function selectChannel(key) {
    if (key === activeKey) return;
    activeKey = key;
    renderTabs();
    showList();
    if (key === 'hackernews') await loadHN();
    else if (key === 'custom') await loadCustomFeedChannel();
    else await loadFeed(key);
}

function renderListHeader(title, icon, color, description) {
    $('list-header').innerHTML = `
        <div class="list-title" style="--c:${color}">
            <span class="list-icon">${icon}</span>${escapeHtml(title)}
        </div>
        ${description ? `<div class="list-desc">${escapeHtml(description)}</div>` : ''}`;
}

/* ── Skeleton loading ── */

function showSkeleton(target, count = 8) {
    $(target).innerHTML = Array.from({ length: count }, () => `
        <div class="card-skeleton">
            <div class="sk sk-thumb"></div>
            <div class="sk-body">
                <div class="sk sk-line" style="width:85%"></div>
                <div class="sk sk-line" style="width:55%"></div>
                <div class="sk sk-meta"></div>
            </div>
        </div>`).join('');
}

/* ── Feed dei canali ── */

async function loadFeed(key) {
    const conf = channels.find((c) => c.key === key);
    renderListHeader(conf.label, conf.icon, conf.color, conf.description);
    showSkeleton('story-list', 8);
    try {
        const data = await fetchJSON(`${API}?action=feed&channel=${key}&limit=45`);
        const items = data.items || [];
        currentItems = items;
        renderFeedCards(items, conf);

        // Traduzione titoli (solo fonti non italiane, primi 24 per non saturare la quota)
        const seen = new Set();
        const toTranslate = items
            .filter((it) => it.lang !== 'it' && it.title)
            .map((it) => it.title)
            .filter((t) => (seen.has(t) ? false : (seen.add(t), true)))
            .slice(0, 24);

        if (toTranslate.length) {
            updateStatus(`Traduzione titoli… (0 / ${toTranslate.length})`);
            const trMap = await translateBatch(toTranslate, (done, total) =>
                updateStatus(`Traduzione titoli… (${done} / ${total})`));
            items.forEach((it) => {
                const tr = trMap.get(it.title);
                if (tr && tr !== it.title) it.title_it = tr;
            });
            renderFeedCards(items, conf);
        }
        updateStatus(`Ultimo aggiornamento: ${new Date().toLocaleTimeString('it-IT')} · ${items.length} notizie da ${conf.sources.length} fonti`);
    } catch (err) {
        showError('story-list', `Errore nel caricamento: ${err.message}`);
    }
}

function renderFeedCards(items, conf) {
    const container = $('story-list');
    if (items.length === 0) {
        container.innerHTML = `<div class="error-msg">Nessuna notizia disponibile per questo canale.</div>`;
        return;
    }
    container.innerHTML = items.map((it, i) => {
        const title = it.title_it || it.title || 'Senza titolo';
        const isTranslated = it.title_it && it.title_it !== it.title;
        const color = it._color || conf.color;
        return `
        <article class="card feed-card" style="--c:${color}; animation-delay:${Math.min(i * 20, 400)}ms"
                 onclick="openArticle(${i})" role="button" tabindex="0"
                 onkeydown="if(event.key==='Enter')openArticle(${i})">
            ${it.image
                ? `<div class="card-thumb" style="background-image:url('${escapeAttr(it.image)}')"></div>`
                : `<div class="card-thumb card-thumb-empty">${conf.icon}</div>`}
            <div class="card-body">
                <div class="card-title">${escapeHtml(title)}</div>
                ${isTranslated ? `<div class="card-title-orig">${escapeHtml(it.title)}</div>` : ''}
                ${it.description ? `<div class="card-desc">${escapeHtml(it.description)}</div>` : ''}
                <div class="card-meta">
                    <span class="badge" style="--c:${color}">${escapeHtml(it.source)}</span>
                    <span>${it.published ? timeAgo(it.published) : ''}</span>
                    ${it.lang === 'it' ? '<span class="badge-it">IT</span>' : ''}
                    <span class="card-open">Apri articolo →</span>
                </div>
            </div>
        </article>`;
    }).join('');
}

/* ── Canale Personalizzati (feed aggiunti dall'utente) ── */

async function loadCustomFeedChannel() {
    const feeds = loadCustomFeeds();
    const conf = customChannel();
    if (!conf) return;
    renderListHeader(conf.label, conf.icon, conf.color, conf.description);
    showSkeleton('story-list', Math.min(feeds.length * 3, 12));

    const all = [];
    const failures = [];
    for (const feed of feeds) {
        try {
            const data = await fetchJSON(`${API}?action=feedurl&url=${encodeURIComponent(feed.url)}` +
                `&name=${encodeURIComponent(feed.name || '')}&limit=25`);
            (data.items || []).forEach((it) => {
                it._color = feed.color || nextCFColor(0);
                if (feed.lang === 'it' || feed.lang === 'en') it.lang = feed.lang;
            });
            all.push(...(data.items || []));
        } catch {
            failures.push(feed.name || getDomain(feed.url) || feed.url);
        }
    }
    all.sort((a, b) => (b.published || 0) - (a.published || 0));
    currentItems = all;
    renderFeedCards(all, conf);

    // Traduzione titoli dei soli feed non italiani (primi 24, come negli altri canali)
    const seen = new Set();
    const toTranslate = all
        .filter((it) => it.lang !== 'it' && it.title)
        .map((it) => it.title)
        .filter((t) => (seen.has(t) ? false : (seen.add(t), true)))
        .slice(0, 24);
    if (toTranslate.length) {
        updateStatus(`Traduzione titoli… (0 / ${toTranslate.length})`);
        const trMap = await translateBatch(toTranslate, (done, total) =>
            updateStatus(`Traduzione titoli… (${done} / ${total})`));
        all.forEach((it) => {
            const tr = trMap.get(it.title);
            if (tr && tr !== it.title) it.title_it = tr;
        });
        renderFeedCards(all, conf);
    }
    const note = failures.length ? ` · ⚠ ${failures.length} feed non raggiungibili` : '';
    updateStatus(`Ultimo aggiornamento: ${new Date().toLocaleTimeString('it-IT')} · ${all.length} notizie da ${feeds.length} feed${note}`);
}

/* ── Hacker News ── */

async function loadHN() {
    renderListHeader('Hacker News', '🗞️', '#ff6600', 'Discussioni e notizie dalla community');
    const btn = $('refresh-btn');
    btn.disabled = true;
    btn.textContent = 'Aggiornamento…';

    const cachedStories = await dbGetAll();
    if (cachedStories.length > 0) {
        currentItems = cachedStories;
        renderHNList(cachedStories);
        updateStatus('Notizie in cache · aggiornamento in corso…');
    } else {
        showSkeleton('story-list', 8);
    }

    try {
        const ids = await fetchJSON(`${API}?action=top&limit=30`);
        const stories = [];
        for (let i = 0; i < ids.length; i += 10) {
            const batch = ids.slice(i, i + 10);
            const results = await Promise.all(batch.map((id) => getStory(id)));
            stories.push(...results.filter(Boolean));
            renderHNList(stories);
        }
        hnStories = stories;
        currentItems = stories;
        await translateHN(stories);
        renderHNList(stories);
        updateStatus(`Ultimo aggiornamento: ${new Date().toLocaleTimeString('it-IT')} · ${stories.length} notizie tradotte`);
    } catch (err) {
        showError('story-list', `Errore nel caricamento: ${err.message}`);
    } finally {
        btn.disabled = false;
        btn.textContent = 'Aggiorna';
    }
}

async function translateHN(stories) {
    const seen = new Set();
    const titles = stories.map((s) => s.title).filter((t) => t && (seen.has(t) ? false : (seen.add(t), true)));
    const trMap = await translateBatch(titles);
    for (const s of stories) {
        const tr = trMap.get(s.title);
        if (tr && tr !== s.title) s.title_it = tr;
        if (s.text) s.text_it = await translateText(stripHtml(s.text));
    }
}

function renderHNList(stories) {
    const container = $('story-list');
    container.innerHTML = stories.map((story, i) => {
        const domain = getDomain(story.url);
        const title = story.title_it || story.title || 'Senza titolo';
        const isTranslated = story.title_it && story.title_it !== story.title;
        return `
        <article class="card story-card" style="animation-delay:${Math.min(i * 20, 400)}ms"
                 onclick="showDetail(${story.id})" role="button" tabindex="0"
                 onkeydown="if(event.key==='Enter')showDetail(${story.id})">
            <div class="story-rank">${i + 1}</div>
            <div class="card-body">
                <div class="card-title">${escapeHtml(title)}</div>
                ${isTranslated ? `<div class="card-title-orig">${escapeHtml(story.title)}</div>` : ''}
                <div class="card-meta">
                    <span class="points">▲ ${story.score || 0}</span>
                    <span>${escapeHtml(story.by || '?')}</span>
                    <span>${timeAgo(story.time)}</span>
                    <span>${story.descendants || 0} 💬</span>
                    ${domain ? `<span class="card-domain">${escapeHtml(domain)}</span>` : ''}
                </div>
            </div>
        </article>`;
    }).join('');
}

/* ── Reader integrato (nessuna tab, nessun popup) ── */

async function openArticle(index) {
    const item = currentItems[index];
    if (!item) return;
    const link = item.url || item.link;
    if (!link) return;

    showView('reader-view');
    const reader = $('reader-content');
    const source = item.source || 'Sconosciuta';
    const color = item._color || (channels.find((c) => c.key === activeKey) || {}).color || '#5b8cff';
    const title = item.title_it || item.title || 'Senza titolo';
    const isIt = item.lang === 'it';

    reader.innerHTML = `
        <div class="reader-head" style="--c:${color}">
            <span class="badge" style="--c:${color}">${escapeHtml(source)}</span>
            ${item.published ? `<span class="reader-time">${timeAgo(item.published)}</span>` : ''}
            ${isIt ? '' : '<span class="reader-note">Contenuto in lingua originale</span>'}
        </div>
        <h2 class="reader-title">${escapeHtml(title)}</h2>
        ${item.title_it && item.title_it !== item.title ? `<div class="card-title-orig">${escapeHtml(item.title)}</div>` : ''}
        ${item.image ? `<div class="reader-image" style="background-image:url('${escapeAttr(item.image)}')"></div>` : ''}
        <div class="reader-loading" id="reader-loading"><div class="spinner"></div><div>Caricamento articolo…</div></div>
        <div class="reader-body" id="reader-body" hidden></div>`;

    try {
        const art = await fetchJSON(`${API}?action=article&url=${encodeURIComponent(link)}`);
        const body = $('reader-body');
        $('reader-loading')?.remove();
        body.hidden = false;

        if (art && art.extracted && art.content_html) {
            body.innerHTML = `<div class="reader-text">${sanitizeHtml(art.content_html)}</div>`;
            if (art.truncated) body.insertAdjacentHTML('beforeend', '<p class="reader-more">Il testo è troncato per motivi di spazio.</p>');
            if (!isIt) {
                const translated = await translateArticleBody(body.querySelector('.reader-text'));
                if (translated) addTranslateToggle(reader);
            }
        } else {
            body.innerHTML = `
                <div class="reader-text">${escapeHtml(item.description || 'Contenuto non disponibile nel lettore integrato.')}</div>`;
        }
        // insertAdjacentHTML: aggiunge SENZA ri-parsare, così le mappe del toggle restano valide
        body.insertAdjacentHTML('beforeend', `<p class="reader-original"><a href="${escapeAttr(link)}" target="_blank" rel="noopener">Apri nel sito originale ↗</a></p>`);

        // Commenti HN in fondo all'articolo (quando è una story HN), caricati da soli
        if (item.id && item.descendants > 0) {
            body.insertAdjacentHTML('beforeend', `
                <div class="comments-section"><h3>💬 Commenti (${item.descendants})</h3><div id="reader-comments"></div></div>`);
            renderComments($('reader-comments'), item.id);
        }
    } catch {
        const body = $('reader-body');
        $('reader-loading')?.remove();
        body.hidden = false;
        body.innerHTML = `
            <div class="reader-text">${escapeHtml(item.description || 'Non è stato possibile caricare l’articolo.')}</div>
            <p class="reader-original"><a href="${escapeAttr(link)}" target="_blank" rel="noopener">Apri nel sito originale ↗</a></p>`;
    }
}

/* ── Dettaglio Hacker News (commenti) ── */

async function showDetail(id) {
    showView('detail-view');
    showSkeleton('detail-content', 3);

    try {
        const story = await getStory(id);
        pendingStory = story;
        const domain = getDomain(story.url);
        const title = story.title_it || story.title || 'Senza titolo';
        let textIt = story.text_it || '';
        if (story.text && !textIt) {
            textIt = await translateText(stripHtml(story.text));
            story.text_it = textIt;
        }

        let html = `
        <div class="reader-head">
            <span class="badge" style="--c:#ff6600">Hacker News</span>
            <span>${story.score || 0} punti · ${story.descendants || 0} commenti</span>
            <span>di ${escapeHtml(story.by || '?')} · ${timeAgo(story.time)}</span>
            ${domain ? `<span>${escapeHtml(domain)}</span>` : ''}
        </div>
        <h2 class="reader-title">${escapeHtml(title)}</h2>
        ${story.title_it && story.title_it !== story.title ? `<div class="card-title-orig">${escapeHtml(story.title)}</div>` : ''}`;

        if (story.url) {
            html += `<p class="reader-actions"><button class="btn" onclick="openArticleLink('${story.url}', true)">📖 Leggi articolo integrato</button></p>`;
        }
        if (textIt) {
            html += `<div class="reader-text"><p>${escapeHtml(textIt)}</p></div>`;
        }
        html += `<div class="comments-section"><h3>💬 Commenti</h3><div id="comments-list"></div></div>`;
        $('detail-content').innerHTML = html;

        if (story.descendants > 0) {
            renderComments($('comments-list'), id);
        } else {
            $('comments-list').innerHTML = '<p class="no-data">Nessun commento.</p>';
        }
    } catch (err) {
        showError('detail-content', `Errore: ${err.message}`);
    }
}

async function openArticleLink(url, story) {
    const s = story === true ? pendingStory : story;
    const item = s
        ? { link: url, source: 'Hacker News', title: s.title_it || s.title || 'Articolo', lang: 'en', id: s.id, descendants: s.descendants || 0 }
        : { link: url, source: 'Hacker News', title: 'Articolo', lang: 'en' };
    currentItems = [item];
    await openArticle(0);
}

/** Carica e renderizza i commenti HN (traduzione client-side), riusato in dettaglio e reader. */
async function renderComments(container, id) {
    container.innerHTML = `<div class="loading"><div class="spinner"></div></div>`;
    try {
        const comments = await fetchJSON(`${API}?action=comments&id=${id}`);
        const rendered = await Promise.all(comments.map(async (c) => {
            let textIt = c.text_it || '';
            if (c.text && !textIt) textIt = await translateText(stripHtml(c.text));
            return `
                <div class="comment">
                    <div class="comment-author">${escapeHtml(c.by || '?')} &middot; ${timeAgo(c.time)}</div>
                    <div class="comment-text">${escapeHtml(textIt || '')}</div>
                    ${c.text && textIt ? `<div class="comment-text-original">${escapeHtml(c.text)}</div>` : ''}
                </div>`;
        }));
        container.innerHTML = rendered.length
            ? rendered.join('')
            : '<p class="no-data">Nessun commento disponibile.</p>';
    } catch {
        container.innerHTML = '<p class="no-data">Errore nel caricamento dei commenti.</p>';
    }
}

/* ── Traduzione del corpo articolo nel reader ── */

async function translateArticleBody(container) {
    if (!container) return false;
    const blocks = [...container.querySelectorAll('p, li, blockquote, h2, h3, h4')]
        .filter((el) => {
            const t = (el.textContent || '').trim();
            return t.length > 2 && !el.closest('pre');
        });
    if (!blocks.length) return false;

    const original = new Map();
    const translated = new Map();
    const prog = document.createElement('div');
    prog.className = 'reader-translating';
    prog.textContent = `Traduzione in corso… (0/${blocks.length})`;
    container.insertAdjacentElement('beforebegin', prog);

    let done = 0;
    for (const el of blocks) {
        const t = (el.textContent || '').trim();
        original.set(el, t);
        const tr = await translateLongText(t);
        if (tr && tr !== t) {
            translated.set(el, tr);
            el.textContent = tr; // il markup interno (link/grassetto) va perso, come in Google Translate
        }
        done++;
        prog.textContent = `Traduzione in corso… (${done}/${blocks.length})`;
        if (done % 5 === 0) await sleep(180); // rispetta i rate-limit
    }
    prog.remove();

    if (!translated.size) return false;
    articleI18n = { original, translated, translatedMode: true };
    if (translated.size < blocks.length) {
        const note = document.createElement('p');
        note.className = 'reader-more';
        note.textContent = '⚠ Alcuni passaggi non tradotti (limite del servizio di traduzione gratuito).';
        container.insertAdjacentElement('afterend', note);
    }
    return true;
}

function addTranslateToggle(reader) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-sm';
    btn.textContent = '🌐 Mostra originale';
    btn.addEventListener('click', () => {
        if (!articleI18n) return;
        const showOriginal = articleI18n.translatedMode; // ora mostriamo la traduzione → passa all'originale
        for (const [el, tr] of articleI18n.translated) {
            el.textContent = showOriginal ? articleI18n.original.get(el) : tr;
        }
        articleI18n.translatedMode = !showOriginal;
        btn.textContent = showOriginal ? '🌐 Mostra traduzione' : '🌐 Mostra originale';
    });
    reader.querySelector('.reader-head').appendChild(btn);
}

/* ── Impostazioni: gestione feed personalizzati ── */

function openSettings() {
    const modal = $('settings-modal');
    modal.hidden = false;
    document.body.classList.add('modal-open');
    renderFeedList();
    $('cf-url').focus();
}

function closeSettings() {
    $('settings-modal').hidden = true;
    document.body.classList.remove('modal-open');
}

function renderFeedList() {
    const list = loadCustomFeeds();
    $('cf-list').innerHTML = list.length
        ? list.map((f, i) => `
            <li class="feed-item">
                <span class="feed-dot" style="background:${f.color || nextCFColor(0)}"></span>
                <span class="feed-name">${escapeHtml(f.name || getDomain(f.url) || f.url)}</span>
                <span class="feed-url">${escapeHtml(f.url)}</span>
                <button class="btn-icon feed-remove" data-i="${i}" title="Rimuovi feed" aria-label="Rimuovi">🗑</button>
            </li>`).join('')
        : '<li class="no-data">Nessun feed personalizzato. Aggiungine uno qui sopra.</li>';
    $('cf-list').querySelectorAll('.feed-remove').forEach((btn) =>
        btn.addEventListener('click', removeCustomFeed));
}

function removeCustomFeed(e) {
    const i = Number(e.currentTarget.dataset.i);
    const list = loadCustomFeeds();
    list.splice(i, 1);
    saveCustomFeeds(list);
    renderFeedList();
    renderTabs();
    if (activeKey === 'custom') {
        if (!list.length) selectChannel('hackernews');
        else loadCustomFeedChannel();
    }
}

async function addCustomFeed(e) {
    e.preventDefault();
    const url = $('cf-url').value.trim();
    const statusEl = $('cf-status');
    const addBtn = $('cf-add-btn');
    statusEl.textContent = 'Verifica del feed in corso…';
    statusEl.className = 'form-status';
    addBtn.disabled = true;
    try {
        const data = await fetchJSON(`${API}?action=feedurl&url=${encodeURIComponent(url)}&limit=1`);
        if (!data.items || !data.items.length) throw new Error('Nessuna notizia trovata nel feed');
        const list = loadCustomFeeds();
        const existing = list.find((f) => f.url === url);
        const feed = {
            id: existing ? existing.id : (Date.now().toString(36) + Math.random().toString(36).slice(2, 7)),
            name: $('cf-name').value.trim(),
            url,
            lang: $('cf-lang').value,      // auto | it | en
            color: $('cf-color').value || nextCFColor(list.length),
        };
        if (existing) Object.assign(existing, feed);
        else list.push(feed);
        saveCustomFeeds(list);
        $('feed-form').reset();
        $('cf-color').value = nextCFColor(list.length);
        renderFeedList();
        renderTabs();
        statusEl.textContent = `✔ Feed aggiunto (${data.items.length}+ notizie rilevate)`;
        statusEl.className = 'form-status ok';
        if (activeKey !== 'custom') await selectChannel('custom');
    } catch (err) {
        statusEl.textContent = `✖ ${err.message}`;
        statusEl.className = 'form-status err';
    } finally {
        addBtn.disabled = false;
    }
}

/* ── View switching ── */

function showView(name) {
    ['list-view', 'detail-view', 'reader-view'].forEach((v) => {
        $(v).classList.toggle('active', v === name);
        $(v).classList.toggle('hidden', v !== name);
    });
}

function showList() {
    showView('list-view');
}

/* ── Auto-aggiornamento ── */

function toggleAutoRefresh() {
    const checkbox = $('auto-refresh');
    if (checkbox.checked) {
        autoRefreshTimer = setInterval(refreshActiveChannel, 5 * 60 * 1000);
        $('status-note').textContent = 'Auto-aggiornamento attivo (ogni 5 min)';
    } else {
        clearInterval(autoRefreshTimer);
        autoRefreshTimer = null;
        $('status-note').textContent = 'Titoli tradotti automaticamente in italiano';
    }
}

function refreshActiveChannel() {
    const current = document.querySelector('.detail-view.active, .reader-view.active');
    if (current) return; // non disturbare dettaglio o lettura
    if (activeKey === 'hackernews') loadHN();
    else if (activeKey === 'custom') loadCustomFeedChannel();
    else loadFeed(activeKey);
}

/* ── Tema (light/dark) ── */

function initTheme() {
    const param = new URLSearchParams(location.search).get('theme');
    const saved = localStorage.getItem('theme');
    const dark = param ? param === 'dark'
        : saved === 'dark' || (saved === null && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    $('theme-btn').textContent = dark ? '☀️' : '🌙';
    $('theme-btn').addEventListener('click', () => {
        const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
        document.documentElement.dataset.theme = next;
        localStorage.setItem('theme', next);
        $('theme-btn').textContent = next === 'dark' ? '☀️' : '🌙';
    });
}

/* ── Init ── */

async function init() {
    initTheme();
    try {
        db = await openDB();
    } catch {
        db = null;
    }
    $('refresh-btn').addEventListener('click', refreshActiveChannel);
    $('auto-refresh').addEventListener('change', toggleAutoRefresh);
    $('back-btn').addEventListener('click', showList);
    $('reader-back').addEventListener('click', showList);
    $('settings-btn').addEventListener('click', openSettings);
    $('settings-close').addEventListener('click', closeSettings);
    $('feed-form').addEventListener('submit', addCustomFeed);
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !$('settings-modal').hidden) closeSettings();
    });

    try {
        channels = await fetchJSON(`${API}?action=channels`);
    } catch {
        channels = [{ key: 'hackernews', label: 'Hacker News', icon: '🗞️', color: '#ff6600', special: true }];
    }
    renderTabs();

    const requested = new URLSearchParams(location.search).get('channel');
    const valid = requested && channels.some((c) => c.key === requested);
    if (valid && requested !== 'hackernews') {
        activeKey = requested;
        renderTabs();
        await loadFeed(requested);
    } else {
        await loadHN();
    }
}

init();
