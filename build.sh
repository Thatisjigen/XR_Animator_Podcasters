#!/usr/bin/env bash
set -e

# Trova la directory root del repository indipendentemente da dove viene invocato lo script
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

echo "=================================================="
echo "      🚀 XR Animator - Bundled Build Launcher"
echo "=================================================="

# Rilevamento automatico dell'interprete Python (.venv locale prioritario)
if [ -f "$ROOT_DIR/.venv/bin/python3" ]; then
    PYTHON_BIN="$ROOT_DIR/.venv/bin/python3"
    echo "📦 Utilizzo ambiente virtuale: .venv"
elif command -v python3 >/dev/null 2>&1; then
    PYTHON_BIN="python3"
    echo "📦 Utilizzo Python di sistema: $(command -v python3)"
else
    echo "❌ Errore: Python 3 non trovato. Installa python3 per compilare."
    exit 1
fi

echo "⚙️  Esecuzione build bundled in corso..."
"$PYTHON_BIN" "$ROOT_DIR/tools/build_bundled_browser.py"

echo ""
echo "=================================================="
echo "  ✅ Build completata con successo!"
echo "=================================================="
echo "📍 Percorso build: $ROOT_DIR/release/XR_Animator_Bundled"
echo "▶️  Per avviare l'app bundled puoi eseguire:"
echo "    ./release/XR_Animator_Bundled/XR_Animator"
echo "    oppure semplicemente ./XR_Animator dalla radice del repo."
echo "=================================================="
