# HubNews ⚡

Aggregatore di notizie tecnologiche da fonti serie e selezionate, con **canali differenziati**:
Hacker News, Hardware, Software, Intelligenza Artificiale, Cybersecurity e Tech Italia.
Ogni canale ha il proprio colore e le proprie notizie — mai mescolati.

Il backend è un piccolo proxy PHP (`api.php`) che aggrega feed RSS/Atom, li normalizza
e li serve in JSON. Il frontend è HTML + JavaScript puro (nessuna dipendenza, niente Node).

## Avvio (serverino locale)

```bash
./run.sh            # su http://localhost:8000 (apre il browser da solo)
./run.sh 8080       # porta personalizzata
```

Requisiti: PHP ≥ 8 con i moduli `curl`, `SimpleXML`, `json`.

## Deploy su host PHP (demo online)

HubNews gira su **PHP**, quindi **GitHub Pages non basta** (serve solo file statici).
Per una demo pubblica serve un host con PHP (gratuiti: Altervista, Render, ecc.):

1. Carica tutti i file del repo nella tua web root (nessuna installazione: PHP puro);
2. `api.php` viene richiamato in relativo dal frontend: tutto funziona subito;
3. la cartella `cache/` (esclusa dal repo) si ricrea da sola al primo avvio.

Se invece vuoi il frontend separato (es. su GitHub Pages) e il backend PHP su un
altro host, punta l'app al backend con una di queste:

```bash
# via URL
index.html?api=https://tuo-host/api.php
# oppure impostando la variabile prima dello script
window.HUBNEWS_API = 'https://tuo-host/api.php';
```

`api.php` risponde già con `Access-Control-Allow-Origin: *`, non serve altro.


## Canali e fonti

| Canale | Fonti |
|---|---|
| 🗞️ Hacker News | API ufficiale HN (titoli tradotti in italiano + dettaglio commenti) |
| 🖥️ Hardware | Tom's Hardware · Phoronix · TechRadar · Ars Technica |
| 💻 Software | The Register · LWN.net · GitHub Blog · Ars Technica |
| 🤖 Intelligenza Artificiale | OpenAI · Google DeepMind · MIT Technology Review · The Verge |
| 🛡️ Cybersecurity | The Hacker News · BleepingComputer · Krebs on Security · SANS ISC · CyberSecurity 360 |
| 🇮🇹 Tech Italia | Punto Informatico · Agenda Digitale · Tom's Hardware Italia |
| 📌 Personalizzati | *feed RSS/Atom aggiunti da te* (vedi sotto) |

## Feed personalizzati (rotellina ⚙️)

Dal pulsante **⚙️** nell'angolo in alto a destra puoi aggiungere qualsiasi feed RSS/Atom:

- **Nome** (facoltativo) e **URL del feed** (obbligatorio);
- **Lingua dei titoli**: Auto (il sistema la rileva dai primi titoli), Italiano o Inglese;
- **Colore** con cui evidenziare le notizie di quel feed.

I feed salvati compaiono nel canale **📌 Personalizzati**, con nome, colore e lingua propri.
Ogni feed può essere rimosso dalla stessa schermata. Tutto è salvato nel tuo browser
(localStorage) e servito sempre dal proxy PHP (niente problemi di CORS).

## Come funziona

- `api.php`:
  - `?action=channels` — elenco canali;
  - `?action=feed&channel=<key>` — feed di un canale, ordinati per data (cache su file 10 min in `cache/`);
  - `?action=feedurl&url=<rss>&name=<nome>` — feed arbitrario con rilevamento lingua (per i Personalizzati);
  - `?action=article&url=<link>` — estrazione lato server dell'articolo per il reader integrato (cache 15 min);
  - Hacker News: `?action=top`, `?action=item&id=`, `?action=comments&id=`.
- `app.js` — tab per canale, rendering card, **traduzione titoli client-side** (Google Translate via JS
  con fallback MyMemory, cache in IndexedDB), **reader articoli integrato** (nessuna tab/popup), tema
  chiaro/scuro, auto-aggiornamento, impostazioni feed personalizzati.
- Deep-link: `index.html?channel=cybersecurity&theme=dark` apre direttamente un canale con il tema scelto.

## Note

- La traduzione in italiano avviene **nel browser** (Google Translate come faresti tu, fallback MyMemory),
  con cache in IndexedDB. Riguarda i **titoli** delle fonti non italiane (primi 24 per non saturare le
  quote gratuite) e, nel reader, anche il **corpo dell'articolo** (blocco per blocco, con il pulsante
  "🌐 Mostra originale" per tornare al testo di partenza).
- La **lettura degli articoli è integrata**: si apre dentro l'app, senza aprire schede o popup. Le
  immagini interne sono mostrate con dimensione controllata (max 420px) e, per le story Hacker News,
  i **commenti compaiono in fondo all'articolo** caricati automaticamente.
- Aggiungere una fonte fissa: basta inserire una voce nel relativo array `$CHANNELS` in `api.php`
  (alcune testate italiane — CyberSecurity Italia, Red Hot Cyber, Clusit, CSIRT ACN — non hanno un
  feed RSS accessibile: bloccati, 403 o 404).
