"use client";

import {
  ChangeEvent,
  PointerEvent as ReactPointerEvent,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Brush,
  Check,
  ChevronDown,
  ChevronUp,
  Crop,
  Download,
  Eraser,
  Expand,
  Eye,
  EyeOff,
  ImagePlus,
  Layers3,
  LoaderCircle,
  MousePointer2,
  Redo2,
  RotateCw,
  Save,
  Scissors,
  Send,
  Share2,
  Sparkles,
  Trash2,
  Type,
  Undo2,
} from "lucide-react";
import { toast } from "sonner";

import { ImageComparisonSlider } from "@/components/image-comparison-slider";
import { Button } from "@/components/ui/button";
import {
  activateCreativeVersion,
  createAssetShare,
  createImageEditTask,
  fetchConsistencyProfiles,
  fetchCreativeAsset,
  fetchImageTasks,
  saveCanvasVersion,
  submitAssetReview,
  type CreativeAsset,
  type CreativeVersion,
  type ConsistencyProfile,
  type ConsistencyStrength,
  type ImageTask,
} from "@/lib/api";
import {
  calculateOutpaintGeometry,
  imageModelSizeForRatio,
  type CanvasRatio,
  type OutpaintDirection,
} from "@/lib/canvas-outpaint";
import { USER_DEFAULT_IMAGE_MODEL } from "@/lib/image-model-policy";
import { useAuthGuard } from "@/lib/use-auth-guard";
import { cn } from "@/lib/utils";

type Tool = "select" | "brush" | "erase" | "crop";
type TextLayer = {
  id: string;
  type: "text";
  name: string;
  text: string;
  x: number;
  y: number;
  size: number;
  color: string;
  hidden: boolean;
};
type StickerLayer = {
  id: string;
  type: "sticker";
  name: string;
  src: string;
  x: number;
  y: number;
  width: number;
  height: number;
  hidden: boolean;
};
type EditorLayer = TextLayer | StickerLayer;
type PendingOutpaint = {
  sourceWidth: number;
  sourceHeight: number;
  offsetX: number;
  offsetY: number;
};
type EditorSnapshot = {
  base: string;
  layers: EditorLayer[];
  mask: string;
  hasMask: boolean;
  pendingOutpaint: PendingOutpaint | null;
};
type Point = { x: number; y: number };
type CropRect = { x: number; y: number; width: number; height: number };

const MAX_CANVAS_EDGE = 2048;

function imageUrl(value: string) {
  if (!value) return "";
  if (/^(https?:|data:|blob:)/.test(value)) return value;
  return value.startsWith("/") ? value : `/${value}`;
}

function versionUrl(version?: CreativeVersion | null) {
  if (!version) return "";
  return imageUrl(
    version.image_url ||
      (version.image_path ? `/images/${version.image_path}` : ""),
  );
}

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("图片加载失败"));
    image.src = src;
  });
}

function canvasBlob(canvas: HTMLCanvasElement, type = "image/png") {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("画布导出失败"))),
      type,
      0.94,
    );
  });
}

function operationPrompt(operation: string) {
  const prompts: Record<string, string> = {
    inpaint:
      "仅重绘蒙版选中的区域，严格保持未选区域、人物身份、构图和文字不变。",
    replace_person: "仅替换蒙版中的人物，保持背景、构图、光线和未选区域不变。",
    replace_background:
      "仅替换蒙版中的背景，保持人物、产品、文字和前景主体完全不变。",
    remove_object: "移除蒙版中的对象，并依据周围纹理、透视和光线自然补全区域。",
    outpaint:
      "仅自然补全画布透明扩展区域，延续原图构图、透视、光线和纹理，原有画面不得改动。",
  };
  return prompts[operation] || prompts.inpaint;
}

function CanvasEditor() {
  const { isCheckingAuth, session } = useAuthGuard(["user", "admin"]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const maskRef = useRef<HTMLCanvasElement>(null);
  const pointerDownRef = useRef(false);
  const pointerStartRef = useRef<Point | null>(null);
  const lastPointRef = useRef<Point | null>(null);
  const editorHistoryRef = useRef<EditorSnapshot[]>([]);
  const editorHistoryIndexRef = useRef(-1);
  const maskHistoryRef = useRef<string[]>([]);
  const maskHistoryIndexRef = useRef(-1);
  const pendingOutpaintRef = useRef<PendingOutpaint | null>(null);
  const pendingMaskRestoreRef = useRef<{ src: string; hasMask: boolean } | null>(null);
  const renderVersionRef = useRef(0);
  const [asset, setAsset] = useState<CreativeAsset | null>(null);
  const [selectedVersionId, setSelectedVersionId] = useState("");
  const [baseDataUrl, setBaseDataUrl] = useState("");
  const [initialSrc, setInitialSrc] = useState("");
  const [layers, setLayers] = useState<EditorLayer[]>([]);
  const [activeLayerId, setActiveLayerId] = useState("");
  const [tool, setTool] = useState<Tool>("brush");
  const [brushSize, setBrushSize] = useState(42);
  const [cropRect, setCropRect] = useState<CropRect | null>(null);
  const [hasMask, setHasMask] = useState(false);
  const [textValue, setTextValue] = useState("双击编辑文字");
  const [textColor, setTextColor] = useState("#ffffff");
  const [textSize, setTextSize] = useState(64);
  const [operation, setOperation] = useState("inpaint");
  const [canvasRatio, setCanvasRatio] = useState<CanvasRatio>("16:9");
  const [outpaintDirections, setOutpaintDirections] = useState<
    OutpaintDirection[]
  >(["left", "right"]);
  const [profiles, setProfiles] = useState<ConsistencyProfile[]>([]);
  const [profileId, setProfileId] = useState("");
  const [profileStrength, setProfileStrength] =
    useState<ConsistencyStrength>("balanced");
  const [preserveStrength, setPreserveStrength] =
    useState<ConsistencyStrength>("balanced");
  const [instruction, setInstruction] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [task, setTask] = useState<ImageTask | null>(null);
  const [resultSrc, setResultSrc] = useState("");
  const [error, setError] = useState("");

  const selectedVersion = useMemo(
    () =>
      asset?.versions?.find((item) => item.id === selectedVersionId) ||
      asset?.versions?.find((item) => item.id === asset.current_version_id) ||
      asset?.versions?.at(-1) ||
      null,
    [asset, selectedVersionId],
  );

  const snapshot = useCallback(
    (base = baseDataUrl, nextLayers = layers) => {
      const history = editorHistoryRef.current.slice(
        0,
        editorHistoryIndexRef.current + 1,
      );
      history.push({
        base,
        layers: structuredClone(nextLayers),
        mask: maskRef.current?.toDataURL() || "",
        hasMask,
        pendingOutpaint: pendingOutpaintRef.current
          ? { ...pendingOutpaintRef.current }
          : null,
      });
      if (history.length > 40) history.shift();
      editorHistoryRef.current = history;
      editorHistoryIndexRef.current = history.length - 1;
    },
    [baseDataUrl, hasMask, layers],
  );

  const clearMask = useCallback(() => {
    const mask = maskRef.current;
    if (!mask) return;
    mask.getContext("2d")?.clearRect(0, 0, mask.width, mask.height);
    maskHistoryRef.current = [mask.toDataURL()];
    maskHistoryIndexRef.current = 0;
    setHasMask(false);
  }, []);

  const renderCanvas = useCallback(async () => {
    const renderVersion = ++renderVersionRef.current;
    const canvas = canvasRef.current;
    const mask = maskRef.current;
    if (!canvas || !mask || !baseDataUrl) return;
    const base = await loadImage(baseDataUrl);
    if (renderVersion !== renderVersionRef.current) return;
    if (
      canvas.width !== base.naturalWidth ||
      canvas.height !== base.naturalHeight
    ) {
      canvas.width = base.naturalWidth;
      canvas.height = base.naturalHeight;
      mask.width = base.naturalWidth;
      mask.height = base.naturalHeight;
      clearMask();
    }
    const context = canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(base, 0, 0, canvas.width, canvas.height);
    for (const layer of layers) {
      if (layer.hidden) continue;
      if (layer.type === "text") {
        context.save();
        context.fillStyle = layer.color;
        context.font = `700 ${layer.size}px Inter, sans-serif`;
        context.textBaseline = "top";
        context.shadowColor = "rgba(0,0,0,.28)";
        context.shadowBlur = Math.max(2, layer.size / 16);
        context.fillText(layer.text, layer.x, layer.y);
        context.restore();
      } else {
        try {
          const sticker = await loadImage(layer.src);
          if (renderVersion !== renderVersionRef.current) return;
          context.drawImage(
            sticker,
            layer.x,
            layer.y,
            layer.width,
            layer.height,
          );
        } catch {
          // Keep other layers editable if one sticker source becomes unavailable.
        }
      }
    }
    const pendingMask = pendingMaskRestoreRef.current;
    if (pendingMask) {
      const maskContext = mask.getContext("2d");
      maskContext?.clearRect(0, 0, mask.width, mask.height);
      if (pendingMask.src) {
        const restored = await loadImage(pendingMask.src);
        if (renderVersion !== renderVersionRef.current) return;
        maskContext?.drawImage(restored, 0, 0, mask.width, mask.height);
      }
      pendingMaskRestoreRef.current = null;
      maskHistoryRef.current = [mask.toDataURL()];
      maskHistoryIndexRef.current = 0;
      setHasMask(pendingMask.hasMask);
      return;
    }
    const pending = pendingOutpaintRef.current;
    if (pending) {
      const maskContext = mask.getContext("2d");
      if (maskContext) {
        maskContext.clearRect(0, 0, mask.width, mask.height);
        maskContext.fillStyle = "rgba(124,58,237,.68)";
        if (pending.offsetY > 0)
          maskContext.fillRect(0, 0, mask.width, pending.offsetY);
        const bottomStart = pending.offsetY + pending.sourceHeight;
        if (bottomStart < mask.height)
          maskContext.fillRect(
            0,
            bottomStart,
            mask.width,
            mask.height - bottomStart,
          );
        if (pending.offsetX > 0)
          maskContext.fillRect(
            0,
            pending.offsetY,
            pending.offsetX,
            pending.sourceHeight,
          );
        const rightStart = pending.offsetX + pending.sourceWidth;
        if (rightStart < mask.width)
          maskContext.fillRect(
            rightStart,
            pending.offsetY,
            mask.width - rightStart,
            pending.sourceHeight,
          );
        maskHistoryRef.current = [mask.toDataURL()];
        maskHistoryIndexRef.current = 0;
        setHasMask(true);
      }
      pendingOutpaintRef.current = null;
    }
  }, [baseDataUrl, clearMask, layers]);

  useEffect(() => {
    void renderCanvas();
  }, [renderCanvas]);

  const loadVersion = useCallback(async (version: CreativeVersion) => {
    const src = versionUrl(version);
    if (!src) throw new Error("该版本没有可编辑图片");
    const response = await fetch(src);
    if (!response.ok) throw new Error("读取版本图片失败");
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    try {
      const image = await loadImage(objectUrl);
      const scale = Math.min(
        1,
        MAX_CANVAS_EDGE / Math.max(image.naturalWidth, image.naturalHeight),
      );
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      canvas
        .getContext("2d")
        ?.drawImage(image, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL("image/png");
      setBaseDataUrl(dataUrl);
      setInitialSrc(src);
      setLayers([]);
      setResultSrc("");
      setTask(null);
      editorHistoryRef.current = [
        { base: dataUrl, layers: [], mask: "", hasMask: false, pendingOutpaint: null },
      ];
      editorHistoryIndexRef.current = 0;
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }, []);

  const loadAsset = useCallback(async () => {
    if (!session) return;
    const params = new URLSearchParams(window.location.search);
    const assetId = params.get("asset") || "";
    if (!assetId) {
      setError("请从项目资产库选择一张作品进入画布");
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    try {
      const next = await fetchCreativeAsset(assetId);
      setAsset(next);
      const requested = params.get("version");
      const version =
        next.versions?.find((item) => item.id === requested) ||
        next.versions?.find((item) => item.id === next.current_version_id) ||
        next.versions?.at(-1);
      if (!version) throw new Error("作品还没有图片版本");
      setSelectedVersionId(version.id);
      await loadVersion(version);
      setError("");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "画布加载失败");
    } finally {
      setIsLoading(false);
    }
  }, [loadVersion, session]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadAsset(), 0);
    return () => window.clearTimeout(timer);
  }, [loadAsset]);

  useEffect(() => {
    if (!session) return;
    void fetchConsistencyProfiles()
      .then(({ items }) => setProfiles(items))
      .catch(() => setProfiles([]));
  }, [session]);

  useEffect(() => {
    if (!task || !["queued", "paused", "running"].includes(task.status)) return;
    const timer = window.setInterval(() => {
      void fetchImageTasks([task.id])
        .then(async (response) => {
          const next = response.items[0];
          if (!next) return;
          setTask(next);
          if (next.status === "success") {
            const src = imageUrl(next.data?.[0]?.url || "");
            setResultSrc(src);
            setIsSubmitting(false);
            if (asset) setAsset(await fetchCreativeAsset(asset.id));
            toast.success("局部编辑完成，已进入作品版本链");
          } else if (next.status === "error") {
            setIsSubmitting(false);
            setError(next.error || "局部编辑失败，请重试");
          }
        })
        .catch((pollError) =>
          setError(
            pollError instanceof Error ? pollError.message : "任务状态读取失败",
          ),
        );
    }, 1800);
    return () => window.clearInterval(timer);
  }, [asset, task]);

  const pointFromEvent = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = maskRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * canvas.width,
      y: ((event.clientY - rect.top) / rect.height) * canvas.height,
    };
  };

  const saveMaskHistory = () => {
    const mask = maskRef.current;
    if (!mask) return;
    const history = maskHistoryRef.current.slice(
      0,
      maskHistoryIndexRef.current + 1,
    );
    history.push(mask.toDataURL());
    if (history.length > 50) history.shift();
    maskHistoryRef.current = history;
    maskHistoryIndexRef.current = history.length - 1;
  };

  const drawMaskSegment = (from: Point, to: Point) => {
    const context = maskRef.current?.getContext("2d");
    if (!context) return;
    context.save();
    context.globalCompositeOperation =
      tool === "erase" ? "destination-out" : "source-over";
    context.strokeStyle = "rgba(124,58,237,.68)";
    context.lineWidth = brushSize;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.beginPath();
    context.moveTo(from.x, from.y);
    context.lineTo(to.x, to.y);
    context.stroke();
    context.restore();
    if (tool === "brush") setHasMask(true);
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    pointerDownRef.current = true;
    const point = pointFromEvent(event);
    pointerStartRef.current = point;
    lastPointRef.current = point;
    if (tool === "brush" || tool === "erase") {
      drawMaskSegment(point, { x: point.x + 0.01, y: point.y + 0.01 });
    }
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!pointerDownRef.current) return;
    const point = pointFromEvent(event);
    if ((tool === "brush" || tool === "erase") && lastPointRef.current) {
      drawMaskSegment(lastPointRef.current, point);
    } else if (tool === "crop" && pointerStartRef.current) {
      const start = pointerStartRef.current;
      setCropRect({
        x: Math.min(start.x, point.x),
        y: Math.min(start.y, point.y),
        width: Math.abs(point.x - start.x),
        height: Math.abs(point.y - start.y),
      });
    } else if (tool === "select" && activeLayerId && lastPointRef.current) {
      const dx = point.x - lastPointRef.current.x;
      const dy = point.y - lastPointRef.current.y;
      setLayers((current) =>
        current.map((layer) =>
          layer.id === activeLayerId
            ? { ...layer, x: layer.x + dx, y: layer.y + dy }
            : layer,
        ),
      );
    }
    lastPointRef.current = point;
  };

  const handlePointerUp = () => {
    if (pointerDownRef.current && (tool === "brush" || tool === "erase")) {
      saveMaskHistory();
      const mask = maskRef.current;
      const pixels = mask
        ?.getContext("2d")
        ?.getImageData(0, 0, mask.width, mask.height).data;
      setHasMask(
        Boolean(
          pixels && pixels.some((value, index) => index % 4 === 3 && value > 0),
        ),
      );
    }
    if (tool === "select" && activeLayerId) snapshot();
    pointerDownRef.current = false;
    pointerStartRef.current = null;
    lastPointRef.current = null;
  };

  const restoreMask = async (src: string) => {
    const mask = maskRef.current;
    if (!mask) return;
    const context = mask.getContext("2d");
    context?.clearRect(0, 0, mask.width, mask.height);
    if (src)
      context?.drawImage(await loadImage(src), 0, 0, mask.width, mask.height);
    const pixels = context?.getImageData(0, 0, mask.width, mask.height).data;
    setHasMask(Boolean(pixels?.some((value, index) => index % 4 === 3 && value > 0)));
  };

  const applyEditorSnapshot = (state: EditorSnapshot) => {
    pendingOutpaintRef.current = state.pendingOutpaint
      ? { ...state.pendingOutpaint }
      : null;
    pendingMaskRestoreRef.current = state.pendingOutpaint
      ? null
      : { src: state.mask, hasMask: state.hasMask };
    setBaseDataUrl(state.base);
    setLayers(structuredClone(state.layers));
    setHasMask(state.hasMask);
  };

  const undo = async () => {
    if (maskHistoryIndexRef.current > 0) {
      maskHistoryIndexRef.current -= 1;
      await restoreMask(maskHistoryRef.current[maskHistoryIndexRef.current]);
      return;
    }
    if (editorHistoryIndexRef.current <= 0) return;
    editorHistoryIndexRef.current -= 1;
    const state = editorHistoryRef.current[editorHistoryIndexRef.current];
    applyEditorSnapshot(state);
  };

  const redo = async () => {
    if (maskHistoryIndexRef.current < maskHistoryRef.current.length - 1) {
      maskHistoryIndexRef.current += 1;
      await restoreMask(maskHistoryRef.current[maskHistoryIndexRef.current]);
      return;
    }
    if (editorHistoryIndexRef.current >= editorHistoryRef.current.length - 1)
      return;
    editorHistoryIndexRef.current += 1;
    const state = editorHistoryRef.current[editorHistoryIndexRef.current];
    applyEditorSnapshot(state);
  };

  const flattenTransform = async (
    transform: (source: HTMLCanvasElement, target: HTMLCanvasElement) => void,
  ) => {
    const source = canvasRef.current;
    if (!source) return;
    const target = document.createElement("canvas");
    transform(source, target);
    const next = target.toDataURL("image/png");
    setBaseDataUrl(next);
    setLayers([]);
    setActiveLayerId("");
    snapshot(next, []);
    clearMask();
  };

  const rotate = () =>
    flattenTransform((source, target) => {
      target.width = source.height;
      target.height = source.width;
      const context = target.getContext("2d");
      context?.translate(target.width / 2, target.height / 2);
      context?.rotate(Math.PI / 2);
      context?.drawImage(source, -source.width / 2, -source.height / 2);
    });

  const applyCrop = () => {
    if (!cropRect || cropRect.width < 20 || cropRect.height < 20) {
      toast.error("请先在画面上拖出有效裁剪区域");
      return;
    }
    void flattenTransform((source, target) => {
      const x = Math.max(0, Math.round(cropRect.x));
      const y = Math.max(0, Math.round(cropRect.y));
      const width = Math.min(source.width - x, Math.round(cropRect.width));
      const height = Math.min(source.height - y, Math.round(cropRect.height));
      target.width = width;
      target.height = height;
      target
        .getContext("2d")
        ?.drawImage(source, x, y, width, height, 0, 0, width, height);
    });
    setCropRect(null);
    setTool("select");
  };

  const toggleOutpaintDirection = (direction: OutpaintDirection) => {
    setOutpaintDirections((current) =>
      current.includes(direction)
        ? current.filter((item) => item !== direction)
        : [...current, direction],
    );
  };

  const prepareOutpaintCanvas = async () => {
    if (outpaintDirections.length === 0) {
      toast.error("请至少选择一个扩展方向");
      return;
    }
    await renderCanvas();
    const source = canvasRef.current;
    if (!source) return;
    const geometry = calculateOutpaintGeometry(
      source.width,
      source.height,
      canvasRatio,
      outpaintDirections,
    );
    if (geometry.width === source.width && geometry.height === source.height) {
      toast.error("当前画布已经是该比例，请选择更宽或更高的比例");
      return;
    }
    let contentScale = 1;
    if (geometry.width > MAX_CANVAS_EDGE || geometry.height > MAX_CANVAS_EDGE) {
      const scale = Math.min(
        MAX_CANVAS_EDGE / geometry.width,
        MAX_CANVAS_EDGE / geometry.height,
      );
      contentScale = scale;
      geometry.width = Math.max(1, Math.round(geometry.width * scale));
      geometry.height = Math.max(1, Math.round(geometry.height * scale));
      geometry.offsetX = Math.round(geometry.offsetX * scale);
      geometry.offsetY = Math.round(geometry.offsetY * scale);
    }
    const target = document.createElement("canvas");
    target.width = geometry.width;
    target.height = geometry.height;
    const context = target.getContext("2d");
    if (!context) throw new Error("扩图画布创建失败");
    const originalWidth = Math.max(1, Math.round(source.width * contentScale));
    const originalHeight = Math.max(
      1,
      Math.round(source.height * contentScale),
    );
    pendingOutpaintRef.current = {
      sourceWidth: originalWidth,
      sourceHeight: originalHeight,
      offsetX: geometry.offsetX,
      offsetY: geometry.offsetY,
    };
    context.drawImage(
      source,
      0,
      0,
      source.width,
      source.height,
      geometry.offsetX,
      geometry.offsetY,
      originalWidth,
      originalHeight,
    );
    const next = target.toDataURL("image/png");
    setBaseDataUrl(next);
    setLayers([]);
    setActiveLayerId("");
    setTool("brush");
    snapshot(next, []);
    toast.success("扩展区域已自动选中，可继续涂抹或直接提交");
  };

  const restoreSelectedVersion = async () => {
    if (!asset || !selectedVersion) return;
    setIsSaving(true);
    try {
      const updated = await activateCreativeVersion(
        asset.id,
        selectedVersion.id,
      );
      setAsset(updated);
      setSelectedVersionId(selectedVersion.id);
      toast.success(`已恢复 V${selectedVersion.version_number} 为当前版本`);
    } catch (restoreError) {
      setError(
        restoreError instanceof Error
          ? restoreError.message
          : "恢复历史版本失败",
      );
    } finally {
      setIsSaving(false);
    }
  };

  const addText = () => {
    const canvas = canvasRef.current;
    if (!canvas || !textValue.trim()) return;
    const layer: TextLayer = {
      id: crypto.randomUUID(),
      type: "text",
      name: textValue.trim().slice(0, 18),
      text: textValue.trim(),
      x: canvas.width * 0.12,
      y: canvas.height * 0.12,
      size: textSize,
      color: textColor,
      hidden: false,
    };
    const next = [...layers, layer];
    setLayers(next);
    setActiveLayerId(layer.id);
    setTool("select");
    snapshot(baseDataUrl, next);
  };

  const addSticker = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    const canvas = canvasRef.current;
    if (!file || !canvas) return;
    if (!file.type.startsWith("image/") || file.size > 20 * 1024 * 1024) {
      toast.error("贴图需为 20 MB 内的图片");
      return;
    }
    const src = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("贴图读取失败"));
      reader.readAsDataURL(file);
    });
    const image = await loadImage(src);
    const width = Math.min(canvas.width * 0.28, image.naturalWidth);
    const layer: StickerLayer = {
      id: crypto.randomUUID(),
      type: "sticker",
      name: file.name,
      src,
      x: canvas.width * 0.36,
      y: canvas.height * 0.36,
      width,
      height: width * (image.naturalHeight / image.naturalWidth),
      hidden: false,
    };
    const next = [...layers, layer];
    setLayers(next);
    setActiveLayerId(layer.id);
    setTool("select");
    snapshot(baseDataUrl, next);
    event.target.value = "";
  };

  const mutateLayer = (
    id: string,
    mutation: (layer: EditorLayer) => EditorLayer,
  ) => {
    const next = layers.map((layer) =>
      layer.id === id ? mutation(layer) : layer,
    );
    setLayers(next);
    snapshot(baseDataUrl, next);
  };

  const moveLayer = (id: string, direction: -1 | 1) => {
    const index = layers.findIndex((item) => item.id === id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= layers.length) return;
    const next = [...layers];
    [next[index], next[target]] = [next[target], next[index]];
    setLayers(next);
    snapshot(baseDataUrl, next);
  };

  const compositeFile = async () => {
    await renderCanvas();
    const canvas = canvasRef.current;
    if (!canvas) throw new Error("画布尚未准备好");
    return new File([await canvasBlob(canvas)], "xg-canvas.png", {
      type: "image/png",
    });
  };

  const maskFile = async () => {
    const source = maskRef.current;
    if (!source) throw new Error("蒙版尚未准备好");
    const target = document.createElement("canvas");
    target.width = source.width;
    target.height = source.height;
    const context = target.getContext("2d");
    if (!context) throw new Error("蒙版导出失败");
    const selected = source
      .getContext("2d")
      ?.getImageData(0, 0, source.width, source.height);
    const output = context.createImageData(target.width, target.height);
    for (let index = 0; index < output.data.length; index += 4) {
      const isSelected = Boolean(selected?.data[index + 3]);
      output.data[index] = 0;
      output.data[index + 1] = 0;
      output.data[index + 2] = 0;
      output.data[index + 3] = isSelected ? 0 : 255;
    }
    context.putImageData(output, 0, 0);
    return new File([await canvasBlob(target)], "xg-mask.png", {
      type: "image/png",
    });
  };

  const saveLocal = async () => {
    if (!asset || !selectedVersion) return;
    setIsSaving(true);
    try {
      const updated = await saveCanvasVersion({
        asset_id: asset.id,
        image: await compositeFile(),
        prompt: instruction || "画布本地合成",
        operation: "canvas",
        parent_version_id: selectedVersion.id,
        params: {
          layers,
          canvas_width: canvasRef.current?.width,
          canvas_height: canvasRef.current?.height,
        },
      });
      setAsset(updated);
      setSelectedVersionId(String(updated.current_version_id || ""));
      toast.success("画布已保存为新版本");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "保存版本失败");
    } finally {
      setIsSaving(false);
    }
  };

  const submitAiEdit = async () => {
    if (!asset || !selectedVersion) return;
    if (!hasMask) {
      setError("请先用画笔涂抹需要修改的区域");
      return;
    }
    setIsSubmitting(true);
    setError("");
    try {
      const prompt =
        `${operationPrompt(operation)} ${instruction.trim()}`.trim();
      const next = await createImageEditTask(
        `canvas-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
        await compositeFile(),
        prompt,
        USER_DEFAULT_IMAGE_MODEL,
        operation === "outpaint"
          ? imageModelSizeForRatio(canvasRatio)
          : `${canvasRef.current?.width || 1024}x${canvasRef.current?.height || 1024}`,
        "high",
        {
          asset_id: asset.id,
          parent_version_id: selectedVersion.id,
          operation_type: operation,
          asset_name: asset.name,
          profile_id: profileId,
          profile_strength: profileStrength,
          canvas_ratio: operation === "outpaint" ? canvasRatio : "",
          outpaint_directions:
            operation === "outpaint" ? outpaintDirections : [],
          preserve_strength: preserveStrength,
        },
        await maskFile(),
      );
      setTask(next);
      toast.success("局部编辑已进入任务队列");
    } catch (submitError) {
      setError(
        submitError instanceof Error ? submitError.message : "提交局部编辑失败",
      );
      setIsSubmitting(false);
    }
  };

  if (isCheckingAuth || isLoading) {
    return (
      <main className="grid min-h-[70vh] place-items-center">
        <LoaderCircle className="size-7 animate-spin text-violet-700" />
      </main>
    );
  }

  return (
    <main className="min-h-dvh bg-stone-100/80 px-3 py-4 text-stone-950 sm:px-5 lg:px-7 dark:bg-stone-950 dark:text-white">
      <div className="mx-auto max-w-[1800px] space-y-4">
        <header className="flex flex-col gap-4 rounded-3xl border border-stone-200 bg-white p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between dark:border-white/10 dark:bg-stone-900">
          <div className="flex min-w-0 items-center gap-3">
            <Button
              variant="outline"
              className="size-11 rounded-2xl p-0"
              asChild
            >
              <a href="/projects/" aria-label="返回项目资产库">
                <ArrowLeft className="size-4" />
              </a>
            </Button>
            <div className="min-w-0">
              <p className="text-xs font-semibold tracking-[0.18em] text-violet-700 uppercase dark:text-violet-300">
                XG Canvas
              </p>
              <h1 className="truncate text-xl font-bold sm:text-2xl">
                {asset?.name || "局部编辑画布"}
              </h1>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label="选择作品版本"
              value={selectedVersion?.id || ""}
              onChange={(event) => {
                const version = asset?.versions?.find(
                  (item) => item.id === event.target.value,
                );
                if (!version) return;
                setSelectedVersionId(version.id);
                void loadVersion(version);
              }}
              className="min-h-11 rounded-xl border border-stone-200 bg-white px-3 text-sm dark:border-white/10 dark:bg-stone-950"
            >
              {asset?.versions?.map((version) => (
                <option key={version.id} value={version.id}>
                  V{version.version_number} · {version.operation}
                </option>
              ))}
            </select>
            <Button
              variant="outline"
              className="min-h-11 rounded-xl"
              disabled={
                isSaving ||
                !selectedVersion ||
                selectedVersion.id === asset?.current_version_id
              }
              onClick={() => void restoreSelectedVersion()}
            >
              <RotateCw className="size-4" /> 恢复此版本
            </Button>
            <Button
              variant="outline"
              className="min-h-11 rounded-xl"
              onClick={() => void undo()}
            >
              <Undo2 className="size-4" /> 撤销
            </Button>
            <Button
              variant="outline"
              className="min-h-11 rounded-xl"
              onClick={() => void redo()}
            >
              <Redo2 className="size-4" /> 重做
            </Button>
            <Button
              className="min-h-11 rounded-xl bg-stone-950 text-white hover:bg-stone-800 dark:bg-white dark:text-stone-950"
              disabled={isSaving}
              onClick={() => void saveLocal()}
            >
              {isSaving ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : (
                <Save className="size-4" />
              )}
              保存版本
            </Button>
          </div>
        </header>

        {error ? (
          <div
            role="alert"
            className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:border-rose-400/20 dark:bg-rose-400/10 dark:text-rose-200"
          >
            {error}
          </div>
        ) : null}

        <div className="grid gap-4 xl:grid-cols-[88px_minmax(0,1fr)_340px]">
          <aside className="grid grid-cols-4 gap-2 rounded-3xl border border-stone-200 bg-white p-2 shadow-sm xl:flex xl:flex-col dark:border-white/10 dark:bg-stone-900">
            {(
              [
                ["select", MousePointer2, "移动图层"],
                ["brush", Brush, "涂抹选区"],
                ["erase", Eraser, "擦除选区"],
                ["crop", Crop, "裁剪"],
              ] as const
            ).map(([value, Icon, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={tool === value}
                title={label}
                onClick={() => setTool(value)}
                className={cn(
                  "grid min-h-14 place-items-center gap-1 rounded-2xl px-1 py-2 text-[11px] font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500",
                  tool === value
                    ? "bg-violet-700 text-white shadow-sm"
                    : "text-stone-500 hover:bg-stone-100 hover:text-stone-950 dark:text-stone-300 dark:hover:bg-white/10 dark:hover:text-white",
                )}
              >
                <Icon className="size-5" />
                <span>{label}</span>
              </button>
            ))}
            <div className="col-span-4 my-1 h-px bg-stone-200 xl:block dark:bg-white/10" />
            <button
              type="button"
              className="grid min-h-14 place-items-center gap-1 rounded-2xl text-[11px] text-stone-500 transition hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-white/10"
              onClick={() => void rotate()}
            >
              <RotateCw className="size-5" /> 旋转 90°
            </button>
            <button
              type="button"
              disabled={!cropRect}
              className="grid min-h-14 place-items-center gap-1 rounded-2xl text-[11px] text-stone-500 transition hover:bg-stone-100 disabled:opacity-35 dark:text-stone-300 dark:hover:bg-white/10"
              onClick={applyCrop}
            >
              <Scissors className="size-5" /> 应用裁剪
            </button>
            <button
              type="button"
              className="grid min-h-14 place-items-center gap-1 rounded-2xl text-[11px] text-stone-500 transition hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-white/10"
              onClick={clearMask}
            >
              <Trash2 className="size-5" /> 清空选区
            </button>
          </aside>

          <section className="min-w-0 overflow-hidden rounded-3xl border border-stone-200 bg-[radial-gradient(circle_at_center,_#e7e5e4_1px,_transparent_1px)] bg-[length:20px_20px] p-3 shadow-inner sm:p-6 dark:border-white/10 dark:bg-[radial-gradient(circle_at_center,_#292524_1px,_transparent_1px)]">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-white/90 px-3 py-2 text-sm shadow-sm backdrop-blur dark:bg-stone-900/90">
              <div className="flex items-center gap-3">
                <span className="font-semibold">画布</span>
                <span className="text-stone-500 tabular-nums dark:text-stone-400">
                  {canvasRef.current?.width || 0} ×{" "}
                  {canvasRef.current?.height || 0}
                </span>
              </div>
              <label className="flex items-center gap-2 text-xs text-stone-500 dark:text-stone-300">
                画笔大小
                <input
                  aria-label="画笔大小"
                  type="range"
                  min="8"
                  max="180"
                  value={brushSize}
                  onChange={(event) => setBrushSize(Number(event.target.value))}
                  className="w-28 accent-violet-700"
                />
                <span className="w-8 text-right tabular-nums">{brushSize}</span>
              </label>
            </div>
            <div className="relative mx-auto max-h-[72vh] w-fit max-w-full overflow-auto rounded-2xl bg-stone-900 shadow-2xl">
              <canvas
                ref={canvasRef}
                className="block max-h-[68vh] max-w-full object-contain"
                aria-label="图片编辑画布"
              />
              <canvas
                ref={maskRef}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerUp}
                className={cn(
                  "absolute inset-0 size-full touch-none object-contain",
                  tool === "select"
                    ? "cursor-move"
                    : tool === "crop"
                      ? "cursor-crosshair"
                      : "cursor-none",
                )}
                aria-label="局部编辑蒙版层，可直接涂抹选择区域"
              />
              {cropRect && canvasRef.current ? (
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute border-2 border-white bg-violet-500/10 shadow-[0_0_0_9999px_rgba(0,0,0,.42)]"
                  style={{
                    left: `${(cropRect.x / canvasRef.current.width) * 100}%`,
                    top: `${(cropRect.y / canvasRef.current.height) * 100}%`,
                    width: `${(cropRect.width / canvasRef.current.width) * 100}%`,
                    height: `${(cropRect.height / canvasRef.current.height) * 100}%`,
                  }}
                />
              ) : null}
            </div>
            <p className="mt-3 text-center text-xs text-stone-500 dark:text-stone-400">
              紫色区域代表 AI
              将修改的位置；切换“移动图层”后可拖动当前文字或贴图。
            </p>
          </section>

          <aside className="space-y-4">
            <section className="rounded-3xl border border-stone-200 bg-white p-4 shadow-sm dark:border-white/10 dark:bg-stone-900">
              <div className="mb-4 flex items-center gap-2">
                <Type className="size-4 text-violet-700" />
                <h2 className="font-bold">文字与贴图</h2>
              </div>
              <div className="space-y-3">
                <label className="block text-xs font-medium text-stone-500 dark:text-stone-300">
                  文字内容
                  <input
                    value={textValue}
                    onChange={(event) => setTextValue(event.target.value)}
                    className="mt-1 min-h-11 w-full rounded-xl border border-stone-200 bg-transparent px-3 text-sm text-stone-900 outline-none focus:border-violet-500 dark:border-white/10 dark:text-white"
                  />
                </label>
                <div className="grid grid-cols-[1fr_96px] gap-2">
                  <label className="text-xs font-medium text-stone-500 dark:text-stone-300">
                    字号
                    <input
                      type="number"
                      min="16"
                      max="260"
                      value={textSize}
                      onChange={(event) =>
                        setTextSize(Number(event.target.value))
                      }
                      className="mt-1 min-h-11 w-full rounded-xl border border-stone-200 bg-transparent px-3 dark:border-white/10"
                    />
                  </label>
                  <label className="text-xs font-medium text-stone-500 dark:text-stone-300">
                    颜色
                    <input
                      aria-label="文字颜色"
                      type="color"
                      value={textColor}
                      onChange={(event) => setTextColor(event.target.value)}
                      className="mt-1 h-11 w-full rounded-xl border border-stone-200 bg-transparent p-1 dark:border-white/10"
                    />
                  </label>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    variant="outline"
                    className="min-h-11 rounded-xl"
                    onClick={addText}
                  >
                    <Type className="size-4" /> 添加文字
                  </Button>
                  <label className="inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-xl border border-stone-200 text-sm font-medium transition hover:bg-stone-100 dark:border-white/10 dark:hover:bg-white/10">
                    <ImagePlus className="size-4" /> 添加贴图
                    <input
                      type="file"
                      accept="image/*"
                      className="sr-only"
                      onChange={(event) => void addSticker(event)}
                    />
                  </label>
                </div>
              </div>
            </section>

            <section className="rounded-3xl border border-stone-200 bg-white p-4 shadow-sm dark:border-white/10 dark:bg-stone-900">
              <div className="mb-3 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Layers3 className="size-4 text-violet-700" />
                  <h2 className="font-bold">图层</h2>
                </div>
                <span className="text-xs text-stone-500">{layers.length}</span>
              </div>
              <div className="max-h-60 space-y-2 overflow-y-auto pr-1">
                {[...layers].reverse().map((layer) => (
                  <div
                    key={layer.id}
                    onClick={() => {
                      setActiveLayerId(layer.id);
                      setTool("select");
                    }}
                    className={cn(
                      "flex cursor-pointer items-center gap-2 rounded-xl border p-2 transition",
                      activeLayerId === layer.id
                        ? "border-violet-400 bg-violet-50 dark:bg-violet-400/10"
                        : "border-stone-200 dark:border-white/10",
                    )}
                  >
                    {layer.type === "text" ? (
                      <Type className="size-4" />
                    ) : (
                      <ImagePlus className="size-4" />
                    )}
                    <span className="min-w-0 flex-1 truncate text-sm">
                      {layer.name}
                    </span>
                    <button
                      aria-label={layer.hidden ? "显示图层" : "隐藏图层"}
                      className="grid size-9 place-items-center rounded-lg hover:bg-stone-100 dark:hover:bg-white/10"
                      onClick={(event) => {
                        event.stopPropagation();
                        mutateLayer(layer.id, (item) => ({
                          ...item,
                          hidden: !item.hidden,
                        }));
                      }}
                    >
                      {layer.hidden ? (
                        <EyeOff className="size-4" />
                      ) : (
                        <Eye className="size-4" />
                      )}
                    </button>
                    <button
                      aria-label="上移图层"
                      className="grid size-9 place-items-center rounded-lg hover:bg-stone-100 dark:hover:bg-white/10"
                      onClick={(event) => {
                        event.stopPropagation();
                        moveLayer(layer.id, 1);
                      }}
                    >
                      <ChevronUp className="size-4" />
                    </button>
                    <button
                      aria-label="下移图层"
                      className="grid size-9 place-items-center rounded-lg hover:bg-stone-100 dark:hover:bg-white/10"
                      onClick={(event) => {
                        event.stopPropagation();
                        moveLayer(layer.id, -1);
                      }}
                    >
                      <ChevronDown className="size-4" />
                    </button>
                    <button
                      aria-label="删除图层"
                      className="grid size-9 place-items-center rounded-lg text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-400/10"
                      onClick={(event) => {
                        event.stopPropagation();
                        const next = layers.filter(
                          (item) => item.id !== layer.id,
                        );
                        setLayers(next);
                        snapshot(baseDataUrl, next);
                      }}
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </div>
                ))}
                {!layers.length ? (
                  <p className="rounded-xl border border-dashed border-stone-200 py-6 text-center text-xs text-stone-500 dark:border-white/10">
                    还没有文字或贴图图层
                  </p>
                ) : null}
              </div>
            </section>

            <section className="rounded-3xl border border-violet-200 bg-violet-50 p-4 shadow-sm dark:border-violet-400/20 dark:bg-violet-400/10">
              <div className="mb-3 flex items-center gap-2">
                <Sparkles className="size-4 text-violet-700 dark:text-violet-300" />
                <h2 className="font-bold">AI 局部编辑</h2>
              </div>
              <div className="space-y-3">
                <label className="block text-xs font-medium text-stone-600 dark:text-stone-300">
                  操作类型
                  <select
                    value={operation}
                    onChange={(event) => setOperation(event.target.value)}
                    className="mt-1 min-h-11 w-full rounded-xl border border-violet-200 bg-white px-3 text-sm dark:border-violet-400/20 dark:bg-stone-950"
                  >
                    <option value="inpaint">局部重绘</option>
                    <option value="replace_person">替换人物</option>
                    <option value="replace_background">替换背景</option>
                    <option value="remove_object">删除对象</option>
                    <option value="outpaint">智能扩图</option>
                  </select>
                </label>
                {operation === "outpaint" ? (
                  <div className="space-y-3 rounded-2xl border border-violet-200 bg-white/80 p-3 dark:border-violet-400/20 dark:bg-stone-950/70">
                    <label className="block text-xs font-medium text-stone-600 dark:text-stone-300">
                      扩图比例
                      <select
                        value={canvasRatio}
                        onChange={(event) =>
                          setCanvasRatio(event.target.value as CanvasRatio)
                        }
                        className="mt-1 min-h-11 w-full rounded-xl border border-stone-200 bg-white px-3 text-sm dark:border-white/10 dark:bg-stone-950"
                      >
                        <option value="1:1">1:1 方图</option>
                        <option value="4:3">4:3 横图</option>
                        <option value="3:4">3:4 竖图</option>
                        <option value="16:9">16:9 宽屏</option>
                        <option value="9:16">9:16 竖屏</option>
                      </select>
                    </label>
                    <div>
                      <span className="text-xs font-medium text-stone-600 dark:text-stone-300">
                        原图停靠方向
                      </span>
                      <div className="mt-2 grid grid-cols-4 gap-2">
                        {(
                          [
                            ["left", ArrowLeft, "向左补全"],
                            ["right", ArrowRight, "向右补全"],
                            ["top", ArrowUp, "向上补全"],
                            ["bottom", ArrowDown, "向下补全"],
                          ] as const
                        ).map(([direction, Icon, label]) => (
                          <button
                            key={direction}
                            type="button"
                            title={label}
                            aria-pressed={outpaintDirections.includes(
                              direction,
                            )}
                            onClick={() => toggleOutpaintDirection(direction)}
                            className={cn(
                              "grid min-h-11 place-items-center rounded-xl border transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500",
                              outpaintDirections.includes(direction)
                                ? "border-violet-500 bg-violet-100 text-violet-700 dark:bg-violet-400/15 dark:text-violet-200"
                                : "border-stone-200 text-stone-500 hover:border-violet-300 dark:border-white/10",
                            )}
                          >
                            <Icon className="size-4" />
                            <span className="sr-only">{label}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11 w-full rounded-xl border-violet-200"
                      onClick={() => void prepareOutpaintCanvas()}
                    >
                      <Expand className="size-4" /> 准备扩图画布
                    </Button>
                    <p className="text-[11px] leading-5 text-stone-500">
                      新增透明区域会自动成为蒙版；仍可使用画笔和擦除工具微调。
                    </p>
                  </div>
                ) : null}
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
                  <label className="block text-xs font-medium text-stone-600 dark:text-stone-300">
                    一致性档案（可选）
                    <select
                      value={profileId}
                      onChange={(event) => {
                        const nextId = event.target.value;
                        setProfileId(nextId);
                        const profile = profiles.find(
                          (item) => item.id === nextId,
                        );
                        if (profile)
                          setProfileStrength(profile.default_strength);
                      }}
                      className="mt-1 min-h-11 w-full rounded-xl border border-violet-200 bg-white px-3 text-sm dark:border-violet-400/20 dark:bg-stone-950"
                    >
                      <option value="">不使用档案</option>
                      {profiles.map((profile) => (
                        <option key={profile.id} value={profile.id}>
                          {profile.name} · {profile.profile_type}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block text-xs font-medium text-stone-600 dark:text-stone-300">
                    一致性强度
                    <select
                      value={profileStrength}
                      disabled={!profileId}
                      onChange={(event) =>
                        setProfileStrength(
                          event.target.value as ConsistencyStrength,
                        )
                      }
                      className="mt-1 min-h-11 w-full rounded-xl border border-violet-200 bg-white px-3 text-sm disabled:opacity-50 dark:border-violet-400/20 dark:bg-stone-950"
                    >
                      <option value="strict">严格</option>
                      <option value="balanced">均衡</option>
                      <option value="creative">创意</option>
                    </select>
                  </label>
                </div>
                <label className="block text-xs font-medium text-stone-600 dark:text-stone-300">
                  原图保留强度
                  <select
                    value={preserveStrength}
                    onChange={(event) =>
                      setPreserveStrength(
                        event.target.value as ConsistencyStrength,
                      )
                    }
                    className="mt-1 min-h-11 w-full rounded-xl border border-violet-200 bg-white px-3 text-sm dark:border-violet-400/20 dark:bg-stone-950"
                  >
                    <option value="strict">严格保留</option>
                    <option value="balanced">均衡</option>
                    <option value="creative">允许创意变化</option>
                  </select>
                </label>
                <label className="block text-xs font-medium text-stone-600 dark:text-stone-300">
                  具体要求
                  <textarea
                    value={instruction}
                    onChange={(event) => setInstruction(event.target.value)}
                    placeholder="例如：换成深蓝色西装，保持人物脸部不变"
                    className="mt-1 min-h-24 w-full resize-y rounded-xl border border-violet-200 bg-white px-3 py-2 text-sm leading-6 outline-none focus:border-violet-500 dark:border-violet-400/20 dark:bg-stone-950"
                  />
                </label>
                <Button
                  disabled={isSubmitting || !hasMask}
                  onClick={() => void submitAiEdit()}
                  className="min-h-12 w-full rounded-xl bg-violet-700 text-white hover:bg-violet-800"
                >
                  {isSubmitting ? (
                    <LoaderCircle className="size-4 animate-spin" />
                  ) : (
                    <Send className="size-4" />
                  )}
                  {task?.status === "paused"
                    ? "任务已暂停"
                    : isSubmitting
                      ? "正在处理…"
                      : operation === "outpaint"
                        ? "提交智能扩图"
                        : "提交局部编辑"}
                </Button>
                {task ? (
                  <p className="text-center text-xs text-violet-700 dark:text-violet-200">
                    {task.status === "queued"
                      ? `排队第 ${task.queue_position || "-"} 位`
                      : task.progress || task.status}
                  </p>
                ) : null}
              </div>
            </section>

            <section className="grid grid-cols-2 gap-2 rounded-3xl border border-stone-200 bg-white p-4 dark:border-white/10 dark:bg-stone-900">
              <Button
                variant="outline"
                className="min-h-11 rounded-xl"
                onClick={async () => {
                  if (!asset || !selectedVersion) return;
                  const share = await createAssetShare(
                    asset.id,
                    selectedVersion.id,
                  );
                  await navigator.clipboard.writeText(
                    `${window.location.origin}/share/?token=${encodeURIComponent(share.token)}`,
                  );
                  toast.success("只读分享链接已复制");
                }}
              >
                <Share2 className="size-4" /> 分享
              </Button>
              <Button
                variant="outline"
                className="min-h-11 rounded-xl"
                onClick={async () => {
                  if (!asset || !selectedVersion) return;
                  await submitAssetReview(asset.id, selectedVersion.id);
                  toast.success("已提交管理员审核");
                }}
              >
                <Check className="size-4" /> 提交审核
              </Button>
            </section>
          </aside>
        </div>

        {resultSrc && initialSrc ? (
          <section className="rounded-3xl border border-stone-200 bg-white p-4 shadow-sm sm:p-6 dark:border-white/10 dark:bg-stone-900">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-xs font-semibold tracking-[.16em] text-violet-700 uppercase">
                  Before / After
                </p>
                <h2 className="text-xl font-bold">编辑前后对比</h2>
              </div>
              <Button variant="outline" className="min-h-11 rounded-xl" asChild>
                <a href={resultSrc} download>
                  <Download className="size-4" /> 下载结果
                </a>
              </Button>
            </div>
            <ImageComparisonSlider
              originalSrc={initialSrc}
              restoredSrc={resultSrc}
              className="rounded-2xl"
            />
          </section>
        ) : null}
      </div>
    </main>
  );
}

export default function CanvasPage() {
  return (
    <Suspense
      fallback={
        <main className="grid min-h-dvh place-items-center">
          <LoaderCircle className="size-7 animate-spin text-violet-700" />
        </main>
      }
    >
      <CanvasEditor />
    </Suspense>
  );
}
