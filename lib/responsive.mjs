export const VIEWPORT_BREAKPOINTS = Object.freeze({
  compactMax: 430,
  mobileMax: 767,
  tabletMax: 1199
});

export function describeViewport(width = 0, height = 0) {
  const safeWidth = Math.max(320, Math.round(Number(width) || 0));
  const safeHeight = Math.max(1, Math.round(Number(height) || 0));
  const layoutMode = safeWidth <= VIEWPORT_BREAKPOINTS.compactMax
    ? "compact"
    : safeWidth <= VIEWPORT_BREAKPOINTS.mobileMax
      ? "mobile"
      : safeWidth <= VIEWPORT_BREAKPOINTS.tabletMax
        ? "tablet"
        : "wide";
  return {
    viewportWidth: safeWidth,
    viewportHeight: safeHeight,
    layoutMode,
    orientation: safeWidth >= safeHeight ? "landscape" : "portrait"
  };
}

export function scaleCameraForResize(camera = {}, previousFrame = {}, nextFrame = {}) {
  const previousWidth = Math.max(1, Number(previousFrame.width) || 1);
  const previousHeight = Math.max(1, Number(previousFrame.height) || 1);
  const nextWidth = Math.max(1, Number(nextFrame.width) || previousWidth);
  const nextHeight = Math.max(1, Number(nextFrame.height) || previousHeight);
  return {
    zoom: Number(camera.zoom) || 1,
    x: (Number(camera.x) || 0) * nextWidth / previousWidth,
    y: (Number(camera.y) || 0) * nextHeight / previousHeight
  };
}
