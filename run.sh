#!/usr/bin/env bash

set -euo pipefail

export FLASK_APP=app.py
export FLASK_ENV=development
export ENABLE_FINGER_TRACKING=${ENABLE_FINGER_TRACKING:-0}

PORT=${1:-5000}

echo "Starting Flask on port ${PORT}..."
flask run --host=0.0.0.0 --port="${PORT}"