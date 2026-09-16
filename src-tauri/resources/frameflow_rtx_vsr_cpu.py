"""FrameFlow RTX VSR bridge that keeps the completed video tensor in system RAM.

NVIDIA's stock node allocates the entire upscaled clip on CUDA. That makes a
long 3K/4K clip consume most VRAM before MiniMax H3 starts. This node runs the
same NVVFX model one frame at a time and copies each completed frame to CPU.
"""

import torch
import nvvfx


class FrameFlowRTXVideoSuperResolutionCPU:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "width": ("INT", {"default": 1920, "min": 64, "max": 8192, "step": 8}),
                "height": ("INT", {"default": 1080, "min": 64, "max": 8192, "step": 8}),
                "quality": (["LOW", "MEDIUM", "HIGH", "ULTRA"], {"default": "ULTRA"}),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("upscaled_images",)
    FUNCTION = "execute"
    CATEGORY = "FrameFlow/Upscale"
    DESCRIPTION = "RTX VSR frame processing with the completed clip stored in system RAM."

    @classmethod
    def execute(cls, images, width, height, quality):
        width = max(8, round(int(width) / 8) * 8)
        height = max(8, round(int(height) / 8) * 8)
        channels = int(images.shape[-1])
        output = torch.empty(
            (int(images.shape[0]), height, width, channels),
            device="cpu",
            dtype=images.dtype,
        )
        quality_map = {
            "LOW": nvvfx.effects.QualityLevel.LOW,
            "MEDIUM": nvvfx.effects.QualityLevel.MEDIUM,
            "HIGH": nvvfx.effects.QualityLevel.HIGH,
            "ULTRA": nvvfx.effects.QualityLevel.ULTRA,
        }
        selected = quality_map.get(quality, nvvfx.effects.QualityLevel.HIGH)
        with nvvfx.VideoSuperRes(selected) as sr:
            sr.output_width = width
            sr.output_height = height
            sr.load()
            for index in range(int(images.shape[0])):
                source = images[index].cuda().permute(2, 0, 1).float().contiguous()
                generated = torch.from_dlpack(sr.run(source).image).movedim(0, -1)
                output[index].copy_(generated.to(device="cpu", dtype=images.dtype))
                del source, generated
        return (output,)


NODE_CLASS_MAPPINGS = {
    "FrameFlowRTXVideoSuperResolutionCPU": FrameFlowRTXVideoSuperResolutionCPU,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "FrameFlowRTXVideoSuperResolutionCPU": "FrameFlow RTX VSR (RAM Output)",
}
