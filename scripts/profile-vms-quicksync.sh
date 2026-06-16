#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export DRI_PRIME="${DRI_PRIME:-0}"
export LIBVA_DRIVER_NAME="${LIBVA_DRIVER_NAME:-iHD}"
export VK_ICD_FILENAMES="${VK_ICD_FILENAMES:-/usr/share/vulkan/icd.d/intel_icd.json}"
export VK_DRIVER_FILES="${VK_DRIVER_FILES:-$VK_ICD_FILENAMES}"

export WEBVIDEO_PLAYWRIGHT_CHROME_WEBGPU="${WEBVIDEO_PLAYWRIGHT_CHROME_WEBGPU:-1}"
export WEBVIDEO_REQUIRE_HARDWARE_WEBGPU="${WEBVIDEO_REQUIRE_HARDWARE_WEBGPU:-1}"
export WEBVIDEO_CHROME_WEBGPU_PRESET="${WEBVIDEO_CHROME_WEBGPU_PRESET:-strict-vulkan}"
export CHROME_WEBGPU_EXECUTABLE="${CHROME_WEBGPU_EXECUTABLE:-/usr/bin/google-chrome-stable}"

exec "$ROOT_DIR/scripts/profile-vms.sh"
