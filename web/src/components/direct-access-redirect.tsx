"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircle } from "lucide-react";

export function DirectAccessRedirect() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/console");
  }, [router]);

  return (
    <div
      role="status"
      className="grid min-h-[60vh] place-items-center text-stone-500"
    >
      <span className="inline-flex items-center gap-2 text-sm">
        <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
        正在进入本机控制台…
      </span>
    </div>
  );
}
