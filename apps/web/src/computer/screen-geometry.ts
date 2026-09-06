/** The rendered canvas has the stream's aspect ratio, so pointer positions scale without cropping. */
export const remotePoint = (
  point: { x: number; y: number },
  box: { left: number; top: number; width: number; height: number },
  viewport: { width: number; height: number }
): { x: number; y: number } => ({
  x: Math.round(
    Math.max(
      0,
      Math.min(viewport.width - 1, ((point.x - box.left) / Math.max(1, box.width)) * viewport.width)
    )
  ),
  y: Math.round(
    Math.max(
      0,
      Math.min(
        viewport.height - 1,
        ((point.y - box.top) / Math.max(1, box.height)) * viewport.height
      )
    )
  )
});
