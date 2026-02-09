#!/usr/bin/env bash

set -euo pipefail

export FLASK_APP=app.py
export FLASK_ENV=development

PORT=${1:-5001}

echo "Starting Flask on port ${PORT}..."
flask run --host=0.0.0.0 --port="${PORT}"