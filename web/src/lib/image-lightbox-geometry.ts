export const MIN_LIGHTBOX_SCALE = 1;
export const MAX_LIGHTBOX_SCALE = 4;

export type LightboxTransform = {
  scale: number;
  x: number;
  y: number;
};

export type LightboxViewport = {
  width: number;
  height: number;
};

export type LightboxPoint = {
  x: number;
  y: number;
};

export function clampLightboxValue(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function normalizeLightboxTransform(transform: LightboxTransform, viewport: LightboxViewport): LightboxTransform {
  const scale = clampLightboxValue(transform.scale, MIN_LIGHTBOX_SCALE, MAX_LIGHTBOX_SCALE);
  if (scale <= MIN_LIGHTBOX_SCALE) {
    return { scale: MIN_LIGHTBOX_SCALE, x: 0, y: 0 };
  }

  const maxX = viewport.width * (scale - 1) * 0.5;
  const maxY = viewport.height * (scale - 1) * 0.5;
  return {
    scale,
    x: clampLightboxValue(transform.x, -maxX, maxX),
    y: clampLightboxValue(transform.y, -maxY, maxY),
  };
}

export function zoomLightboxAtPoint(
  transform: LightboxTransform,
  requestedScale: number,
  point: LightboxPoint,
  viewport: LightboxViewport,
): LightboxTransform {
  const scale = clampLightboxValue(requestedScale, MIN_LIGHTBOX_SCALE, MAX_LIGHTBOX_SCALE);
  if (scale <= MIN_LIGHTBOX_SCALE) {
    return { scale: MIN_LIGHTBOX_SCALE, x: 0, y: 0 };
  }

  const ratio = scale / Math.max(MIN_LIGHTBOX_SCALE, transform.scale);
  const viewportCenterX = viewport.width * 0.5;
  const viewportCenterY = viewport.height * 0.5;
  return normalizeLightboxTransform(
    {
      scale,
      x: point.x - viewportCenterX - (point.x - viewportCenterX - transform.x) * ratio,
      y: point.y - viewportCenterY - (point.y - viewportCenterY - transform.y) * ratio,
    },
    viewport,
  );
}
