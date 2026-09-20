import {
  renderAdjustments,
  neutralAdjustments,
  type AdjustmentParameters,
  type WorkingFrame,
} from '../../../shared/adjustments'
let beforeSent = false
let frame: WorkingFrame | undefined
self.onmessage = async (
  event: MessageEvent<{ frame?: WorkingFrame; parameters?: AdjustmentParameters }>,
) => {
  if (event.data.frame) frame = event.data.frame
  if (frame && event.data.parameters !== undefined) {
    const parameters = event.data.parameters
    const bitmap = await createImageBitmap(
      new ImageData(
        renderAdjustments(frame.data, parameters, frame.transform),
        frame.width,
        frame.height,
      ),
    )
    const before = !beforeSent
      ? await createImageBitmap(
          new ImageData(
            renderAdjustments(frame.data, neutralAdjustments, frame.transform),
            frame.width,
            frame.height,
          ),
        )
      : undefined
    beforeSent = true
    self.postMessage(
      { parameters, bitmap, before },
      { transfer: before ? [bitmap, before] : [bitmap] },
    )
  }
}
