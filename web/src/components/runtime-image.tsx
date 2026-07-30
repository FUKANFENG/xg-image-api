"use client";

import Image, { type ImageProps } from "next/image";

type RuntimeImageProps = Omit<ImageProps, "width" | "height" | "alt"> & {
  width?: number;
  height?: number;
  alt?: string;
};

/** Dynamic user/upstream images cannot use the Next optimizer safely. */
export function RuntimeImage({ width = 1024, height = 1024, alt = "", ...props }: RuntimeImageProps) {
  return <Image {...props} src={props.src} alt={alt} width={width} height={height} unoptimized />;
}
