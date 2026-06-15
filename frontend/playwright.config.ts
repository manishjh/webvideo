import { defineConfig } from "@playwright/test";

const headedChromeWebGpu = process.env.WEBVIDEO_PLAYWRIGHT_CHROME_WEBGPU === "1";
const externalWebServer = process.env.WEBVIDEO_PLAYWRIGHT_EXTERNAL_SERVER === "1";
const chromeExecutablePath = process.env.CHROME_WEBGPU_EXECUTABLE ?? "/usr/bin/google-chrome-stable";
const frontendPort = process.env.FRONTEND_PORT ?? "4173";
const webTransportPort = process.env.WEBTRANSPORT_PORT ?? "9443";
const baseURL = `http://127.0.0.1:${frontendPort}`;
const traceMode: "off" | "on" | "retain-on-failure" = process.env.WEBVIDEO_DISABLE_TRACE === "1"
  ? "off"
  : process.env.WEBVIDEO_PROFILE_TRACE === "1"
    ? "on"
    : "retain-on-failure";
const webGpuPreset = process.env.WEBVIDEO_CHROME_WEBGPU_PRESET ?? "safe-vulkan";
const webGpuArgs = createWebGpuArgs(webGpuPreset);

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  workers: 1,
  reporter: [
    ["list"],
    ["json", { outputFile: "../.run/playwright-results.json" }],
    ["html", { outputFolder: "../.run/playwright-report", open: "never" }],
  ],
  ...(externalWebServer
    ? {}
    : {
      webServer: {
        command: "cd .. && START_RTSP=1 WEBVIDEO_SAMPLE_FOOTAGE=1 ./start.sh",
        url: `${baseURL}/live-demo.html?channel=channel-001`,
        reuseExistingServer: false,
        timeout: 120_000,
      },
    }),
  use: {
    baseURL,
    headless: !headedChromeWebGpu,
    ignoreHTTPSErrors: true,
    trace: traceMode,
    screenshot: "only-on-failure",
    video: process.env.WEBVIDEO_PROFILE_TRACE === "1" ? "retain-on-failure" : "off",
    launchOptions: {
      executablePath: headedChromeWebGpu ? chromeExecutablePath : undefined,
      ignoreDefaultArgs: headedChromeWebGpu ? ["--enable-unsafe-swiftshader"] : undefined,
      args: [
        "--enable-quic",
        ...webGpuArgs,
        "--ignore-certificate-errors",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--disable-features=CalculateNativeWinOcclusion",
        `--origin-to-force-quic-on=127.0.0.1:${webTransportPort}`,
      ],
    },
  },
});

function createWebGpuArgs(preset: string): string[] {
  const baseArgs = [
    "--enable-unsafe-webgpu",
    "--ignore-gpu-blocklist",
  ];

  switch (preset) {
    case "minimal":
      return baseArgs;
    case "strict-vulkan":
      return [
        ...baseArgs,
        "--enable-features=Vulkan,VulkanFromANGLE,DefaultANGLEVulkan",
      ];
    case "safe-vulkan":
    default:
      return [
        ...baseArgs,
        "--enable-features=Vulkan,VulkanFromANGLE",
      ];
  }
}
