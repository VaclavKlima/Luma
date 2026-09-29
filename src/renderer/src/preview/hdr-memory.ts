export const HDR_PRESENTATION_BUDGET = 512 * 1024 ** 2
export const HDR_TRANSPORT_CHUNK_BYTES = 1024 * 1024
/** Upload buffers are released before analysis and the full presentation surface are allocated. */
export function hdrPresentationMemory(
  width: number,
  height: number,
  canvasWidth = 0,
  canvasHeight = 0,
) {
  let textureBytes = 0,
    maskBytes = 0
  for (
    let w = width, h = height;
    ;
    w = Math.max(1, Math.floor(w / 2)), h = Math.max(1, Math.floor(h / 2))
  ) {
    textureBytes += w * h * 16
    if (w === 1 && h === 1) break
  }
  for (let w = width, h = height; ; w = Math.ceil(w / 2), h = Math.ceil(h / 2)) {
    maskBytes += w * h
    if (w === 1 && h === 1) break
  }
  const stripBytes = width * Math.min(64, height) * 16
  const uploadBytes = stripBytes * 6
  const analysisBytes = maskBytes + stripBytes + Math.min(65536, width * height) * 16 * 3
  const canvasBytes = canvasWidth * canvasHeight * 24
  const transportBytes = HDR_TRANSPORT_CHUNK_BYTES * 2
  const sampleBytes = Math.min(65536, width * height) * 16 * 3
  const uploadPeak = textureBytes + uploadBytes + transportBytes + sampleBytes
  const presentationPeak = textureBytes + analysisBytes + canvasBytes + transportBytes
  return {
    textureBytes,
    uploadBytes,
    analysisBytes,
    canvasBytes,
    transportBytes,
    uploadPeak,
    presentationPeak,
    total: Math.max(uploadPeak, presentationPeak),
  }
}
