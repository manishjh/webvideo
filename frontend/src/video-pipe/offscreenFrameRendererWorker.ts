import type {
  DecodedFramePlan,
  TimedMetadataBatch,
  TimedMetadataRecord,
} from "../contracts/models";

type WorkerVideoFrameLike = {
  readonly codedWidth?: number;
  readonly codedHeight?: number;
  readonly displayWidth?: number;
  readonly displayHeight?: number;
  close?: () => void;
};

type GpuLike = {
  getPreferredCanvasFormat?: () => string;
  requestAdapter: (options?: Record<string, unknown>) => Promise<GpuAdapterLike | null>;
};

type GpuAdapterLike = {
  info?: {
    vendor?: string;
    architecture?: string;
    description?: string;
  };
  requestDevice: () => Promise<GpuDeviceLike>;
};

type GpuDeviceLike = {
  createShaderModule: (descriptor: Record<string, unknown>) => unknown;
  createRenderPipeline: (descriptor: Record<string, unknown>) => GpuPipelineLike;
  createSampler: (descriptor?: Record<string, unknown>) => unknown;
  createBindGroup: (descriptor: Record<string, unknown>) => unknown;
  createBuffer: (descriptor: Record<string, unknown>) => GpuBufferLike;
  createCommandEncoder: () => GpuCommandEncoderLike;
  importExternalTexture?: (descriptor: Record<string, unknown>) => unknown;
  queue: {
    writeBuffer: (buffer: unknown, offset: number, data: BufferSource) => void;
    submit: (commands: unknown[]) => void;
  };
};

type GpuPipelineLike = {
  getBindGroupLayout?: (index: number) => unknown;
};

type GpuCommandEncoderLike = {
  beginRenderPass: (descriptor: Record<string, unknown>) => GpuRenderPassEncoderLike;
  finish: () => unknown;
};

type GpuRenderPassEncoderLike = {
  setPipeline: (pipeline: unknown) => void;
  setBindGroup: (index: number, bindGroup: unknown) => void;
  draw: (vertexCount: number) => void;
  end: () => void;
};

type GpuCanvasContextLike = {
  configure: (configuration: Record<string, unknown>) => void;
  getCurrentTexture: () => {
    createView: () => unknown;
  };
};

type GpuBufferLike = {
  destroy?: () => void;
};

type RenderResult = {
  renderMs: number;
  importExternalTextureMs: number;
  bindGroupMs: number;
  uniformMs: number;
  encodeMs: number;
  submitMs: number;
  renderBackend: "webgpu" | "canvas2d-fallback";
  gpuPresentation?: string;
  gpuUploadSource?: string;
  gpuAdapterVendor?: string;
  gpuAdapterArchitecture?: string;
};

type RendererRequest =
  | {
    type: "configure";
    id: number;
    target: {
      canvas: OffscreenCanvas;
      canvasWidth: number;
      canvasHeight: number;
    };
  }
  | {
    type: "render";
    id: number;
    frame: DecodedFramePlan;
    activeMetadata: TimedMetadataBatch[];
  }
  | { type: "stop"; id?: number };

type RendererResponse =
  | { type: "configured"; id: number }
  | { type: "rendered"; id: number; result: RenderResult }
  | { type: "error"; id?: number; message: string };

const OverlayTextMaxChars = 32;
const OverlayUniformFloatCount = 8 + OverlayTextMaxChars;
const OverlayUniformByteLength = OverlayUniformFloatCount * Float32Array.BYTES_PER_ELEMENT;

const offscreenExternalVideoShader = `
struct Overlay {
  rect: vec4f,
  info: vec4f,
  chars0: vec4f,
  chars1: vec4f,
  chars2: vec4f,
  chars3: vec4f,
  chars4: vec4f,
  chars5: vec4f,
  chars6: vec4f,
  chars7: vec4f,
};

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOut {
  var positions = array<vec2f, 6>(
    vec2f(-1.0, -1.0),
    vec2f(1.0, -1.0),
    vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0),
    vec2f(1.0, -1.0),
    vec2f(1.0, 1.0)
  );
  var uvs = array<vec2f, 6>(
    vec2f(0.0, 1.0),
    vec2f(1.0, 1.0),
    vec2f(0.0, 0.0),
    vec2f(0.0, 0.0),
    vec2f(1.0, 1.0),
    vec2f(1.0, 0.0)
  );

  var output: VertexOut;
  output.position = vec4f(positions[vertexIndex], 0.0, 1.0);
  output.uv = uvs[vertexIndex];
  return output;
}

@group(0) @binding(0) var videoTexture: texture_external;
@group(0) @binding(1) var linearSampler: sampler;
@group(0) @binding(2) var<uniform> overlay: Overlay;

fn inRect(uv: vec2f, rect: vec4f) -> bool {
  return uv.x >= rect.x && uv.x <= rect.x + rect.z && uv.y >= rect.y && uv.y <= rect.y + rect.w;
}

fn borderAlpha(uv: vec2f, rect: vec4f) -> f32 {
  let thickness = 0.004;
  let inside = inRect(uv, rect);
  let nearLeft = abs(uv.x - rect.x) < thickness;
  let nearRight = abs(uv.x - (rect.x + rect.z)) < thickness;
  let nearTop = abs(uv.y - rect.y) < thickness;
  let nearBottom = abs(uv.y - (rect.y + rect.w)) < thickness;
  if (inside && (nearLeft || nearRight || nearTop || nearBottom)) {
    return 1.0;
  }
  return 0.0;
}

fn readChar(index: u32) -> u32 {
  let group = index / 4u;
  let lane = index % 4u;
  var value = 0.0;
  if (group == 0u) {
    value = overlay.chars0[lane];
  } else if (group == 1u) {
    value = overlay.chars1[lane];
  } else if (group == 2u) {
    value = overlay.chars2[lane];
  } else if (group == 3u) {
    value = overlay.chars3[lane];
  } else if (group == 4u) {
    value = overlay.chars4[lane];
  } else if (group == 5u) {
    value = overlay.chars5[lane];
  } else if (group == 6u) {
    value = overlay.chars6[lane];
  } else {
    value = overlay.chars7[lane];
  }
  return u32(value + 0.5);
}

fn glyphBit(charCode: u32, x: u32, y: u32) -> bool {
  if (x >= 3u || y >= 5u) {
    return false;
  }
  let digit = select(10u, charCode - 48u, charCode >= 48u && charCode <= 57u);
  var mask = 0u;
  if (digit == 0u) {
    mask = 31599u;
  } else if (digit == 1u) {
    mask = 9362u;
  } else if (digit == 2u) {
    mask = 29671u;
  } else if (digit == 3u) {
    mask = 29391u;
  } else if (digit == 4u) {
    mask = 23497u;
  } else if (digit == 5u) {
    mask = 31183u;
  } else if (digit == 6u) {
    mask = 31215u;
  } else if (digit == 7u) {
    mask = 29257u;
  } else if (digit == 8u) {
    mask = 31727u;
  } else if (digit == 9u) {
    mask = 31695u;
  } else if (charCode == 79u) {
    mask = 31599u;
  } else if (charCode == 83u) {
    mask = 31183u;
  } else if (charCode == 68u) {
    mask = 15211u;
  } else if (charCode == 84u) {
    mask = 29842u;
  } else if (charCode == 88u) {
    mask = 23213u;
  } else if (charCode == 32u) {
    mask = 0u;
  } else if (charCode == 45u) {
    mask = 448u;
  } else {
    mask = 31727u;
  }
  let bitIndex = y * 3u + x;
  return (mask & (1u << bitIndex)) != 0u;
}

fn textAlpha(uv: vec2f) -> f32 {
  let origin = overlay.rect.xy + vec2f(0.01, 0.012);
  let charSize = vec2f(0.006, 0.012);
  let rel = uv - origin;
  if (rel.x < 0.0 || rel.y < 0.0) {
    return 0.0;
  }
  let cell = vec2f(charSize.x * 4.0, charSize.y * 6.0);
  let charIndex = u32(floor(rel.x / cell.x));
  let textLength = min(u32(overlay.info.y + 0.5), 32u);
  if (charIndex >= textLength) {
    return 0.0;
  }
  let local = rel - vec2f(f32(charIndex) * cell.x, 0.0);
  let glyphX = u32(floor(local.x / charSize.x));
  let glyphY = u32(floor(local.y / charSize.y));
  if (glyphBit(readChar(charIndex), glyphX, glyphY)) {
    return 1.0;
  }
  return 0.0;
}

fn drawOsd(uv: vec2f, sampledColor: vec4f) -> vec4f {
  if (overlay.info.x < 0.5) {
    return sampledColor;
  }
  let rect = overlay.rect;
  var color = sampledColor;
  let fill = select(0.0, 0.22, inRect(uv, rect));
  color = mix(color, vec4f(0.0, 0.0, 0.0, 1.0), fill);
  let border = borderAlpha(uv, rect);
  color = mix(color, vec4f(1.0, 0.05, 0.35, 1.0), border);
  let glyph = textAlpha(uv);
  color = mix(color, vec4f(1.0, 1.0, 1.0, 1.0), glyph);
  return color;
}

@fragment
fn fragmentMain(input: VertexOut) -> @location(0) vec4f {
  let color = textureSampleBaseClampToEdge(videoTexture, linearSampler, input.uv);
  return drawOsd(input.uv, vec4f(color.rgb, 1.0));
}
`;

class OffscreenWebGpuVideoRenderer {
  private constructor(
    private readonly canvas: OffscreenCanvas,
    private readonly context: GpuCanvasContextLike,
    private readonly device: GpuDeviceLike,
    private readonly pipeline: GpuPipelineLike,
    private readonly sampler: unknown,
    private readonly overlayBuffer: GpuBufferLike,
    private readonly overlayUniform: Float32Array<ArrayBuffer>,
    private readonly adapterInfo?: GpuAdapterLike["info"],
  ) {}

  public static async create(target: Extract<RendererRequest, { type: "configure" }>["target"]): Promise<OffscreenWebGpuVideoRenderer> {
    const gpu = (globalThis.navigator as { gpu?: GpuLike } | undefined)?.gpu;
    if (!gpu) {
      throw new Error("split-offscreen-webgpu-unavailable");
    }

    const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) {
      throw new Error("split-offscreen-webgpu-no-adapter");
    }

    const adapterInfo = adapter.info;
    const vendor = adapterInfo?.vendor?.toLowerCase() ?? "";
    const architecture = adapterInfo?.architecture?.toLowerCase() ?? "";
    const description = adapterInfo?.description?.toLowerCase() ?? "";
    if (vendor === "google" || architecture === "swiftshader" || description.includes("swiftshader")) {
      throw new Error("split-offscreen-webgpu-software-adapter");
    }

    const device = await adapter.requestDevice();
    if (typeof device.importExternalTexture !== "function") {
      throw new Error("split-offscreen-webgpu-external-texture-unavailable");
    }

    target.canvas.width = Math.max(1, Math.floor(target.canvasWidth));
    target.canvas.height = Math.max(1, Math.floor(target.canvasHeight));
    const context = target.canvas.getContext("webgpu") as GpuCanvasContextLike | null;
    if (!context) {
      throw new Error("split-offscreen-webgpu-context-unavailable");
    }

    const format = gpu.getPreferredCanvasFormat?.() ?? "bgra8unorm";
    context.configure({
      device,
      format,
      alphaMode: "opaque",
    });
    const shaderModule = device.createShaderModule({ code: offscreenExternalVideoShader });
    const pipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: shaderModule,
        entryPoint: "vertexMain",
      },
      fragment: {
        module: shaderModule,
        entryPoint: "fragmentMain",
        targets: [{ format }],
      },
      primitive: {
        topology: "triangle-list",
      },
    });
    const sampler = device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
    });
    const overlayBuffer = device.createBuffer({
      size: OverlayUniformByteLength,
      usage: getGpuBufferUsage().uniform | getGpuBufferUsage().copyDst,
    });

    return new OffscreenWebGpuVideoRenderer(
      target.canvas,
      context,
      device,
      pipeline,
      sampler,
      overlayBuffer,
      new Float32Array(new ArrayBuffer(OverlayUniformByteLength)),
      adapterInfo,
    );
  }

  public render(frame: DecodedFramePlan, activeMetadata: readonly TimedMetadataBatch[]): RenderResult {
    const videoFrame = frame.videoFrame as WorkerVideoFrameLike | undefined;
    if (!videoFrame || !isNativeVideoFrame(videoFrame)) {
      throw new Error("split-offscreen-render-requires-videoframe");
    }

    const renderStart = performance.now();
    const externalTexture = this.device.importExternalTexture?.({ source: videoFrame });
    if (!externalTexture) {
      throw new Error("split-offscreen-import-external-texture-failed");
    }
    const importEnd = performance.now();

    const bindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout?.(0),
      entries: [
        {
          binding: 0,
          resource: externalTexture,
        },
        {
          binding: 1,
          resource: this.sampler,
        },
        {
          binding: 2,
          resource: {
            buffer: this.overlayBuffer,
          },
        },
      ],
    });
    const bindEnd = performance.now();
    writeOverlayUniform(activeMetadata, this.overlayUniform);
    this.device.queue.writeBuffer(this.overlayBuffer, 0, this.overlayUniform);
    const uniformEnd = performance.now();
    const commandEncoder = this.device.createCommandEncoder();
    const pass = commandEncoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.context.getCurrentTexture().createView(),
          clearValue: { r: 0.02, g: 0.03, b: 0.04, a: 1 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(6);
    pass.end();
    const commandBuffer = commandEncoder.finish();
    const encodeEnd = performance.now();
    this.device.queue.submit([commandBuffer]);
    const submitEnd = performance.now();
    videoFrame.close?.();

    return {
      renderMs: submitEnd - renderStart,
      importExternalTextureMs: importEnd - renderStart,
      bindGroupMs: bindEnd - importEnd,
      uniformMs: uniformEnd - bindEnd,
      encodeMs: encodeEnd - uniformEnd,
      submitMs: submitEnd - encodeEnd,
      renderBackend: "webgpu",
      gpuPresentation: "worker-offscreen-webgpu-canvas",
      gpuUploadSource: "external-texture",
      gpuAdapterVendor: this.adapterInfo?.vendor,
      gpuAdapterArchitecture: this.adapterInfo?.architecture,
    };
  }

  public dispose(): void {
    this.overlayBuffer.destroy?.();
    this.canvas.width = this.canvas.width;
  }
}

let renderer: OffscreenWebGpuVideoRenderer | undefined;

function post(response: RendererResponse): void {
  (globalThis as unknown as Worker).postMessage(response);
}

function isNativeVideoFrame(candidate: unknown): boolean {
  const videoFrameConstructor = (globalThis as { VideoFrame?: unknown }).VideoFrame;
  return typeof videoFrameConstructor === "function" && candidate instanceof videoFrameConstructor;
}

function writeOverlayUniform(activeMetadata: readonly TimedMetadataBatch[], target: Float32Array<ArrayBuffer>): void {
  target.fill(0);
  let record: TimedMetadataRecord | undefined;
  for (const batch of activeMetadata) {
    record = batch.records[0];
    if (record) {
      break;
    }
  }

  if (!record) {
    target[0] = -1;
    target[1] = -1;
    target[2] = 0;
    target[3] = 0;
    target[4] = 0;
    return;
  }

  target[0] = parseNormalizedCoordinate(record.tags.x, 0.08);
  target[1] = parseNormalizedCoordinate(record.tags.y, 0.12);
  target[2] = parseNormalizedCoordinate(record.tags.w, 0.18);
  target[3] = parseNormalizedCoordinate(record.tags.h, 0.14);
  const text = formatOverlayText(record);
  target[4] = 1;
  target[5] = text.length;
  for (let index = 0; index < text.length && index < OverlayTextMaxChars; index += 1) {
    target[8 + index] = text.charCodeAt(index);
  }
}

function formatOverlayText(record: TimedMetadataRecord): string {
  const resolution = record.tags.resolution ?? record.tags.sourceResolution ?? "";
  const timestamp = record.tags.ptsMs
    ?? record.tags.presentationTimestampMs
    ?? (record.startTimestampUs > 0 ? String(Math.floor(record.startTimestampUs / 1000)) : "");
  const normalizedResolution = resolution.replace(/[^\dXx]/g, "").toUpperCase();
  const normalizedTimestamp = timestamp.replace(/[^\d-]/g, "");
  return `OSD ${normalizedResolution || "0000X0000"} T${normalizedTimestamp || "0"}`
    .toUpperCase()
    .replace(/[^0-9A-Z -]/g, " ")
    .slice(0, OverlayTextMaxChars);
}

function parseNormalizedCoordinate(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  if (parsed > 1) {
    return Math.max(0, Math.min(1, parsed / 100));
  }

  return Math.max(0, Math.min(1, parsed));
}

function getGpuBufferUsage(): { uniform: number; copyDst: number } {
  const usage = (globalThis as {
    GPUBufferUsage?: {
      UNIFORM?: number;
      COPY_DST?: number;
    };
  }).GPUBufferUsage;
  return {
    uniform: usage?.UNIFORM ?? 0x0040,
    copyDst: usage?.COPY_DST ?? 0x0008,
  };
}

(globalThis as unknown as Worker).onmessage = (event: MessageEvent<RendererRequest>) => {
  const request = event.data;
  if (request.type === "stop") {
    renderer?.dispose();
    renderer = undefined;
    return;
  }

  if (request.type === "configure") {
    void OffscreenWebGpuVideoRenderer.create(request.target).then((createdRenderer) => {
      renderer = createdRenderer;
      post({ type: "configured", id: request.id });
    }).catch((error: unknown) => {
      post({
        type: "error",
        id: request.id,
        message: error instanceof Error ? error.message : String(error),
      });
    });
    return;
  }

  try {
    if (!renderer) {
      throw new Error("split-offscreen-renderer-not-configured");
    }

    const result = renderer.render(request.frame, request.activeMetadata);
    post({ type: "rendered", id: request.id, result });
  } catch (error) {
    const frame = request.frame.videoFrame as WorkerVideoFrameLike | undefined;
    frame?.close?.();
    post({
      type: "error",
      id: request.id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
