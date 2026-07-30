export type CanvasRatio = "1:1" | "4:3" | "3:4" | "16:9" | "9:16";
export type OutpaintDirection = "left" | "right" | "top" | "bottom";

const RATIOS: Record<CanvasRatio, number> = {
  "1:1": 1,
  "4:3": 4 / 3,
  "3:4": 3 / 4,
  "16:9": 16 / 9,
  "9:16": 9 / 16,
};

export type OutpaintGeometry = {
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
};

function anchoredOffset(
  added: number,
  negativeSelected: boolean,
  positiveSelected: boolean,
) {
  if (added <= 0) return 0;
  if (negativeSelected && !positiveSelected) return added;
  if (!negativeSelected && positiveSelected) return 0;
  return Math.floor(added / 2);
}

export function calculateOutpaintGeometry(
  sourceWidth: number,
  sourceHeight: number,
  ratio: CanvasRatio,
  directions: OutpaintDirection[],
): OutpaintGeometry {
    const width = Math.max(1, Math.round(sourceWidth));
    const height = Math.max(1, Math.round(sourceHeight));
    if (directions.length === 0) {
        return { width, height, offsetX: 0, offsetY: 0 };
    }
    const targetRatio = RATIOS[ratio];
    const sourceRatio = width / height;
    const ratioWidth =
        sourceRatio < targetRatio ? Math.ceil(height * targetRatio) : width;
    const ratioHeight =
        sourceRatio > targetRatio ? Math.ceil(width / targetRatio) : height;
    const horizontal = directions.includes("left") || directions.includes("right");
    const vertical = directions.includes("top") || directions.includes("bottom");
    let targetWidth = horizontal ? Math.max(ratioWidth, Math.ceil(width * 1.25)) : ratioWidth;
    let targetHeight = vertical ? Math.max(ratioHeight, Math.ceil(height * 1.25)) : ratioHeight;
    const directionExpanded = targetWidth > ratioWidth || targetHeight > ratioHeight;
    if (directionExpanded) {
        if (targetWidth / targetHeight < targetRatio) {
            targetWidth = Math.ceil(targetHeight * targetRatio);
        } else if (targetWidth / targetHeight > targetRatio) {
            targetHeight = Math.ceil(targetWidth / targetRatio);
        }
    }
  const addedX = targetWidth - width;
  const addedY = targetHeight - height;
  return {
    width: targetWidth,
    height: targetHeight,
    offsetX: anchoredOffset(
      addedX,
      directions.includes("left"),
      directions.includes("right"),
    ),
    offsetY: anchoredOffset(
      addedY,
      directions.includes("top"),
      directions.includes("bottom"),
    ),
  };
}

export function imageModelSizeForRatio(ratio: CanvasRatio) {
  const value = RATIOS[ratio];
  if (value > 1.08) return "1536x1024";
  if (value < 0.92) return "1024x1536";
  return "1024x1024";
}
