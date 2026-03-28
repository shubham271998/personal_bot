/**
 * Face Engine — InsightFace ONNX Pipeline
 *
 * Detection:   SCRFD-10G  (det_10g.onnx)  — best free face detector
 * Recognition: ArcFace R50 (w600k_r50.onnx) — 512-dim embeddings, 99.8% LFW accuracy
 *
 * Pipeline: Image → SCRFD detect → 5-point landmarks → Align to 112×112 → ArcFace embed → Cosine similarity
 */
import * as ort from "onnxruntime-node"
import sharp from "sharp"
import path from "path"
import fs from "fs"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MODELS_DIR = path.resolve(__dirname, "../models/insightface")
const DET_MODEL_PATH = path.join(MODELS_DIR, "det_10g.onnx")
const REC_MODEL_PATH = path.join(MODELS_DIR, "w600k_r50.onnx")

// ── Config ──────────────────────────────────────────────────
const DET_INPUT_SIZE = 640
const DET_CONF_THRESHOLD = 0.5
const DET_NMS_THRESHOLD = 0.4
const REC_INPUT_SIZE = 112
const STRIDES = [8, 16, 32]
const NUM_ANCHORS = 2 // SCRFD uses 2 anchors per cell

// ArcFace standard alignment template (112×112)
const ARCFACE_TEMPLATE = [
  [38.2946, 51.6963], // left eye
  [73.5318, 51.5014], // right eye
  [56.0252, 71.7366], // nose
  [41.5493, 92.3655], // left mouth corner
  [70.7299, 92.2041], // right mouth corner
]

// ── State ───────────────────────────────────────────────────
let detSession = null
let recSession = null
let isReady = false
let cachedReferenceEmbedding = null

// ── Init ────────────────────────────────────────────────────
async function init() {
  if (isReady) return true

  if (!fs.existsSync(DET_MODEL_PATH) || !fs.existsSync(REC_MODEL_PATH)) {
    console.error("❌ InsightFace models not found! Run: bash scripts/download-face-models.sh")
    return false
  }

  try {
    console.log("🧠 Loading InsightFace ONNX models...")
    const opts = { executionProviders: ["cpu"] }

    detSession = await ort.InferenceSession.create(DET_MODEL_PATH, opts)
    console.log("   ✅ SCRFD-10G detector loaded")
    console.log("      Inputs:", detSession.inputNames)
    console.log("      Outputs:", detSession.outputNames.length, "tensors")

    recSession = await ort.InferenceSession.create(REC_MODEL_PATH, opts)
    console.log("   ✅ ArcFace R50 recognizer loaded")

    isReady = true
    return true
  } catch (err) {
    console.error("❌ Failed to load InsightFace models:", err.message)
    return false
  }
}

// ── Image Preprocessing ─────────────────────────────────────

/**
 * Load image and prepare for SCRFD detection
 * Returns: { tensor, scale, padW, padH, origW, origH }
 */
async function prepareDetInput(imagePath) {
  const img = sharp(imagePath)
  const meta = await img.metadata()
  const origW = meta.width
  const origH = meta.height

  // Letterbox resize to DET_INPUT_SIZE × DET_INPUT_SIZE
  const scale = Math.min(DET_INPUT_SIZE / origW, DET_INPUT_SIZE / origH)
  const newW = Math.round(origW * scale)
  const newH = Math.round(origH * scale)
  const padW = Math.round((DET_INPUT_SIZE - newW) / 2)
  const padH = Math.round((DET_INPUT_SIZE - newH) / 2)

  const resized = await sharp(imagePath)
    .resize(newW, newH, { fit: "fill" })
    .extend({
      top: padH,
      bottom: DET_INPUT_SIZE - newH - padH,
      left: padW,
      right: DET_INPUT_SIZE - newW - padW,
      background: { r: 0, g: 0, b: 0 },
    })
    .removeAlpha()
    .raw()
    .toBuffer()

  // HWC → NCHW, float32, normalize: (pixel - 127.5) / 128
  const float32 = new Float32Array(3 * DET_INPUT_SIZE * DET_INPUT_SIZE)
  for (let i = 0; i < DET_INPUT_SIZE * DET_INPUT_SIZE; i++) {
    float32[i] = (resized[i * 3] - 127.5) / 128.0                                     // R
    float32[DET_INPUT_SIZE * DET_INPUT_SIZE + i] = (resized[i * 3 + 1] - 127.5) / 128.0 // G
    float32[2 * DET_INPUT_SIZE * DET_INPUT_SIZE + i] = (resized[i * 3 + 2] - 127.5) / 128.0 // B
  }

  const tensor = new ort.Tensor("float32", float32, [1, 3, DET_INPUT_SIZE, DET_INPUT_SIZE])
  return { tensor, scale, padW, padH, origW, origH }
}

// ── SCRFD Detection ─────────────────────────────────────────

/**
 * Generate anchors for a given stride
 */
function generateAnchors(featH, featW, stride) {
  const anchors = []
  for (let y = 0; y < featH; y++) {
    for (let x = 0; x < featW; x++) {
      for (let a = 0; a < NUM_ANCHORS; a++) {
        anchors.push([x * stride, y * stride])
      }
    }
  }
  return anchors
}

/**
 * Decode SCRFD outputs into detections
 *
 * SCRFD outputs 9 tensors grouped by stride [8, 16, 32]:
 *   Each stride has: scores (Nx1), bboxes (Nx4), keypoints (Nx10)
 *   Scores are already post-sigmoid probabilities (0-1).
 *   Dims may be [N, C] (no batch dim) or [1, N, C].
 */
function decodeSCRFD(outputs, scale, padW, padH) {
  const outputEntries = []
  for (const name of Object.keys(outputs)) {
    const tensor = outputs[name]
    const dims = tensor.dims
    // Normalize dims: if [N, C], treat first dim as num_anchors
    // If [1, N, C], use second dim as num_anchors
    const numAnchors = dims.length === 2 ? dims[0] : dims[1]
    const lastDim = dims[dims.length - 1]
    outputEntries.push({ name, data: tensor.data, numAnchors, lastDim })
  }

  // Group outputs by num_anchors (each stride group has same anchor count)
  const groups = new Map()
  for (const entry of outputEntries) {
    if (!groups.has(entry.numAnchors)) groups.set(entry.numAnchors, [])
    groups.get(entry.numAnchors).push(entry)
  }

  // Sort groups by num_anchors descending (stride 8 = most anchors first)
  const sortedGroups = [...groups.entries()].sort((a, b) => b[0] - a[0])

  const detections = []

  for (let gi = 0; gi < sortedGroups.length && gi < STRIDES.length; gi++) {
    const stride = STRIDES[gi]
    const groupOutputs = sortedGroups[gi][1]

    // Identify by last dimension: 1=scores, 4=bbox, 10=keypoints
    let scoreData, bboxData, kpsData
    for (const out of groupOutputs) {
      if (out.lastDim === 1) scoreData = out.data
      else if (out.lastDim === 4) bboxData = out.data
      else if (out.lastDim === 10) kpsData = out.data
    }

    if (!scoreData || !bboxData) continue

    const featH = Math.ceil(DET_INPUT_SIZE / stride)
    const featW = Math.ceil(DET_INPUT_SIZE / stride)
    const anchors = generateAnchors(featH, featW, stride)

    for (let i = 0; i < anchors.length; i++) {
      // Scores are already probabilities (post-sigmoid in SCRFD ONNX)
      const score = scoreData[i]
      if (score < DET_CONF_THRESHOLD) continue

      const [cx, cy] = anchors[i]

      // Decode bbox: offsets from anchor center
      const x1 = (cx - bboxData[i * 4] * stride - padW) / scale
      const y1 = (cy - bboxData[i * 4 + 1] * stride - padH) / scale
      const x2 = (cx + bboxData[i * 4 + 2] * stride - padW) / scale
      const y2 = (cy + bboxData[i * 4 + 3] * stride - padH) / scale

      // Decode keypoints
      let keypoints = null
      if (kpsData) {
        keypoints = []
        for (let k = 0; k < 5; k++) {
          const kpx = (cx + kpsData[i * 10 + k * 2] * stride - padW) / scale
          const kpy = (cy + kpsData[i * 10 + k * 2 + 1] * stride - padH) / scale
          keypoints.push([kpx, kpy])
        }
      }

      detections.push({
        score,
        bbox: [x1, y1, x2, y2],
        keypoints,
      })
    }
  }

  return nms(detections, DET_NMS_THRESHOLD)
}

/**
 * Non-maximum suppression
 */
function nms(detections, threshold) {
  detections.sort((a, b) => b.score - a.score)
  const kept = []
  const suppressed = new Set()

  for (let i = 0; i < detections.length; i++) {
    if (suppressed.has(i)) continue
    kept.push(detections[i])

    for (let j = i + 1; j < detections.length; j++) {
      if (suppressed.has(j)) continue
      if (iou(detections[i].bbox, detections[j].bbox) > threshold) {
        suppressed.add(j)
      }
    }
  }
  return kept
}

function iou(a, b) {
  const ix1 = Math.max(a[0], b[0])
  const iy1 = Math.max(a[1], b[1])
  const ix2 = Math.min(a[2], b[2])
  const iy2 = Math.min(a[3], b[3])
  const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1)
  const areaA = (a[2] - a[0]) * (a[3] - a[1])
  const areaB = (b[2] - b[0]) * (b[3] - b[1])
  return inter / (areaA + areaB - inter + 1e-6)
}

// ── Face Alignment ──────────────────────────────────────────

/**
 * Compute similarity transform from src to dst points (5 pairs)
 * Returns 2×3 affine matrix
 */
function estimateSimilarityTransform(src, dst) {
  // Solve: [a -b tx; b a ty] mapping src → dst
  // Linear system: A * [a, b, tx, ty]^T = d
  const n = src.length
  const A = []
  const d = []

  for (let i = 0; i < n; i++) {
    A.push([src[i][0], -src[i][1], 1, 0])
    A.push([src[i][1], src[i][0], 0, 1])
    d.push(dst[i][0])
    d.push(dst[i][1])
  }

  // Solve via normal equations: (A^T A) params = A^T d
  const ATA = Array.from({ length: 4 }, () => new Float64Array(4))
  const ATd = new Float64Array(4)

  for (let i = 0; i < 2 * n; i++) {
    for (let j = 0; j < 4; j++) {
      ATd[j] += A[i][j] * d[i]
      for (let k = 0; k < 4; k++) {
        ATA[j][k] += A[i][j] * A[i][k]
      }
    }
  }

  // Solve 4×4 system via Gaussian elimination
  const aug = ATA.map((row, i) => [...row, ATd[i]])
  for (let col = 0; col < 4; col++) {
    let maxRow = col
    for (let row = col + 1; row < 4; row++) {
      if (Math.abs(aug[row][col]) > Math.abs(aug[maxRow][col])) maxRow = row
    }
    ;[aug[col], aug[maxRow]] = [aug[maxRow], aug[col]]

    for (let row = col + 1; row < 4; row++) {
      const factor = aug[row][col] / aug[col][col]
      for (let j = col; j < 5; j++) {
        aug[row][j] -= factor * aug[col][j]
      }
    }
  }

  const params = new Float64Array(4)
  for (let i = 3; i >= 0; i--) {
    params[i] = aug[i][4]
    for (let j = i + 1; j < 4; j++) {
      params[i] -= aug[i][j] * params[j]
    }
    params[i] /= aug[i][i]
  }

  const [a, b, tx, ty] = params

  // Forward transform matrix (src → dst)
  // To warp image, we need inverse (dst → src)
  const det = a * a + b * b
  const invA = a / det
  const invB = -b / det
  const invTx = -(a * tx + b * ty) / det
  const invTy = -(a * ty - b * tx) / det

  return {
    forward: [a, -b, tx, b, a, ty],
    inverse: [invA, invB, invTx, -invB, invA, invTy],
  }
}

/**
 * Warp face to 112×112 aligned image using similarity transform
 */
async function alignFace(imagePath, keypoints) {
  const transform = estimateSimilarityTransform(keypoints, ARCFACE_TEMPLATE)
  const M = transform.inverse // dst → src mapping

  const { data: srcData, info } = await sharp(imagePath)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  const srcW = info.width
  const srcH = info.height
  const outSize = REC_INPUT_SIZE
  const output = Buffer.alloc(outSize * outSize * 3)

  for (let y = 0; y < outSize; y++) {
    for (let x = 0; x < outSize; x++) {
      // Map destination → source (bilinear interpolation)
      const srcX = M[0] * x + M[1] * y + M[2]
      const srcY = M[3] * x + M[4] * y + M[5]

      const x0 = Math.floor(srcX)
      const y0 = Math.floor(srcY)
      const fx = srcX - x0
      const fy = srcY - y0

      const outIdx = (y * outSize + x) * 3

      for (let c = 0; c < 3; c++) {
        const v00 = getPixel(srcData, srcW, srcH, x0, y0, c)
        const v10 = getPixel(srcData, srcW, srcH, x0 + 1, y0, c)
        const v01 = getPixel(srcData, srcW, srcH, x0, y0 + 1, c)
        const v11 = getPixel(srcData, srcW, srcH, x0 + 1, y0 + 1, c)

        output[outIdx + c] = Math.round(
          v00 * (1 - fx) * (1 - fy) +
          v10 * fx * (1 - fy) +
          v01 * (1 - fx) * fy +
          v11 * fx * fy,
        )
      }
    }
  }

  return output
}

function getPixel(data, w, h, x, y, c) {
  if (x < 0 || x >= w || y < 0 || y >= h) return 0
  return data[(y * w + x) * 3 + c]
}

// ── ArcFace Recognition ─────────────────────────────────────

/**
 * Extract 512-dim face embedding from aligned face buffer
 */
async function getEmbedding(alignedRGB) {
  const size = REC_INPUT_SIZE
  const float32 = new Float32Array(3 * size * size)

  // HWC → NCHW, normalize: (pixel - 127.5) / 127.5
  for (let i = 0; i < size * size; i++) {
    float32[i] = (alignedRGB[i * 3] - 127.5) / 127.5                     // R
    float32[size * size + i] = (alignedRGB[i * 3 + 1] - 127.5) / 127.5   // G
    float32[2 * size * size + i] = (alignedRGB[i * 3 + 2] - 127.5) / 127.5 // B
  }

  const tensor = new ort.Tensor("float32", float32, [1, 3, size, size])
  const result = await recSession.run({ [recSession.inputNames[0]]: tensor })
  const embedding = result[recSession.outputNames[0]].data

  // L2 normalize
  let norm = 0
  for (let i = 0; i < embedding.length; i++) norm += embedding[i] * embedding[i]
  norm = Math.sqrt(norm)

  const normalized = new Float32Array(embedding.length)
  for (let i = 0; i < embedding.length; i++) normalized[i] = embedding[i] / norm

  return normalized
}

/**
 * Cosine similarity between two L2-normalized embeddings
 */
function cosineSimilarity(a, b) {
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return dot
}

// ── Public API ──────────────────────────────────────────────

/**
 * Detect faces in an image
 * Returns array of { score, bbox: [x1,y1,x2,y2], keypoints: [[x,y]×5] }
 */
async function detectFaces(imagePath) {
  if (!isReady) {
    const ok = await init()
    if (!ok) return []
  }

  const { tensor, scale, padW, padH } = await prepareDetInput(imagePath)
  const result = await detSession.run({ [detSession.inputNames[0]]: tensor })

  return decodeSCRFD(result, scale, padW, padH)
}

/**
 * Get face embedding from an image (detect → align → embed)
 * Returns { embedding: Float32Array(512), face: detection } or null
 */
async function getFaceEmbedding(imagePath) {
  const faces = await detectFaces(imagePath)

  if (faces.length === 0) {
    console.log(`  ⚠ No face detected in: ${path.basename(imagePath)}`)
    return null
  }

  // Pick the largest face (by bbox area)
  const face = faces.reduce((best, f) => {
    const area = (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1])
    const bestArea = (best.bbox[2] - best.bbox[0]) * (best.bbox[3] - best.bbox[1])
    return area > bestArea ? f : best
  })

  if (!face.keypoints) {
    console.log("  ⚠ No keypoints detected — cannot align face")
    return null
  }

  const aligned = await alignFace(imagePath, face.keypoints)
  const embedding = await getEmbedding(aligned)

  return { embedding, face }
}

/**
 * Compare two face images
 * Returns similarity score:
 *   > 0.5  = definitely same person
 *   0.3-0.5 = likely same person
 *   < 0.3  = different person
 *   -1     = error / no face detected
 */
async function compareFaces(img1Path, img2Path) {
  try {
    if (!isReady) {
      const ok = await init()
      if (!ok) return -1
    }

    // Use cached reference embedding if available
    let emb1 = cachedReferenceEmbedding
    if (!emb1) {
      const result1 = await getFaceEmbedding(img1Path)
      if (!result1) return -1
      emb1 = result1.embedding
    }

    const result2 = await getFaceEmbedding(img2Path)
    if (!result2) return 0 // No face in capture = suspicious

    const similarity = cosineSimilarity(emb1, result2.embedding)

    // Map cosine similarity to percentage for display
    // ArcFace cosine: >0.5 = same, <0.3 = different
    // Map to 0-100% scale: 0.3→0%, 0.5→80%, 0.7→100%
    const displayPct = Math.max(0, Math.min(100, ((similarity - 0.2) / 0.5) * 100))

    console.log(`  ArcFace cosine: ${similarity.toFixed(4)} → display: ${displayPct.toFixed(1)}% [${similarity >= 0.4 ? "MATCH" : "NO MATCH"}]`)

    return { similarity, displayPct, isSamePerson: similarity >= 0.4 }
  } catch (err) {
    console.error("  Face comparison failed:", err.message)
    return -1
  }
}

/**
 * Cache the reference face embedding (call once, reuse for all comparisons)
 */
async function cacheReferenceEmbedding(imagePath) {
  const result = await getFaceEmbedding(imagePath)
  if (result) {
    cachedReferenceEmbedding = result.embedding
    console.log("  ✅ Reference face embedding cached (512-dim ArcFace)")
    return true
  }
  return false
}

/**
 * Clear the cached reference embedding
 */
function clearCache() {
  cachedReferenceEmbedding = null
}

export {
  init,
  detectFaces,
  getFaceEmbedding,
  compareFaces,
  cacheReferenceEmbedding,
  clearCache,
  cosineSimilarity,
}

export default {
  init,
  detectFaces,
  getFaceEmbedding,
  compareFaces,
  cacheReferenceEmbedding,
  clearCache,
}
