"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { ChevronLeft, ChevronRight, Download, RotateCcw, X, ZoomIn, ZoomOut } from "lucide-react";

import {
  MAX_LIGHTBOX_SCALE,
  MIN_LIGHTBOX_SCALE,
  clampLightboxValue,
  normalizeLightboxTransform,
  type LightboxTransform,
  zoomLightboxAtPoint,
} from "@/lib/image-lightbox-geometry";
import { cn } from "@/lib/utils";
import { RuntimeImage } from "@/components/runtime-image";

type LightboxImage = {
  id: string;
  src: string;
  sizeLabel?: string;
  dimensions?: string;
};

type ImageLightboxProps = {
  images: LightboxImage[];
  currentIndex: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onIndexChange: (index: number) => void;
};

type TouchPoints = {
  [index: number]: React.Touch;
};

type TouchGesture =
  | {
      type: "swipe";
      startX: number;
      startY: number;
    }
  | {
      type: "pan";
      startX: number;
      startY: number;
      startTransform: LightboxTransform;
    }
  | {
      type: "pinch";
      startDistance: number;
      startCenterX: number;
      startCenterY: number;
      startTransform: LightboxTransform;
    };

type PointerGesture = {
  pointerId: number;
  startX: number;
  startY: number;
  startTransform: LightboxTransform;
};

function getTouchDistance(touches: TouchPoints) {
  const first = touches[0];
  const second = touches[1];
  return Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY);
}

function getTouchCenter(touches: TouchPoints) {
  const first = touches[0];
  const second = touches[1];
  return {
    x: (first.clientX + second.clientX) / 2,
    y: (first.clientY + second.clientY) / 2,
  };
}

export function ImageLightbox({
  images,
  currentIndex,
  open,
  onOpenChange,
  onIndexChange,
}: ImageLightboxProps) {
  const currentId = images[currentIndex]?.id || "empty";
  return (
    <ImageLightboxContent
      key={`${currentId}:${open ? "open" : "closed"}`}
      images={images}
      currentIndex={currentIndex}
      open={open}
      onOpenChange={onOpenChange}
      onIndexChange={onIndexChange}
    />
  );
}

function ImageLightboxContent({
  images,
  currentIndex,
  open,
  onOpenChange,
  onIndexChange,
}: ImageLightboxProps) {
  const gestureRef = useRef<TouchGesture | null>(null);
  const pointerGestureRef = useRef<PointerGesture | null>(null);
  const lastTapRef = useRef(0);
  const pendingTransformRef = useRef<LightboxTransform | null>(null);
  const rafRef = useRef<number | null>(null);
  const [transform, setTransform] = useState<LightboxTransform>({ scale: 1, x: 0, y: 0 });
  const [isGesturing, setIsGesturing] = useState(false);
  const current = images[currentIndex];
  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex < images.length - 1;

  const cancelScheduledTransform = useCallback(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    pendingTransformRef.current = null;
  }, []);

  const scheduleTransform = useCallback((next: LightboxTransform) => {
    pendingTransformRef.current = next;
    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const pending = pendingTransformRef.current;
      pendingTransformRef.current = null;
      if (pending) {
        setTransform(pending);
      }
    });
  }, []);

  const flushScheduledTransform = useCallback(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    const pending = pendingTransformRef.current;
    pendingTransformRef.current = null;
    if (pending) {
      setTransform(pending);
    }
  }, []);

  const resetTransform = useCallback(() => {
    cancelScheduledTransform();
    setTransform({ scale: 1, x: 0, y: 0 });
    setIsGesturing(false);
    gestureRef.current = null;
    pointerGestureRef.current = null;
  }, [cancelScheduledTransform]);

  const goPrev = useCallback(() => {
    if (hasPrev) onIndexChange(currentIndex - 1);
  }, [hasPrev, currentIndex, onIndexChange]);

  const goNext = useCallback(() => {
    if (hasNext) onIndexChange(currentIndex + 1);
  }, [hasNext, currentIndex, onIndexChange]);

  useEffect(() => {
    return () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        goPrev();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        goNext();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, goPrev, goNext]);

  const handleDownload = useCallback(() => {
    if (!current) return;
    const link = document.createElement("a");
    link.href = current.src;
    link.download = `image-${current.id}.png`;
    link.click();
  }, [current]);

  const zoomAtPoint = useCallback(
    (requestedScale: number, point: { x: number; y: number }) => {
      const activeTransform = pendingTransformRef.current || transform;
      scheduleTransform(
        zoomLightboxAtPoint(
          activeTransform,
          requestedScale,
          point,
          { width: window.innerWidth, height: window.innerHeight },
        ),
      );
    },
    [scheduleTransform, transform],
  );

  const zoomBy = useCallback(
    (factor: number) => {
      const activeTransform = pendingTransformRef.current || transform;
      zoomAtPoint(activeTransform.scale * factor, { x: window.innerWidth * 0.5, y: window.innerHeight * 0.5 });
    },
    [transform, zoomAtPoint],
  );

  const toggleZoom = useCallback(() => {
    const activeTransform = pendingTransformRef.current || transform;
    if (activeTransform.scale > MIN_LIGHTBOX_SCALE) {
      resetTransform();
      return;
    }
    zoomAtPoint(2.5, { x: window.innerWidth * 0.5, y: window.innerHeight * 0.5 });
  }, [resetTransform, transform, zoomAtPoint]);

  const handleTouchStart = useCallback(
    (event: React.TouchEvent<HTMLDivElement>) => {
      if (event.touches.length === 2) {
        event.preventDefault();
        const startDistance = getTouchDistance(event.touches);
        if (startDistance < 1) {
          gestureRef.current = null;
          return;
        }
        const center = getTouchCenter(event.touches);
        cancelScheduledTransform();
        setIsGesturing(true);
        gestureRef.current = {
          type: "pinch",
          startDistance,
          startCenterX: center.x,
          startCenterY: center.y,
          startTransform: transform,
        };
        return;
      }

      if (event.touches.length !== 1) {
        gestureRef.current = null;
        return;
      }

      const touch = event.touches[0];
      if (transform.scale > MIN_LIGHTBOX_SCALE) {
        cancelScheduledTransform();
        setIsGesturing(true);
        gestureRef.current = {
          type: "pan",
          startX: touch.clientX,
          startY: touch.clientY,
          startTransform: transform,
        };
      } else {
        gestureRef.current = {
          type: "swipe",
          startX: touch.clientX,
          startY: touch.clientY,
        };
      }
    },
    [transform, cancelScheduledTransform],
  );

  const handleTouchMove = useCallback(
    (event: React.TouchEvent<HTMLDivElement>) => {
      const gesture = gestureRef.current;
      if (!gesture) return;

      if (gesture.type === "pinch" && event.touches.length === 2) {
        event.preventDefault();
        const targetScale = clampLightboxValue(
          (getTouchDistance(event.touches) / gesture.startDistance) * gesture.startTransform.scale,
          MIN_LIGHTBOX_SCALE,
          MAX_LIGHTBOX_SCALE,
        );
        const effectiveRatio = targetScale / gesture.startTransform.scale;
        const center = getTouchCenter(event.touches);
        const viewportCenterX = window.innerWidth / 2;
        const viewportCenterY = window.innerHeight / 2;
        const nextX =
          center.x -
          viewportCenterX -
          (gesture.startCenterX - viewportCenterX - gesture.startTransform.x) * effectiveRatio;
        const nextY =
          center.y -
          viewportCenterY -
          (gesture.startCenterY - viewportCenterY - gesture.startTransform.y) * effectiveRatio;
        scheduleTransform(
          normalizeLightboxTransform(
            { scale: targetScale, x: nextX, y: nextY },
            { width: window.innerWidth, height: window.innerHeight },
          ),
        );
        return;
      }

      if (gesture.type === "pan" && event.touches.length === 1) {
        event.preventDefault();
        const touch = event.touches[0];
        scheduleTransform(normalizeLightboxTransform(
          {
            scale: gesture.startTransform.scale,
            x: gesture.startTransform.x + touch.clientX - gesture.startX,
            y: gesture.startTransform.y + touch.clientY - gesture.startY,
          },
          { width: window.innerWidth, height: window.innerHeight },
        ));
        return;
      }

      if (event.touches.length !== 1) {
        gestureRef.current = null;
      }
    },
    [scheduleTransform],
  );

  const handleTouchEnd = useCallback(
    (event: React.TouchEvent<HTMLDivElement>) => {
      flushScheduledTransform();
      setIsGesturing(false);

      const gesture = gestureRef.current;
      gestureRef.current = null;
      if (!gesture) return;

      if (gesture.type !== "swipe" || event.changedTouches.length !== 1) {
        return;
      }

      const touch = event.changedTouches[0];
      const deltaX = touch.clientX - gesture.startX;
      const deltaY = touch.clientY - gesture.startY;
      const now = Date.now();

      if (Math.abs(deltaX) < 10 && Math.abs(deltaY) < 10 && now - lastTapRef.current < 280) {
        event.preventDefault();
        lastTapRef.current = 0;
        toggleZoom();
        return;
      }
      lastTapRef.current = now;

      if (Math.abs(deltaX) < 48 || Math.abs(deltaX) < Math.abs(deltaY) * 1.4) {
        return;
      }

      if (deltaX > 0) {
        goPrev();
      } else {
        goNext();
      }
    },
    [goPrev, goNext, toggleZoom, flushScheduledTransform],
  );

  const handleTouchCancel = useCallback(() => {
    cancelScheduledTransform();
    setIsGesturing(false);
    gestureRef.current = null;
  }, [cancelScheduledTransform]);

  const handleWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      event.preventDefault();
      const activeTransform = pendingTransformRef.current || transform;
      const wheelFactor = Math.exp(-event.deltaY * 0.0015);
      zoomAtPoint(activeTransform.scale * wheelFactor, { x: event.clientX, y: event.clientY });
    },
    [transform, zoomAtPoint],
  );

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLImageElement>) => {
      const activeTransform = pendingTransformRef.current || transform;
      if (event.pointerType === "touch" || activeTransform.scale <= MIN_LIGHTBOX_SCALE) {
        return;
      }
      event.preventDefault();
      cancelScheduledTransform();
      pointerGestureRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startTransform: activeTransform,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      setIsGesturing(true);
    },
    [cancelScheduledTransform, transform],
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLImageElement>) => {
      const gesture = pointerGestureRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId) {
        return;
      }
      event.preventDefault();
      scheduleTransform(normalizeLightboxTransform(
        {
          scale: gesture.startTransform.scale,
          x: gesture.startTransform.x + event.clientX - gesture.startX,
          y: gesture.startTransform.y + event.clientY - gesture.startY,
        },
        { width: window.innerWidth, height: window.innerHeight },
      ));
    },
    [scheduleTransform],
  );

  const handlePointerEnd = useCallback(
    (event: React.PointerEvent<HTMLImageElement>) => {
      if (pointerGestureRef.current?.pointerId !== event.pointerId) {
        return;
      }
      flushScheduledTransform();
      pointerGestureRef.current = null;
      setIsGesturing(false);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    },
    [flushScheduledTransform],
  );

  if (!current) return null;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          className="fixed inset-0 z-50 flex items-center justify-center outline-none"
          onPointerDownOutside={(e) => e.preventDefault()}
        >
          <DialogPrimitive.Title className="sr-only">
            图片预览
          </DialogPrimitive.Title>

          <div className="absolute top-[calc(env(safe-area-inset-top)+1rem)] right-4 z-10 flex items-center gap-2">
            {current.sizeLabel || current.dimensions ? (
              <span className="rounded-full bg-black/50 px-3 py-1.5 text-xs font-medium text-white/90">
                {[current.sizeLabel, current.dimensions].filter(Boolean).join(" · ")}
              </span>
            ) : null}
            {images.length > 1 && (
              <span className="rounded-full bg-black/50 px-3 py-1.5 text-xs font-medium text-white/90">
                {currentIndex + 1} / {images.length}
              </span>
            )}
            <div className="hidden items-center rounded-full bg-black/50 p-1 sm:flex">
              <button
                type="button"
                onClick={() => zoomBy(1 / 1.25)}
                className="inline-flex size-11 items-center justify-center rounded-full text-white/90 transition hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                aria-label="缩小图片"
                title="缩小图片"
                disabled={transform.scale <= MIN_LIGHTBOX_SCALE}
              >
                <ZoomOut className="size-4" />
              </button>
              <span className="min-w-12 text-center text-xs font-medium tabular-nums text-white/90" aria-label={`当前缩放 ${Math.round(transform.scale * 100)}%`}>
                {Math.round(transform.scale * 100)}%
              </span>
              <button
                type="button"
                onClick={() => zoomBy(1.25)}
                className="inline-flex size-11 items-center justify-center rounded-full text-white/90 transition hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                aria-label="放大图片"
                title="放大图片"
                disabled={transform.scale >= MAX_LIGHTBOX_SCALE}
              >
                <ZoomIn className="size-4" />
              </button>
              {transform.scale > MIN_LIGHTBOX_SCALE ? (
                <button
                  type="button"
                  onClick={resetTransform}
                  className="inline-flex size-11 items-center justify-center rounded-full text-white/90 transition hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                  aria-label="重置缩放和位置"
                  title="重置缩放和位置"
                >
                  <RotateCcw className="size-4" />
                </button>
              ) : null}
            </div>
            <button
              type="button"
              onClick={handleDownload}
              className="inline-flex size-11 items-center justify-center rounded-full bg-black/50 text-white/90 transition hover:bg-black/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
              aria-label="下载图片"
              title="下载图片"
            >
              <Download className="size-4" />
            </button>
            <DialogPrimitive.Close className="inline-flex size-11 items-center justify-center rounded-full bg-black/50 text-white/90 transition hover:bg-black/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white" title="关闭预览">
              <X className="size-4" />
              <span className="sr-only">关闭</span>
            </DialogPrimitive.Close>
          </div>

          {hasPrev && transform.scale <= MIN_LIGHTBOX_SCALE && (
            <button
              type="button"
              onClick={goPrev}
              className="absolute left-4 z-10 inline-flex size-10 items-center justify-center rounded-full bg-black/40 text-white/90 transition hover:bg-black/60"
              aria-label="上一张"
            >
              <ChevronLeft className="size-5" />
            </button>
          )}

          <div
            className="flex h-full w-full touch-none items-center justify-center overflow-hidden"
            onClick={() => onOpenChange(false)}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
            onTouchCancel={handleTouchCancel}
            onWheel={handleWheel}
          >
            <RuntimeImage
              src={current.src}
              alt=""
              className={cn(
                "max-h-[90vh] max-w-[90vw] select-none rounded-lg object-contain will-change-transform",
                isGesturing ? "" : "transition-transform duration-150 ease-out",
                transform.scale > MIN_LIGHTBOX_SCALE ? "cursor-grab active:cursor-grabbing" : "cursor-zoom-in",
              )}
              style={{
                transform: `translate3d(${transform.x}px, ${transform.y}px, 0) scale(${transform.scale})`,
              }}
              onClick={(e) => e.stopPropagation()}
              onDoubleClick={(e) => {
                e.stopPropagation();
                toggleZoom();
              }}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerEnd}
              onPointerCancel={handlePointerEnd}
              onDragStart={(event) => event.preventDefault()}
              draggable={false}
            />
          </div>

          {hasNext && transform.scale <= MIN_LIGHTBOX_SCALE && (
            <button
              type="button"
              onClick={goNext}
              className="absolute right-4 z-10 inline-flex size-10 items-center justify-center rounded-full bg-black/40 text-white/90 transition hover:bg-black/60"
              aria-label="下一张"
            >
              <ChevronRight className="size-5" />
            </button>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
