"use client";

import { useState } from "react";
import { ChevronsLeftRight } from "lucide-react";

import { cn } from "@/lib/utils";

type ImageComparisonSliderProps = {
  originalSrc: string;
  restoredSrc: string;
  className?: string;
};

export function ImageComparisonSlider({
  originalSrc,
  restoredSrc,
  className,
}: ImageComparisonSliderProps) {
  const [position, setPosition] = useState(50);

  return (
    <div
      className={cn(
        "relative h-[24rem] min-h-[22rem] w-full overflow-hidden bg-stone-100 select-none sm:h-[30rem] dark:bg-stone-950",
        className,
      )}
    >
      {/* Dynamic and local object URLs cannot use the static image optimizer. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={restoredSrc}
        alt="高清修复后的图片"
        className="pointer-events-none absolute inset-0 size-full object-contain"
      />
      <div
        className="pointer-events-none absolute inset-0 overflow-hidden"
        style={{ clipPath: `inset(0 ${100 - position}% 0 0)` }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={originalSrc}
          alt="高清修复前的原图"
          className="absolute inset-0 size-full object-contain"
        />
      </div>

      <span className="pointer-events-none absolute top-3 left-3 rounded-full bg-black/65 px-3 py-1.5 text-xs font-semibold text-white backdrop-blur-sm">
        原图
      </span>
      <span className="pointer-events-none absolute top-3 right-3 rounded-full bg-violet-700/90 px-3 py-1.5 text-xs font-semibold text-white backdrop-blur-sm">
        修复后
      </span>

      <input
        type="range"
        min="0"
        max="100"
        value={position}
        onChange={(event) => setPosition(Number(event.target.value))}
        aria-label="调整原图与修复图对比位置"
        aria-valuetext={`原图显示 ${position}%`}
        className="peer absolute inset-0 z-10 size-full cursor-ew-resize opacity-0"
      />
      <div
        className="pointer-events-none absolute inset-y-0 w-0.5 bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.22),0_0_18px_rgba(0,0,0,0.3)] transition-[width,background-color] peer-focus-visible:w-1 peer-focus-visible:bg-violet-300 motion-reduce:transition-none"
        style={{ left: `${position}%` }}
        aria-hidden="true"
      >
        <span className="absolute top-1/2 left-1/2 grid size-11 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border-2 border-white bg-violet-700 text-white shadow-lg peer-focus-visible:ring-4 peer-focus-visible:ring-violet-300/60">
          <ChevronsLeftRight className="size-5" />
        </span>
      </div>
      <p className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-3 py-1.5 text-xs font-medium whitespace-nowrap text-white backdrop-blur-sm">
        左右拖动查看修复差异
      </p>
    </div>
  );
}
