import { defineConfig } from "@playwright/test";

const headedChromeWebGpu = process.env.WEBVIDEO_PLAYWRIGHT_CHROME_WEBGPU === "1";
const externalWebServer = process.env.WEBVIDEO_PLAYWRIGHT_EXTERNAL_SERVER === "1";
const chromeExecutablePath = process.env.CHROME_WEBGPU_EXECUTABLE ?? "/usr/bin/google-chrome-stable";
const webGpuArgs = [
  "--enable-unsafe-webgpu",
  "--ignore-gpu-blocklist",
  "--enable-features=Vulkan,VulkanFromANGLE,DefaultANGLEVulkan",
];

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  workers: 1,
  ...(externalWebServer
    ? {}
    : {
      webServer: {
        command: "cd .. && START_RTSP=1 WEBVIDEO_SAMPLE_FOOTAGE=1 ./start.sh",
        url: "http://127.0.0.1:4173/live-demo.html?channel=channel-001",
        reuseExistingServer: false,
        timeout: 120_000,
      },
    }),
  use: {
    baseURL: "http://127.0.0.1:4173",
    headless: !headedChromeWebGpu,
    ignoreHTTPSErrors: true,
    launchOptions: {
      executablePath: headedChromeWebGpu ? chromeExecutablePath : undefined,
      args: [
        "--enable-quic",
        ...webGpuArgs,
        "--ignore-certificate-errors",
        "--origin-to-force-quic-on=127.0.0.1:9443",
      ],
    },
  },
});
