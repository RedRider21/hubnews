<?php
/**
 * HubNews — backend proxy
 * Aggrega feed RSS/Atom di fonti tecnologiche serie (hardware, software, AI, cybersecurity)
 * e mantiene l'integrazione con Hacker News (con traduzione automatica in italiano).
 */

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');

$action = $_GET['action'] ?? '';

/* ─────────────────────────── Configurazione canali ─────────────────────────── */

$CHANNELS = [
    'hardware' => [
        'label'       => 'Hardware',
        'icon'        => '🖥️',
        'color'       => '#0ea5e9',
        'description' => 'Componenti, dispositivi e tecnologia hardware',
        'feeds'       => [
            ['name' => "Tom's Hardware",   'url' => 'https://www.tomshardware.com/feeds/all'],
            ['name' => 'Phoronix',         'url' => 'https://www.phoronix.com/rss.php'],
            ['name' => 'TechRadar',        'url' => 'https://www.techradar.com/rss'],
            ['name' => 'Ars Technica',     'url' => 'https://feeds.arstechnica.com/arstechnica/index'],
        ],
    ],
    'software' => [
        'label'       => 'Software',
        'icon'        => '💻',
        'color'       => '#8b5cf6',
        'description' => 'Sviluppo, sistemi operativi e mondo open source',
        'feeds'       => [
            ['name' => 'The Register',     'url' => 'https://www.theregister.com/headlines.atom'],
            ['name' => 'LWN.net',          'url' => 'https://lwn.net/headlines/rss'],
            ['name' => 'GitHub Blog',      'url' => 'https://github.blog/feed/'],
            ['name' => 'Ars Technica',     'url' => 'https://feeds.arstechnica.com/arstechnica/index'],
        ],
    ],
    'ai' => [
        'label'       => 'Intelligenza Artificiale',
        'icon'        => '🤖',
        'color'       => '#10b981',
        'description' => 'Ricerca e novità su modelli e applicazioni IA',
        'feeds'       => [
            ['name' => 'OpenAI',             'url' => 'https://openai.com/news/rss.xml'],
            ['name' => 'Google DeepMind',    'url' => 'https://deepmind.google/blog/rss.xml'],
            ['name' => 'MIT Technology Review', 'url' => 'https://www.technologyreview.com/topic/artificial-intelligence/feed'],
            ['name' => 'The Verge · AI',     'url' => 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml'],
        ],
    ],
    'cybersecurity' => [
        'label'       => 'Cybersecurity',
        'icon'        => '🛡️',
        'color'       => '#ef4444',
        'description' => 'Sicurezza informatica, vulnerabilità e minacce',
        'feeds'       => [
            ['name' => 'The Hacker News',        'url' => 'https://feeds.feedburner.com/TheHackersNews'],
            ['name' => 'BleepingComputer',       'url' => 'https://www.bleepingcomputer.com/feed/'],
            ['name' => 'Krebs on Security',      'url' => 'https://krebsonsecurity.com/feed/'],
            ['name' => 'SANS Internet Storm Center', 'url' => 'https://isc.sans.edu/rssfeed_full.xml'],
            ['name' => 'CyberSecurity 360',      'url' => 'https://www.cybersecurity360.it/feed/', 'lang' => 'it'],
        ],
    ],
    'italia' => [
        'label'       => 'Tech Italia',
        'icon'        => '🇮🇹',
        'color'       => '#0891b2',
        'description' => 'Testate e fonti tecnologiche italiane',
        'feeds'       => [
            ['name' => 'Punto Informatico',      'url' => 'https://www.punto-informatico.it/feed/', 'lang' => 'it'],
            ['name' => 'Agenda Digitale',        'url' => 'https://www.agendadigitale.eu/feed/', 'lang' => 'it'],
            ['name' => "Tom's Hardware Italia",  'url' => 'https://www.tomshw.it/feed/', 'lang' => 'it'],
        ],
    ],
];

const FEED_TTL   = 600;   // 10 minuti
const HN_TTL     = 300;   // 5 minuti

/* ─────────────────────────────── Utility rete ─────────────────────────────── */

function fetchUrl(string $url, int $timeout = 20): ?string {
    $ch = curl_init();
    curl_setopt_array($ch, [
        CURLOPT_URL => $url,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_MAXREDIRS => 5,
        CURLOPT_TIMEOUT => $timeout,
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_USERAGENT => 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        CURLOPT_HTTPHEADER => ['Accept: application/rss+xml, application/atom+xml, application/xml, */*'],
    ]);
    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    if ($httpCode !== 200 || $response === false) {
        return null;
    }
    return $response;
}

/* ─────────────────────────── Parsing e normalizzazione ─────────────────────────── */

/** Ritorna gli item normalizzati di un feed, con cache su file. */
function getFeedItems(string $url): array {
    $cacheDir = __DIR__ . '/cache';
    if (!is_dir($cacheDir)) {
        @mkdir($cacheDir, 0775, true);
    }
    $cacheFile = $cacheDir . '/' . md5($url) . '.json';
    if (is_file($cacheFile)) {
        $data = json_decode((string)file_get_contents($cacheFile), true);
        if (is_array($data) && isset($data['fetched'], $data['items']) && (time() - $data['fetched']) < FEED_TTL) {
            return $data['items'];
        }
    }
    $body = fetchUrl($url);
    if ($body !== null) {
        $items = parseFeed($body);
        @file_put_contents($cacheFile, json_encode(['fetched' => time(), 'items' => $items]), LOCK_EX);
        return $items;
    }
    // Fallback su cache "stale" se il fetch fallisce: meglio dati vecchi che nulla.
    if (is_file($cacheFile)) {
        $data = json_decode((string)file_get_contents($cacheFile), true);
        if (is_array($data) && isset($data['items'])) {
            return $data['items'];
        }
    }
    return [];
}

/** Parsa RSS 2.0 o Atom e normalizza in item omogenei. */
function parseFeed(string $body): array {
    libxml_use_internal_errors(true);
    $xml = @simplexml_load_string($body);
    libxml_clear_errors();
    if ($xml === false) {
        return [];
    }
    $ns = $xml->getNamespaces(true);
    $items = [];
    $root = $xml->getName();

    if ($root === 'feed') { // Atom
        foreach ($xml->entry as $entry) {
            $link = '';
            foreach ($entry->link as $l) {
                $rel = (string)$l['rel'];
                if ($rel === 'alternate' || $rel === '') {
                    $link = trim((string)$l['href']);
                    break;
                }
            }
            $item = buildItem(
                trim((string)$entry->title),
                $link,
                (string)($entry->summary ?? $entry->content),
                (string)$entry->updated,
                $entry,
                $ns
            );
            if ($item) {
                $items[] = $item;
            }
        }
    } else { // RSS 2.0
        foreach ($xml->channel->item as $entry) {
            $item = buildItem(
                trim((string)$entry->title),
                trim((string)$entry->link),
                (string)$entry->description,
                (string)$entry->pubDate,
                $entry,
                $ns
            );
            if ($item) {
                $items[] = $item;
            }
        }
    }
    return $items;
}

function buildItem(string $title, string $link, string $descRaw, string $dateRaw, $node, array $ns): ?array {
    $title = html_entity_decode($title, ENT_QUOTES | ENT_HTML5, 'UTF-8');
    if ($title === '' || $link === '') {
        return null;
    }
    return [
        'id'          => md5($link . $title),
        'title'       => $title,
        'link'        => $link,
        'description' => cleanDescription($descRaw),
        'image'       => extractImage($node, $ns, $descRaw),
        'published'   => dateToUnix($dateRaw),
    ];
}

/** Converti date RSS (RFC 2822) o Atom (ISO 8601) in timestamp unix. */
function dateToUnix(string $date): ?int {
    $ts = strtotime(trim($date));
    return ($ts && $ts > 0) ? $ts : null;
}

/** Strip HTML, normalizza spazi e tronca la descrizione. */
function cleanDescription(string $html): string {
    $text = trim(strip_tags($html));
    $text = preg_replace('/\s+/u', ' ', $text) ?? $text;
    return cutText($text, 240);
}

/** Taglia una stringa senza spezzare a metà caratteri UTF-8. */
function cutText(string $text, int $len): string {
    if (function_exists('mb_strlen')) {
        if (mb_strlen($text, 'UTF-8') <= $len) {
            return $text;
        }
        return rtrim(mb_substr($text, 0, $len - 1, 'UTF-8')) . '…';
    }
    if (strlen($text) <= $len) {
        return $text;
    }
    return substr($text, 0, $len - 1) . '…';
}

/** Estrazione best-effort di una immagine per la card. */
function extractImage($node, array $ns, string $descRaw): ?string {
    // Namespace media (Atom e RSS) — thumbnail o content
    if (isset($ns['media'])) {
        try {
            $thumb = $node->xpath('.//media:thumbnail/@url');
            if ($thumb) {
                return (string)$thumb[0];
            }
            foreach ($node->xpath('.//media:content') as $mc) {
                if (str_starts_with((string)$mc['type'], 'image/')) {
                    return (string)$mc['url'];
                }
            }
        } catch (Exception $e) {
            // ignora
        }
    }
    // RSS enclosure
    foreach ($node->enclosure as $enc) {
        if (str_starts_with((string)$enc['type'], 'image/')) {
            return (string)$enc['url'];
        }
    }
    // Prima <img> nel HTML della descrizione
    if (preg_match('/<img[^>]+src=["\']([^"\']+)["\']/i', $descRaw, $m)) {
        $src = html_entity_decode($m[1], ENT_QUOTES, 'UTF-8');
        if (str_starts_with($src, 'http')) {
            return $src;
        }
    }
    return null;
}

/* ─────────────────────────────── Hacker News ─────────────────────────────── */

function hnFetch(string $path): ?array {
    $response = fetchUrl('https://hacker-news.firebaseio.com/v0/' . $path);
    if ($response === null) {
        return null;
    }
    return json_decode($response, true);
}

/* ─────────────────────────────── Rotta ─────────────────────────────── */

function apiChannels(): void {
    global $CHANNELS;
    $out = [['key' => 'hackernews', 'label' => 'Hacker News', 'icon' => '🗞️', 'color' => '#ff6600', 'special' => true]];
    foreach ($CHANNELS as $key => $ch) {
        $out[] = [
            'key'         => $key,
            'label'       => $ch['label'],
            'icon'        => $ch['icon'],
            'color'       => $ch['color'],
            'description' => $ch['description'],
            'sources'     => array_column($ch['feeds'], 'name'),
        ];
    }
    echo json_encode($out);
}

function apiFeed(string $channel): void {
    global $CHANNELS;
    if (!isset($CHANNELS[$channel])) {
        http_response_code(404);
        echo json_encode(['error' => 'Canale sconosciuto']);
        return;
    }
    $limit = min((int)($_GET['limit'] ?? 40), 60);
    $conf = $CHANNELS[$channel];
    $all = [];
    foreach ($conf['feeds'] as $feed) {
        foreach (getFeedItems($feed['url']) as $item) {
            $item['source'] = $feed['name'];
            $item['lang'] = $feed['lang'] ?? 'en';
            $all[] = $item;
        }
    }
    // Ordinamento per data (più recenti prima; senza data in coda)
    usort($all, function ($a, $b) {
        $ta = $a['published'] ?? 0;
        $tb = $b['published'] ?? 0;
        if ($ta === $tb) return 0;
        return ($ta > $tb) ? -1 : 1;
    });
    $all = array_slice($all, 0, $limit);
    echo json_encode([
        'channel'   => $channel,
        'label'     => $conf['label'],
        'color'     => $conf['color'],
        'updated_at' => time(),
        'items'     => $all,
    ]);
}

/* ─────────────── Feed arbitrario (feed personalizzati dell'utente) ─────────────── */

/** Sniffa la lingua dei titoli: 'it' se prevalgono parole italiane, altrimenti 'en'. */
function sniffLang(array $items): string {
    $it = ['il', 'lo', 'la', 'i', 'gli', 'le', 'di', 'che', 'e', 'a', 'per', 'con', 'non',
           'una', 'sono', 'ha', 'anche', 'piu', 'da', 'del', 'della', 'delle', 'degli',
           'nel', 'nella', 'sul', 'tra', 'questo', 'questa', 'essere', 'dopo', 'prima',
           'stato', 'nuovo', 'nuova', 'italia', 'governo', 'mondo'];
    $en = ['the', 'and', 'of', 'to', 'in', 'for', 'with', 'is', 'are', 'on', 'at', 'by',
           'from', 'this', 'that', 'has', 'have', 'will', 'its', 'new', 'after', 'before',
           'about', 'more', 'world', 'how', 'what', 'your', 'you'];
    $itHits = 0;
    $enHits = 0;
    foreach (array_slice(array_column($items, 'title'), 0, 12) as $t) {
        foreach (preg_split('/[\s\p{P}]+/u', mb_strtolower((string)$t, 'UTF-8')) ?: [] as $w) {
            if (in_array($w, $it, true)) $itHits++;
            if (in_array($w, $en, true)) $enHits++;
        }
    }
    return $itHits >= $enHits ? 'it' : 'en';
}

function apiFeedUrl(): void {
    $url = trim($_GET['url'] ?? '');
    if (!preg_match('~^https?://~i', $url)) {
        http_response_code(400);
        echo json_encode(['error' => 'URL non valido']);
        return;
    }
    $host = parse_url($url, PHP_URL_HOST);
    if (!$host || isPrivateHost($host)) {
        http_response_code(403);
        echo json_encode(['error' => 'Host non consentito']);
        return;
    }
    $limit = min((int)($_GET['limit'] ?? 40), 60);
    $name = trim($_GET['name'] ?? '');
    if ($name === '') {
        $name = str_replace('www.', '', (string)$host);
    }

    $items = getFeedItems($url);
    if (!$items) {
        http_response_code(422);
        echo json_encode(['error' => 'Feed non valido o non raggiungibile']);
        return;
    }
    foreach ($items as &$item) {
        $item['source'] = $name;
        $item['lang'] = null; // deciso dal client (auto) o dall'utente
    }
    unset($item);
    usort($items, fn($a, $b) => ($b['published'] ?? 0) <=> ($a['published'] ?? 0));
    $items = array_slice($items, 0, $limit);
    echo json_encode([
        'url'        => $url,
        'source'     => $name,
        'lang'       => sniffLang($items),
        'updated_at' => time(),
        'items'      => $items,
    ]);
}

/* ─────────────────────────── Reader articoli integrato ─────────────────────────── */

const ARTICLE_TTL = 900; // 15 minuti

function isPrivateHost(string $host): bool {
    $host = strtolower(trim($host));
    if ($host === 'localhost' || str_ends_with($host, '.localhost')) {
        return true;
    }
    $ip = filter_var($host, FILTER_VALIDATE_IP) ? $host : gethostbyname($host);
    if (!filter_var($ip, FILTER_VALIDATE_IP)) {
        return true; // nome non risolvibile
    }
    // True se è un IP privato / range riservato
    return filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) === false;
}

/** Estrae il contenuto principale di una pagina HTML (reader integrato). */
function extractArticle(string $html, string $url): array {
    $html = mb_convert_encoding($html, 'HTML-ENTITIES', 'UTF-8');
    $doc = new DOMDocument();
    $ok = @$doc->loadHTML($html, LIBXML_NOERROR | LIBXML_NOWARNING | LIBXML_NONET);
    if (!$ok) {
        return ['extracted' => false, 'title' => '', 'image' => null, 'content_html' => ''];
    }

    $xpath = new DOMXPath($doc);

    // Titolo: <title> o og:title
    $title = trim((string)$doc->getElementsByTagName('title')->item(0)?->textContent);
    $og = $xpath->query('//meta[@property="og:title"]/@content');
    if ($og->length && trim((string)$og->item(0)->nodeValue)) {
        $title = trim((string)$og->item(0)->nodeValue);
    }

    // Immagine di testata: og:image
    $image = null;
    $ogImg = $xpath->query('//meta[@property="og:image"]/@content');
    if ($ogImg->length) {
        $image = trim((string)$ogImg->item(0)->nodeValue);
    }

    // Parole chiave che segnalano blocchi di navigazione/accessori da scartare
    $junk = '/nav|menu|footer|sidebar|related|recommend|breadcrumb|social|share|cookie|consent|subscribe|newsletter|widget|popup|advert|promo|comment|header|search|pagination|author-bio|signup|banner/i';

    // Contenitore principale: article > main > body
    $container = null;
    foreach (['article', 'main'] as $tag) {
        $nodes = $doc->getElementsByTagName($tag);
        if ($nodes->length) {
            $container = $nodes->item(0);
            break;
        }
    }

    // Nodi da includere, in ordine di documento
    $keepTags = ['p', 'h2', 'h3', 'h4', 'li', 'blockquote', 'pre', 'img', 'figure'];
    $parts = [];
    $count = 0;
    $maxNodes = 40;
    $maxLen = 0;

    foreach ($keepTags as $tag) {
        if ($container) {
            $nodes = $container->getElementsByTagName($tag);
        } else {
            $nodes = $doc->getElementsByTagName($tag);
        }
        foreach ($nodes as $node) {
            if ($count >= $maxNodes || $maxLen > 9000) {
                break 2;
            }
            // Scarta nodi dentro contenitori di navigazione
            $skip = false;
            $anc = $node->parentNode;
            for ($i = 0; $i < 4 && $anc; $i++, $anc = $anc->parentNode) {
                if ($anc->nodeType === XML_ELEMENT_NODE) {
                    $cls = $anc->getAttribute('class') . ' ' . $anc->getAttribute('id');
                    if (preg_match($junk, $cls)) {
                        $skip = true;
                        break;
                    }
                }
            }
            if ($skip) {
                continue;
            }
            // Per img: solo se ha src (o data-src)
            if ($tag === 'img') {
                $src = $node->getAttribute('src') ?: $node->getAttribute('data-src') ?: $node->getAttribute('data-lazy-src');
                if (!$src) {
                    continue;
                }
                if (!$node->getAttribute('src')) {
                    $node->setAttribute('src', $src);
                }
                // Normalizza URL relativi
                if (!preg_match('~^https?://~i', $src)) {
                    $node->setAttribute('src', resolveUrl($url, $src));
                }
            }
            // Testo minimo per i nodi di testo
            if (in_array($tag, ['p', 'li'], true) && mb_strlen(trim((string)$node->textContent)) < 20) {
                continue;
            }
            $html = (string)$doc->saveHTML($node);
            if ($html === '') {
                continue;
            }
            $parts[] = $html;
            $count++;
            $maxLen += mb_strlen(trim((string)$node->textContent));
        }
    }

    $truncated = $maxLen > 9000;
    return [
        'extracted'   => count($parts) > 0,
        'title'       => $title,
        'image'       => $image,
        'content_html' => implode("\n", $parts),
        'truncated'   => $truncated,
    ];
}

function resolveUrl(string $base, string $rel): string {
    if (preg_match('~^https?://~i', $rel)) {
        return $rel;
    }
    $p = parse_url($base);
    $scheme = $p['scheme'] ?? 'https';
    $host = $p['host'] ?? '';
    if ($rel === '' || $rel[0] === '#') {
        return $base;
    }
    if ($rel[0] === '/') {
        return "{$scheme}://{$host}{$rel}";
    }
    $dir = isset($p['path']) ? substr($p['path'], 0, strrpos($p['path'], '/') + 1) : '/';
    return "{$scheme}://{$host}{$dir}{$rel}";
}

function apiArticle(string $url): void {
    if (!preg_match('~^https?://~i', $url)) {
        http_response_code(400);
        echo json_encode(['error' => 'URL non valido']);
        return;
    }
    $host = parse_url($url, PHP_URL_HOST);
    if (!$host || isPrivateHost($host)) {
        http_response_code(403);
        echo json_encode(['error' => 'Host non consentito']);
        return;
    }

    $cacheDir = __DIR__ . '/cache';
    if (!is_dir($cacheDir)) {
        @mkdir($cacheDir, 0775, true);
    }
    $cacheFile = $cacheDir . '/article_' . md5($url) . '.json';
    if (is_file($cacheFile)) {
        $data = json_decode((string)file_get_contents($cacheFile), true);
        if (is_array($data) && isset($data['fetched'], $data['article']) && (time() - $data['fetched']) < ARTICLE_TTL) {
            $data['article']['url'] = $url;
            echo json_encode($data['article']);
            return;
        }
    }

    $html = fetchUrl($url);
    if ($html === null) {
        http_response_code(502);
        echo json_encode(['error' => 'Impossibile scaricare l’articolo']);
        return;
    }
    $article = extractArticle($html, $url);
    $article['url'] = $url;
    @file_put_contents($cacheFile, json_encode(['fetched' => time(), 'article' => $article]), LOCK_EX);
    echo json_encode($article);
}

/* ─────────────────────────── Risposta ─────────────────────────── */

switch ($action) {
    case 'channels':
        apiChannels();
        break;

    case 'feed':
        apiFeed($_GET['channel'] ?? '');
        break;

    case 'feedurl':
        apiFeedUrl();
        break;

    case 'article':
        apiArticle($_GET['url'] ?? '');
        break;

    case 'top': { // Hacker News — top stories (traduzione titoli)
        $limit = min((int)($_GET['limit'] ?? 30), 50);
        $ids = hnFetch('topstories.json');
        if ($ids === null) {
            http_response_code(502);
            echo json_encode(['error' => 'Impossibile contattare Hacker News']);
            exit;
        }
        echo json_encode(array_slice($ids, 0, $limit));
        break;
    }

    case 'item': { // Hacker News — dettaglio story (con traduzione)
        $id = (int)($_GET['id'] ?? 0);
        if ($id <= 0) {
            http_response_code(400);
            echo json_encode(['error' => 'ID non valido']);
            exit;
        }
        $item = hnFetch("item/{$id}.json");
        if ($item === null) {
            http_response_code(502);
            echo json_encode(['error' => 'Impossibile recuperare elemento']);
            exit;
        }
        echo json_encode($item);
        break;
    }

    case 'comments': { // Hacker News — commenti (con traduzione)
        $id = (int)($_GET['id'] ?? 0);
        if ($id <= 0) {
            http_response_code(400);
            echo json_encode(['error' => 'ID non valido']);
            exit;
        }
        $item = hnFetch("item/{$id}.json");
        if ($item === null || empty($item['kids'])) {
            echo json_encode([]);
            exit;
        }
        $comments = [];
        foreach (array_slice($item['kids'], 0, 10) as $cid) {
            $c = hnFetch("item/{$cid}.json");
            if ($c === null || ($c['deleted'] ?? false) || ($c['dead'] ?? false)) {
                continue;
            }
            $comments[] = $c;
        }
        echo json_encode($comments);
        break;
    }

    default:
        echo json_encode(['actions' => ['channels', 'feed', 'top', 'item', 'comments']]);
}
