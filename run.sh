#!/usr/bin/env bash
#
# HubNews — serverino locale
# Avvia un piccolo server PHP nella cartella per provare l'app.
# Se un server precedente dello stesso progetto occupa già la porta scelta,
# viene terminato e il server riavviato sulla stessa porta (niente porte a scalare).
#
# Uso:
#   ./run.sh            -> server su http://localhost:8000
#   ./run.sh 8080       -> porta personalizzata
#
set -euo pipefail

# pwd -P risolve eventuali symlink: il confronto col cwd reale del processo
# in /proc funziona anche se la cartella è raggiunta tramite link.
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PORT="${1:-8000}"
HOST="127.0.0.1"

# PHP deve esserci
if ! command -v php >/dev/null 2>&1; then
    echo "ERRORE: php non è installato. Installa PHP (con i moduli curl e SimpleXML)." >&2
    exit 1
fi

# Controllo moduli necessari
MISSING=""
for mod in curl SimpleXML json; do
    php -m 2>/dev/null | grep -qi "^${mod}$" || MISSING="$MISSING $mod"
done
if [ -n "$MISSING" ]; then
    echo "ERRORE: moduli PHP mancanti:${MISSING}" >&2
    echo "Suggerimento: sudo apt install php-curl php-xml" >&2
    exit 1
fi

# La cache va creata una volta (scritta da api.php)
mkdir -p "$DIR/cache"

# Se un server precedente di QUESTO progetto (un `php -S` avviato da qui) occupa
# già la porta, lo si termina e si riavvia sulla stessa porta richiesta.
if command -v lsof >/dev/null 2>&1; then
    for pid in $(lsof -t -i :"$PORT" -sTCP:LISTEN 2>/dev/null || true); do
        [ -n "$pid" ] || continue
        # È un php -S lanciato da questa cartella? solo in quel caso lo si tocca:
        if [ -r "/proc/$pid/cwd" ] \
           && [ "$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)" = "$DIR" ] \
           && ps -p "$pid" -o comm= 2>/dev/null | grep -q php; then
            echo "Server precedente del progetto (PID $pid) su :$PORT — lo riavvio." >&2
            kill "$pid" 2>/dev/null || true
            # aspetta che rilasci la porta (max ~1.5 s)
            for _ in 1 2 3 4 5; do
                lsof -t -i :"$PORT" -sTCP:LISTEN >/dev/null 2>&1 || break
                sleep 0.3
            done
        fi
    done
fi

# Se la porta è ancora occupata (da un processo estraneo, es. un altro progetto),
# si scala alla prima porta libera.
while lsof -i :"$PORT" -sTCP:LISTEN >/dev/null 2>&1; do
    echo "Porta $PORT occupata da un altro processo — provo con $((PORT+1))" >&2
    PORT=$((PORT+1))
done

URL="http://${HOST}:${PORT}"
echo ""
echo "  🚀 HubNews avviato su ${URL}"
echo "  Premi Ctrl+C per fermarlo."
echo ""

cd "$DIR"

# Apri il browser se possibile (il più delle volte) dopo un breve attesa
( sleep 1 && if command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL" >/dev/null 2>&1 || true; fi ) &

# Più worker: una richiesta lenta (es. un feed o un articolo) non blocca le altre.
# Richiede PHP >= 7.4; se non disponibile, PHP parte comunque single-threaded.
export PHP_CLI_SERVER_WORKERS="${PHP_CLI_SERVER_WORKERS:-4}"
exec php -S "${HOST}:${PORT}" 2>&1
