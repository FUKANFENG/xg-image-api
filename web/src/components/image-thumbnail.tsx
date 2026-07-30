"use client";

import { useMemo, useState } from "react";

import { cn } from "@/lib/utils";
import { RuntimeImage } from "@/components/runtime-image";

type ImageThumbnailProps = {
  src: string;
  thumbnailSrc?: string;
  alt?: string;
  className?: string;
  imageClassName?: string;
};

export function getImageThumbnailUrl(src: string) {
  const marker = "/images/";
  const index = src.indexOf(marker);
  if (index < 0) return src;
  return `${src.slice(0, index)}/image-thumbnails/${src.slice(index + marker.length)}`;
}

export function ImageThumbnail({ src, thumbnailSrc, alt = "", className, imageClassName }: ImageThumbnailProps) {
  const initialSrc = useMemo(() => thumbnailSrc || getImageThumbnailUrl(src), [src, thumbnailSrc]);

  return (
    <ThumbnailImage
      key={initialSrc}
      src={src}
      initialSrc={initialSrc}
      alt={alt}
      className={className}
      imageClassName={imageClassName}
    />
  );
}

function ThumbnailImage({ src, initialSrc, alt, className, imageClassName }: ImageThumbnailProps & { initialSrc: string }) {
  const [currentSrc, setCurrentSrc] = useState(initialSrc);

  return (
    <span className={cn("block overflow-hidden bg-stone-100", className)}>
      <RuntimeImage
        src={currentSrc}
        alt={alt}
        className={cn("h-full w-full object-cover", imageClassName)}
        loading="lazy"
        decoding="async"
        onError={() => {
          if (currentSrc !== src) {
            setCurrentSrc(src);
          }
        }}
      />
    </span>
  );
}
