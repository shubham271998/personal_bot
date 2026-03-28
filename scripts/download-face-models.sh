#!/bin/bash
# Download InsightFace buffalo_l ONNX models (SCRFD + ArcFace)
# These are the best free face detection + recognition models available.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MODELS_DIR="$SCRIPT_DIR/../models/insightface"
TEMP_ZIP="/tmp/buffalo_l.zip"

echo "📦 Downloading InsightFace buffalo_l models..."

mkdir -p "$MODELS_DIR"

# Download buffalo_l pack from InsightFace releases
DOWNLOAD_URL="https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip"

if [ -f "$MODELS_DIR/det_10g.onnx" ] && [ -f "$MODELS_DIR/w600k_r50.onnx" ]; then
  echo "✅ Models already downloaded!"
  echo "   Detection: $MODELS_DIR/det_10g.onnx ($(du -h "$MODELS_DIR/det_10g.onnx" | cut -f1))"
  echo "   Recognition: $MODELS_DIR/w600k_r50.onnx ($(du -h "$MODELS_DIR/w600k_r50.onnx" | cut -f1))"
  exit 0
fi

echo "   Downloading from: $DOWNLOAD_URL"
curl -L -o "$TEMP_ZIP" "$DOWNLOAD_URL" --progress-bar

echo "   Extracting..."
unzip -o "$TEMP_ZIP" -d "/tmp/buffalo_l"

# Copy the models we need
cp "/tmp/buffalo_l/buffalo_l/det_10g.onnx" "$MODELS_DIR/"
cp "/tmp/buffalo_l/buffalo_l/w600k_r50.onnx" "$MODELS_DIR/"

# Cleanup
rm -rf "$TEMP_ZIP" "/tmp/buffalo_l"

echo ""
echo "✅ Models downloaded successfully!"
echo "   Detection (SCRFD-10G):  $MODELS_DIR/det_10g.onnx ($(du -h "$MODELS_DIR/det_10g.onnx" | cut -f1))"
echo "   Recognition (ArcFace): $MODELS_DIR/w600k_r50.onnx ($(du -h "$MODELS_DIR/w600k_r50.onnx" | cut -f1))"
